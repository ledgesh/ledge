// A child shell attached to a pseudo-terminal, driven entirely from Bun via
// bun:ffi. A port of Sources/SessionKit/PTYProcess.swift.
//
// Why FFI and not node-pty: node-pty's native read stream never delivers data
// under Bun. Why posix_spawn and not fork(): forking from Bun's multithreaded
// runtime segfaults, but posix_spawn's fork+exec happens inside libc and is
// safe. Why poll() instead of setting O_NONBLOCK: fcntl/ioctl are variadic and
// mis-marshal under bun:ffi on arm64, so we never change the fd's flags and
// instead gate every read on poll() with a zero timeout.
import { dlopen, ptr, CString, cc } from "bun:ffi";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const libc = dlopen("libSystem.B.dylib", {
  openpty: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  ttyname: { args: ["i32"], returns: "ptr" },
  close: { args: ["i32"], returns: "i32" },
  read: { args: ["i32", "ptr", "u64"], returns: "i64" },
  write: { args: ["i32", "ptr", "u64"], returns: "i64" },
  poll: { args: ["ptr", "u64", "i32"], returns: "i32" },
  killpg: { args: ["i32", "i32"], returns: "i32" },
  tcgetpgrp: { args: ["i32"], returns: "i32" },
  posix_spawn_file_actions_init: { args: ["ptr"], returns: "i32" },
  posix_spawn_file_actions_addopen: { args: ["ptr", "i32", "ptr", "i32", "u32"], returns: "i32" },
  posix_spawn_file_actions_adddup2: { args: ["ptr", "i32", "i32"], returns: "i32" },
  posix_spawn_file_actions_addclose: { args: ["ptr", "i32"], returns: "i32" },
  posix_spawn_file_actions_addchdir_np: { args: ["ptr", "ptr"], returns: "i32" },
  posix_spawnattr_init: { args: ["ptr"], returns: "i32" },
  posix_spawnattr_setflags: { args: ["ptr", "i16"], returns: "i32" },
  posix_spawn: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
});
const s = libc.symbols;

const O_RDWR = 0x0002;
const POSIX_SPAWN_SETSID = 0x0400;
const POLLIN = 0x0001;
const SIGINT = 2;
const SIGTERM = 15;
const SIGKILL = 9;

// Resizing a live pty means ioctl(fd, TIOCSWINSZ, &winsize), but ioctl is
// variadic and bun:ffi mis-marshals variadic calls on arm64 (see the header
// comment). So we compile a fixed-arity C trampoline with Bun's bundled TinyCC
// (bun:ffi `cc`) and call that instead. The source is written to a temp file at
// runtime rather than shipped as a .c, so it works the same in dev and in the
// bundled app. ioctl(TIOCSWINSZ) also raises SIGWINCH on the child, so zsh and
// any running program re-read the new size.
const WINSIZE_C = `#include <sys/ioctl.h>
#include <termios.h>
int ledge_set_winsize(int fd, unsigned short cols, unsigned short rows) {
  struct winsize ws;
  ws.ws_row = rows;
  ws.ws_col = cols;
  ws.ws_xpixel = 0;
  ws.ws_ypixel = 0;
  return ioctl(fd, TIOCSWINSZ, &ws);
}
`;

// Spawning the shell so that Ctrl-C works.
//
// A tty only turns ^C into SIGINT for its foreground process group, and it only
// has one if some process has claimed it as its CONTROLLING terminal. On macOS
// that claim is an explicit ioctl(TIOCSCTTY) - the "first tty a session leader
// opens becomes its ctty" rule is System V/Linux, not BSD - and posix_spawn has no
// file action for an ioctl. So POSIX_SPAWN_SETSID gave us a session leader with no
// controlling terminal: `stty` reported isig on, and ^C still did nothing, because
// the line discipline had nobody to signal.
//
// login_tty() is exactly that missing step (setsid + TIOCSCTTY + dup onto 0/1/2),
// but it has to run in the child, between fork and exec. Hence this trampoline.
// The header's warning about fork() under Bun holds for forking into JS; here the
// child touches nothing but syscalls before execve replaces the image, which is
// the same contract posix_spawn keeps inside libc.
const SPAWN_C = `#include <util.h>
#include <unistd.h>
int ledge_spawn_tty(int slave_fd, int master_fd, const char *cwd,
                    const char *path, char *const argv[], char *const envp[]) {
  pid_t pid = fork();
  if (pid != 0) return (int)pid;
  close(master_fd);
  if (login_tty(slave_fd) < 0) _exit(126);
  if (cwd && cwd[0] && chdir(cwd) != 0) _exit(125);
  execve(path, argv, envp);
  _exit(127);
  return 0;
}
`;

