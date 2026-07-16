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

    // The child opens the slave itself as fd 0 (dup'd to 1/2). Combined with
    // SETSID below, the first tty a session leader opens becomes its controlling
    // terminal, which is what turns on job control and makes Ctrl-C work.
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

    const argv = cArr([opts.executable, ...opts.args]);
    const envp = cArr(Object.entries(opts.env).map(([k, v]) => `${k}=${v}`));

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

    // pollfd { int fd; short events; short revents; } -> 8 bytes
    const pollfd = new ArrayBuffer(8);
    new Int32Array(pollfd, 0, 1)[0] = masterFD;
    new Int16Array(pollfd, 4, 1)[0] = POLLIN;
    this.pollBuf = new Uint8Array(pollfd);
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

  interrupt(): void {
    s.killpg(this.pid, SIGINT);
  }

  terminate(): void {
    if (!this.closed) s.killpg(this.pid, SIGTERM);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    s.killpg(this.pid, SIGKILL);
    s.close(this.masterFD);
  }
}