type SpawnFn = (
  slaveFD: number,
  masterFD: number,
  cwd: ReturnType<typeof ptr>,
  path: ReturnType<typeof ptr>,
  argv: ReturnType<typeof ptr>,
  envp: ReturnType<typeof ptr>,
) => number;

// Same lazy-compile-and-cache deal as the resize trampoline. null means we fall
// back to posix_spawn below: the shell still runs, but with no controlling
// terminal, so ^C is inert. Losing Ctrl-C beats losing the terminal entirely.
let spawnTty: SpawnFn | null | undefined;
function spawnFn(): SpawnFn | null {
  if (spawnTty !== undefined) return spawnTty;
  try {
    const src = join(tmpdir(), "ledge-spawntty.c");
    writeFileSync(src, SPAWN_C);
    const { symbols } = cc({
      source: src,
      symbols: {
        ledge_spawn_tty: { args: ["int", "int", "ptr", "ptr", "ptr", "ptr"], returns: "int" },
      },
    });
    spawnTty = (slaveFD, masterFD, cwd, path, argv, envp) =>
      symbols.ledge_spawn_tty(slaveFD, masterFD, cwd, path, argv, envp) as number;
  } catch (err) {
    console.warn("[pty] login_tty spawn unavailable, Ctrl-C will not work:", (err as Error).message);
    spawnTty = null;
  }
  return spawnTty;
}

// Compiled lazily and cached: null means the trampoline could not be built (very
// old Bun, no TinyCC), in which case resize is a silent no-op.
let setWinsize: ((fd: number, cols: number, rows: number) => number) | null | undefined;
function winsizeFn(): ((fd: number, cols: number, rows: number) => number) | null {
  if (setWinsize !== undefined) return setWinsize;
  try {
    const src = join(tmpdir(), "ledge-winsize.c");
    writeFileSync(src, WINSIZE_C);
    const { symbols } = cc({
      source: src,
      symbols: { ledge_set_winsize: { args: ["int", "u16", "u16"], returns: "int" } },
    });
    setWinsize = (fd, cols, rows) => symbols.ledge_set_winsize(fd, cols, rows) as number;
  } catch (err) {
    console.warn("[pty] resize trampoline unavailable:", (err as Error).message);
    setWinsize = null;
  }
  return setWinsize;
}

// pollfd { int fd; short events; short revents; } -> 8 bytes
function pollBufFor(fd: number): Uint8Array {
  const pollfd = new ArrayBuffer(8);
  new Int32Array(pollfd, 0, 1)[0] = fd;
  new Int16Array(pollfd, 4, 1)[0] = POLLIN;
  return new Uint8Array(pollfd);
}

export interface PtyOptions {
  executable: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  columns?: number;
  rows?: number;
}

export class PtyProcess {
  readonly pid: number;
  readonly masterFD: number;
  private closed = false;
  private ended = false;
  private pollBuf: Uint8Array;
  private readBuf = new Uint8Array(65536);
  private readBufPtr: ReturnType<typeof ptr>;

  constructor(opts: PtyOptions) {
    // Keep C buffers alive for the duration of the spawn call.
    const keep: Uint8Array[] = [];
    const cstr = (str: string): Uint8Array => {
      const enc = new TextEncoder().encode(str);
      const b = new Uint8Array(enc.length + 1);
      b.set(enc);
      keep.push(b);
      return b;
    };
    const cArr = (items: string[]): BigUint64Array => {
      const a = new BigUint64Array(items.length + 1);
      items.forEach((it, i) => (a[i] = BigInt(ptr(cstr(it)))));
      a[items.length] = 0n;
      keep.push(new Uint8Array(a.buffer));
      return a;
    };

    const master = new Int32Array(1);
    const slave = new Int32Array(1);
    // winsize { ushort row; ushort col; ushort xpixel; ushort ypixel; }
    const winp = new Uint16Array([opts.rows ?? 30, opts.columns ?? 120, 0, 0]);
    if (s.openpty(ptr(master), ptr(slave), null, null, ptr(winp)) !== 0) {
      throw new Error("openpty failed");
    }
    const masterFD = master[0];
    const slaveFD = slave[0];
    const namePtr = s.ttyname(slaveFD);
    if (!namePtr) throw new Error("ttyname failed");
    const slavePath = new CString(namePtr).toString();

    const argv = cArr([opts.executable, ...opts.args]);
    const envp = cArr(Object.entries(opts.env).map(([k, v]) => `${k}=${v}`));

    const spawn = spawnFn();
    if (spawn) {
      const pid = spawn(
        slaveFD,
        masterFD,
        ptr(cstr(opts.cwd ?? "")),
        ptr(cstr(opts.executable)),
        ptr(argv),
        ptr(envp),
      );
      if (pid < 0) {
        s.close(masterFD);
        s.close(slaveFD);
        throw new Error("fork failed");
      }
      s.close(slaveFD); // the parent has no use for the slave
      this.pid = pid;
      this.masterFD = masterFD;
      this.pollBuf = pollBufFor(masterFD);
      this.readBufPtr = ptr(this.readBuf);
      return;
    }

    // Fallback: no controlling terminal, so no job control and no Ctrl-C. See
    // spawnFn above for why this is the lesser evil rather than the design.
    const actions = new BigUint64Array(1);
    s.posix_spawn_file_actions_init(ptr(actions));
    s.posix_spawn_file_actions_addopen(ptr(actions), 0, ptr(cstr(slavePath)), O_RDWR, 0);
    s.posix_spawn_file_actions_adddup2(ptr(actions), 0, 1);
    s.posix_spawn_file_actions_adddup2(ptr(actions), 0, 2);
    s.posix_spawn_file_actions_addclose(ptr(actions), masterFD);
    if (opts.cwd) {
      // chdir in the child, not the parent (chdir is process-wide).
      s.posix_spawn_file_actions_addchdir_np(ptr(actions), ptr(cstr(opts.cwd)));
    }

    const attrs = new BigUint64Array(1);
    s.posix_spawnattr_init(ptr(attrs));
    s.posix_spawnattr_setflags(ptr(attrs), POSIX_SPAWN_SETSID);

    const pidBuf = new Int32Array(1);
    const rc = s.posix_spawn(
      ptr(pidBuf),
      ptr(cstr(opts.executable)),
      ptr(actions),
      ptr(attrs),
      ptr(argv),
      ptr(envp),
    );
    if (rc !== 0) {
      s.close(masterFD);
      s.close(slaveFD);
      throw new Error(`posix_spawn failed (rc ${rc})`);
    }
    s.close(slaveFD); // the parent has no use for the slave

    this.pid = pidBuf[0];
    this.masterFD = masterFD;
    this.pollBuf = pollBufFor(masterFD);
    this.readBufPtr = ptr(this.readBuf);
  }

  /**
   * True once the child has exited: `poll` reports the fd readable (a hangup)
   * but `read` returns 0 (EOF), which is how a shell quitting (e.g. the user
   * types `exit`) shows up on the master fd. Latches; cleared only by close.
   */
  get exited(): boolean {
    return this.ended;
  }

  /** Drain everything currently readable. Never blocks (poll gates the read). */
  drain(): Uint8Array | null {
    if (this.closed) return null;
    const chunks: Uint8Array[] = [];
    while (s.poll(ptr(this.pollBuf), 1n, 0) > 0) {
      const n = Number(s.read(this.masterFD, this.readBufPtr, BigInt(this.readBuf.length)));
      if (n > 0) chunks.push(this.readBuf.slice(0, n));
      else {
        // poll said readable but read yielded nothing: the child closed its end.
        if (n === 0) this.ended = true;
        break;
      }
    }
    if (chunks.length === 0) return null;
    if (chunks.length === 1) return chunks[0];
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  write(data: string | Uint8Array): void {
    if (this.closed) return;
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    s.write(this.masterFD, ptr(bytes), BigInt(bytes.length));
  }

  /** Tell the pty its new dimensions (raises SIGWINCH on the child). */
  resize(cols: number, rows: number): void {
    if (this.closed || cols <= 0 || rows <= 0) return;
    winsizeFn()?.(this.masterFD, cols, rows);
  }

  /**
   * The tty's foreground process group: the one a typed ^C would signal, or -1 if
   * the tty has none.
   *
   * This is NOT the shell's own group. A controlling terminal turns zsh's job
   * control on, and job control means every foreground job is put in a group of its
   * own; signalling the shell's group would reach the shell (which ignores SIGINT)
   * and miss the job entirely.
   */
  private fgPgrp(): number {
    if (this.closed) return -1;
    const pg = s.tcgetpgrp(this.masterFD);
    return pg > 0 ? pg : -1;
  }

  /** SIGINT whatever is running in the foreground, as ^C would. */
  interrupt(): void {
    const fg = this.fgPgrp();
    s.killpg(fg > 0 ? fg : this.pid, SIGINT);
  }

  terminate(): void {
    if (this.closed) return;
    const fg = this.fgPgrp();
    if (fg > 0 && fg !== this.pid) s.killpg(fg, SIGTERM);
    s.killpg(this.pid, SIGTERM);
  }

  close(): void {
    if (this.closed) return;
    // Read the foreground group before anything dies: killing the shell first would
    // leave us asking a tty whose owner is already gone.
    const fg = this.fgPgrp();
    this.closed = true;
    if (fg > 0 && fg !== this.pid) s.killpg(fg, SIGKILL);
    s.killpg(this.pid, SIGKILL);
    s.close(this.masterFD);
  }
}
