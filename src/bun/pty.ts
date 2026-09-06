// A child shell attached to a pseudo-terminal, driven entirely from Bun via
// bun:ffi. A port of Sources/SessionKit/PTYProcess.swift.
//
// Why FFI and not node-pty: node-pty's native read stream never delivers data
// under Bun. Why posix_spawn and not fork(): forking from Bun's multithreaded
// runtime segfaults, while posix_spawn's fork+exec happens inside libc and is
// safe. Why poll() on reads: it is cheaper than a syscall that answers EAGAIN,
// and it tells "nothing yet" apart from the hangup that means the child is
// gone. Writes cannot use poll, because a pty master reports writable and then
// the write blocks anyway. So the master fd is O_NONBLOCK and write() queues
// what the tty refuses. O_NONBLOCK goes through the ledge_set_nonblock
// trampoline: fcntl is variadic, and bun:ffi mis-marshals variadic calls on
// arm64.
import { dlopen, ptr, CString, cc } from "bun:ffi";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NATIVE_C, NATIVE_DIR, NATIVE_LIB, NATIVE_SYMBOLS, PLATFORM } from "./ptyNative";

// The first library that has all of `symbols`. Throws when every candidate
// fails: there is no PTY without a libc, and the alternative is a null check
// on every syscall in this file.
function openFirst<T extends Parameters<typeof dlopen>[1]>(names: readonly string[], symbols: T) {
  let last: unknown;
  for (const name of names) {
    try {
      return dlopen(name, symbols);
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`no libc among ${names.join(", ")}: ${(last as Error)?.message}`);
}

const libc = openFirst(PLATFORM.libc, {
  ttyname: { args: ["i32"], returns: "ptr" },
  close: { args: ["i32"], returns: "i32" },
  read: { args: ["i32", "ptr", "u64"], returns: "i64" },
  write: { args: ["i32", "ptr", "u64"], returns: "i64" },
  poll: { args: ["ptr", "u64", "i32"], returns: "i32" },
  killpg: { args: ["i32", "i32"], returns: "i32" },
  tcgetpgrp: { args: ["i32"], returns: "i32" },
  waitpid: { args: ["i32", "ptr", "i32"], returns: "i32" },
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

// openpty gets a handle of its own: on glibc it may live in libutil rather
// than libc (ptyNative.ts, PLATFORM), and dlopen resolves a table all at once.
const { openpty } = openFirst(PLATFORM.ptyLib, {
  openpty: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
}).symbols;

const O_RDWR = 0x0002;
const POSIX_SPAWN_SETSID = PLATFORM.POSIX_SPAWN_SETSID;
const POLLIN = 0x0001;
// Both kernels use the same value, so this one needs no PLATFORM entry, unlike
// POSIX_SPAWN_SETSID above (ptyNative.ts).
const POLLHUP = 0x0010;
const SIGINT = 2;
// ETX, the ^C character. A remote tty's line discipline turns it back into
// SIGINT at the far end of a connection (see interruptViaChar).
const INTR = "\x03";
const SIGTERM = 15;
const SIGKILL = 9;
const WNOHANG = 1;

// Children this module spawned, waiting to be collected. A pty's child belongs
// to this process, and nothing else here waits for it, so an exit nobody reaps
// leaves a zombie holding a pid slot. On the desktop the count is bounded by
// how many terminals one window opens. On a server that runs for weeks it is
// not, and the container has a pid limit (remote.md §11).
//
// waitpid(-1) would be one line instead of this set, but it would also collect
// whatever `Bun.spawn` is waiting for and take that exit code with it. The set
// holds pids spawned here, and only those.
const unreaped = new Set<number>();
let reaper: ReturnType<typeof setInterval> | null = null;

function reap(pid: number): void {
  if (pid <= 0) return;
  unreaped.add(pid);
  if (reaper) return;
  // A poll rather than a SIGCHLD handler: the handler would be process-wide,
  // and this module cannot install one on a runtime that has its own.
  reaper = setInterval(() => {
    for (const p of unreaped) {
      // Anything but zero settles the pid: waitpid returns the pid when it
      // collects the child, and -1 with ECHILD once there is nothing left to
      // collect. Zero means it is still running, so keep waiting.
      if (s.waitpid(p, null, WNOHANG) !== 0) unreaped.delete(p);
    }
    if (unreaped.size === 0 && reaper) {
      clearInterval(reaper);
      reaper = null;
    }
  }, 100);
  // unref'd, so a pending reap does not hold the event loop open.
  reaper.unref?.();
}

type SpawnFn = (
  slaveFD: number,
  masterFD: number,
  cwd: ReturnType<typeof ptr>,
  path: ReturnType<typeof ptr>,
  argv: ReturnType<typeof ptr>,
  envp: ReturnType<typeof ptr>,
) => number;

interface Native {
  spawnTty: SpawnFn;
  setWinsize: (fd: number, cols: number, rows: number) => number;
  setNonblock: (fd: number) => number;
}

type NativeSymbols = ReturnType<typeof dlopen<typeof NATIVE_SYMBOLS>>["symbols"];

// Where a prebuilt libledge_pty may sit. The four entries are one file in four
// layouts:
//
//   1. beside this module, where the app bundle's copy map puts it in
//      Resources/app/bun. That is cli.js's placement, for cli.js's reason:
//      import.meta.dir reads the same in the bundle as in a checkout
//      (electrobun.config.ts).
//   2. under native/<target>/ in an installed `ledge-server` package, which
//      holds all four targets at once (ptyNative.ts, nativeDir).
//   3. in dist-native/ in a checkout, where `scripts/build-native.ts` writes
//      it.
//   4. beside the executable of a `bun build --compile` server.
//
// The compiled server needs an entry of its own: import.meta.dir inside such a
// binary names a path in the embedded filesystem, where nothing was copied.
// The package needs none. `bun build` leaves import.meta.dir alone, so in the
// bundled lib/serve.js it resolves at runtime to that file's own directory,
// and a relative join reaches native/ from there.
//
// Checked in this order so a checkout run exercises the artifact that will
// actually ship rather than the fallback.
function libCandidates(): string[] {
  return [
    join(import.meta.dir, NATIVE_LIB),
    join(import.meta.dir, "native", NATIVE_DIR, NATIVE_LIB),
    join(import.meta.dir, "..", "..", "dist-native", NATIVE_LIB),
    join(dirname(process.execPath), NATIVE_LIB),
  ];
}

// The trampolines, loaded once. Two paths to the same symbols:
//
//   1. dlopen the library compiled at build time. This is the path that runs
//      on a user's machine, and the only one that works without the system
//      headers installed: the macOS SDK, or libc6-dev on a Linux server
//      (ptyNative.ts's header).
//   2. Compile the same source in-process with bun:ffi's TinyCC, for a
//      checkout with no `bun run build:native` yet. A dev machine has the
//      headers.
//
// null means neither worked. The shell still runs, spawned by the plain
// posix_spawn below. What that costs was measured rather than reasoned about:
// scripts/probe-npm.ts runs a whole server with the library removed. Resize
// becomes a no-op, since TIOCSWINSZ is variadic and the trampoline is the only
// way to reach it. Writes to a shell that is not reading can stall, for want
// of O_NONBLOCK. Job control still works. The fallback spawns with SETSID and
// has the child open the slave itself without O_NOCTTY. A session leader that
// opens a tty that way acquires it as its controlling terminal, so ^C still
// reaches the foreground group. Measured on Linux; the acquisition rule is
// POSIX and macOS implements it too.
//
// Nothing but the console warning below reports a missing trampoline, so it
// names both symptoms: the dead resize and the stalled write.
let native: Native | null | undefined;
function loadNative(): Native | null {
  if (native !== undefined) return native;

  // dlopen and cc hand back the same symbol table (one FFIType vocabulary, one
  // NATIVE_SYMBOLS), so both load paths converge here.
  const wrap = (symbols: NativeSymbols): Native => ({
    spawnTty: (slaveFD, masterFD, cwd, path, argv, envp) =>
      symbols.ledge_spawn_tty(slaveFD, masterFD, cwd, path, argv, envp) as number,
    setWinsize: (fd, cols, rows) => symbols.ledge_set_winsize(fd, cols, rows) as number,
    setNonblock: (fd) => symbols.ledge_set_nonblock(fd) as number,
  });

  for (const lib of libCandidates()) {
    if (!existsSync(lib)) continue;
    try {
      // The handle stays reachable through the closures in `native`; a closed
      // or collected library would leave the symbols dangling.
      native = wrap(dlopen(lib, NATIVE_SYMBOLS).symbols);
      return native;
    } catch (err) {
      console.warn(`[pty] ${lib} did not load:`, (err as Error).message);
    }
  }

  try {
    const src = join(tmpdir(), "ledge-pty.c");
    writeFileSync(src, NATIVE_C);
    native = wrap(cc({ source: src, symbols: NATIVE_SYMBOLS }).symbols);
  } catch (err) {
    console.warn(
      "[pty] no native trampolines (no prebuilt dylib, and compiling in-process failed:",
      (err as Error).message,
      "). Terminal resize is a no-op, and writes to a shell that is not reading "
        + "can stall the process.",
    );
    native = null;
  }
  return native;
}

// A pollfd { int fd; short events; short revents; } as 8 bytes, plus a view
// onto revents. Reading revents back is what makes a hangup visible: drain()
// looks for POLLHUP there to tell "nothing yet" apart from "the child is
// gone".
function pollBufFor(fd: number): { buf: Uint8Array; revents: Int16Array } {
  const pollfd = new ArrayBuffer(8);
  new Int32Array(pollfd, 0, 1)[0] = fd;
  new Int16Array(pollfd, 4, 1)[0] = POLLIN;
  return { buf: new Uint8Array(pollfd), revents: new Int16Array(pollfd, 6, 1) };
}

export interface PtyOptions {
  executable: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  columns?: number;
  rows?: number;
  /**
   * Deliver an interrupt as the ^C character rather than as a signal. Set it
   * when the child is a transport rather than the shell itself.
   *
   * The one caller that sets it spawns ssh (bun/server.ts spawnShell). The
   * foreground process group on the local tty is then ssh, and a SIGINT to it
   * ends the connection: the block stops, but so does the shell behind it, and
   * the note's remote cwd and exports go with it. The character travels down
   * the connection instead, and the remote tty's own line discipline raises
   * SIGINT for whatever is running there. The block stops and the connection
   * stays up.
   */
  interruptViaChar?: boolean;
}

export class PtyProcess {
  readonly pid: number;
  readonly masterFD: number;
  private closed = false;
  private ended = false;
  private poll: { buf: Uint8Array; revents: Int16Array };
  private readBuf = new Uint8Array(65536);
  private readBufPtr: ReturnType<typeof ptr>;
  // Input the tty has not taken yet, and how far into it flush() got. See
  // write().
  private outBuf: Uint8Array | null = null;
  private outOff = 0;
  // Whether the child has ever produced a byte. Nothing is written to the tty
  // before it has; see flush().
  private spoken = false;
  private readonly interruptViaChar: boolean;

  constructor(opts: PtyOptions) {
    this.interruptViaChar = opts.interruptViaChar ?? false;
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
    if (openpty(ptr(master), ptr(slave), null, null, ptr(winp)) !== 0) {
      throw new Error("openpty failed");
    }
    const masterFD = master[0];
    const slaveFD = slave[0];
    const namePtr = s.ttyname(slaveFD);
    if (!namePtr) throw new Error("ttyname failed");
    const slavePath = new CString(namePtr).toString();

    // O_NONBLOCK on the master before the child exists, so no write can ever
    // find a blocking fd. The flag rides on the open file description, and the
    // child is handed the slave (a different one), so this is the parent's
    // business only.
    loadNative()?.setNonblock(masterFD);

    const argv = cArr([opts.executable, ...opts.args]);
    const envp = cArr(Object.entries(opts.env).map(([k, v]) => `${k}=${v}`));

    const spawn = loadNative()?.spawnTty;
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
      this.poll = pollBufFor(masterFD);
      this.readBufPtr = ptr(this.readBuf);
      return;
    }

    // The fallback spawn, for when the trampolines did not load. The child
    // still gets a controlling terminal. SETSID makes it a session leader, and
    // the file action below has it open the slave itself rather than inherit
    // one, with no O_NOCTTY. That is what makes the kernel give the child the
    // tty. What is lost is the winsize ioctl and O_NONBLOCK on the master
    // (loadNative above has the measurement).
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
    this.poll = pollBufFor(masterFD);
    this.readBufPtr = ptr(this.readBuf);
  }

  /**
   * True once the child has exited. drain() sets it when poll reports the fd
   * ready but the read comes up empty. `read` returns 0 on macOS; on Linux it
   * fails and poll reports POLLHUP instead (drain() has that split). Either is
   * how a shell quitting (the user types `exit`) shows up on the master fd.
   * Latches: nothing clears it.
   */
  get exited(): boolean {
    return this.ended;
  }

  /**
   * Whether input is still queued for the tty (see write()). The drain loop's
   * business, not the caller's: bun/server.ts drainTick reads it to stay at
   * its fast cadence.
   *
   * A tty in canonical mode takes one line at a time, so a paste leaves a
   * remainder that only the next tick can push, and a loop that had backed off
   * to its idle cadence would trickle it out a chunk per tick. The echo of
   * what did land usually keeps the loop awake by itself. A program reading
   * with echo off, such as a password prompt, echoes nothing.
   *
   * True as well for the whole of a queue held for a child that has not spoken
   * yet (see flush), for the same reason: the loop must be at full speed on
   * the tick that lets it go.
   */
  get pending(): boolean {
    return this.outBuf !== null;
  }

  /** Drain everything currently readable. Never blocks (poll gates the read). */
  drain(): Uint8Array | null {
    if (this.closed) return null;
    // Push the input the tty had no room for last time, before reading.
    this.flush();
    const chunks: Uint8Array[] = [];
    while (s.poll(ptr(this.poll.buf), 1n, 0) > 0) {
      const n = Number(s.read(this.masterFD, this.readBufPtr, BigInt(this.readBuf.length)));
      if (n > 0) {
        chunks.push(this.readBuf.slice(0, n));
        continue;
      }
      // Nothing left to read. POLLHUP, not read(), says whether that is a
      // hangup or a momentary EAGAIN. The two kernels report a dead child
      // differently (macOS reads 0, Linux fails with EIO), and taking
      // read()==0 as the only sign left Linux never noticing an exit
      // (remote.md §11).
      //
      // Checked only after the read comes up empty, because both kernels raise
      // POLLHUP while the last of the output is still buffered, and that last
      // output holds the child's final line.
      if (!this.ended && (n === 0 || this.poll.revents[0] & POLLHUP)) {
        this.ended = true;
        reap(this.pid);
      }
      break;
    }
    // The child has produced output, or it has exited and never will. Either
    // way flush() stops holding the queue. Flushing on this tick rather than
    // the next keeps the wait to a shell's startup, with no drain interval
    // added on top.
    if (!this.spoken && (chunks.length > 0 || this.ended)) {
      this.spoken = true;
      this.flush();
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

  /**
   * Send `data` to the child. Takes the whole of it, but does not promise the
   * tty has it yet: what the fd refuses now waits in `outBuf` and goes out on
   * the next drain tick.
   *
   * The queue is required, not an optimisation. With O_NONBLOCK the fd answers
   * EAGAIN rather than sleeping, so something has to hold the remainder, and
   * there is always a remainder to hold: a tty in canonical mode takes only
   * one line's worth of bytes, and every shell starts out that way. The first
   * thing written to an inline shell is a block's line with the marker hook on
   * the front of it (bun/inlinePool.ts, markers.ts), and on a remote host that
   * line carries the block's whole body as base64 (bun/runner.ts,
   * remoteWrite). That is what lands in the window. Before this queue existed,
   * that write slept in the kernel forever and took the main process with it.
   *
   * The queue also holds everything back until the child has spoken. That is a
   * second and unrelated reason a write may not have reached the tty yet;
   * flush() has that one.
   *
   * The queue has no size limit. Every queued byte is something someone asked
   * to type, and dropping the tail of a command is worse than holding it. A
   * stopped child bounds it in practice, since nothing is written to a shell
   * that is not being watched.
   */
  write(data: string | Uint8Array): void {
    if (this.closed) return;
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (this.outBuf) {
      const rest = this.outBuf.subarray(this.outOff);
      const merged = new Uint8Array(rest.length + bytes.length);
      merged.set(rest, 0);
      merged.set(bytes, rest.length);
      this.outBuf = merged;
      this.outOff = 0;
    } else {
      this.outBuf = bytes;
      this.outOff = 0;
    }
    this.flush();
  }

  /**
   * Push as much of the queue as the tty will take right now. A short write is
   * the normal case, not an error: canonical mode accepts a line and no more,
   * so the loop stops on the first write that moves nothing (EAGAIN comes back
   * as -1) and the rest waits for room. Room arrives when the child reads,
   * which is also when it switches the tty to raw mode and the line limit
   * stops applying. A stalled queue unblocks itself as the shell comes up.
   */
  private flush(): void {
    // Hold the queue until the child has produced a byte. A master accepts
    // bytes before the child has finished claiming the slave as its
    // controlling terminal, and the line discipline coming up discards
    // whatever is still queued: no error, no short write, the bytes are gone,
    // and the first of them is the line that lets an inline shell end a block
    // (markers.ts, architecture.md §6a). A child that has produced output has
    // a claimed tty and is reading, so waiting for one byte shuts that window.
    //
    // The wait has no deadline. It ends when the child speaks or when it dies,
    // and a child that does neither has a tty nothing could have been
    // delivered to anyway. A remote shell mid-connect is that case, and
    // holding a block's command line until ssh is through is the behaviour
    // worth having. Every call site here is an interactive shell
    // (bun/server.ts), and those produce output before they read.
    if (!this.spoken) return;
    // The child has exited, so nothing will ever take the queue. Dropped
    // rather than left queued: a write to a dead pty fails without consuming
    // anything. A queue that can never empty reports `pending` forever, and
    // that keeps the drain loop at full speed (bun/server.ts).
    if (this.ended) {
      this.outBuf = null;
      this.outOff = 0;
      return;
    }
    while (this.outBuf && !this.closed) {
      const len = this.outBuf.length - this.outOff;
      const n = Number(s.write(this.masterFD, ptr(this.outBuf, this.outOff), BigInt(len)));
      if (n <= 0) return;
      this.outOff += n;
      if (this.outOff >= this.outBuf.length) {
        this.outBuf = null;
        this.outOff = 0;
      }
    }
  }

  /** Tell the pty its new dimensions (raises SIGWINCH on the child). */
  resize(cols: number, rows: number): void {
    if (this.closed || cols <= 0 || rows <= 0) return;
    loadNative()?.setWinsize(this.masterFD, cols, rows);
  }

  /**
   * The tty's foreground process group: the one a typed ^C would signal, or -1
   * if the tty has none.
   *
   * This is not the shell's own group. A controlling terminal turns zsh's job
   * control on, and job control puts every foreground job in a group of its
   * own. Signalling the shell's group would reach the shell, which ignores
   * SIGINT, and miss the job entirely.
   */
  private fgPgrp(): number {
    if (this.closed) return -1;
    const pg = s.tcgetpgrp(this.masterFD);
    return pg > 0 ? pg : -1;
  }

  /** SIGINT whatever is running in the foreground, as ^C would. */
  interrupt(): void {
    if (this.interruptViaChar) {
      this.write(INTR);
      return;
    }
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
    // Read the foreground group before anything dies: killing the shell first
    // would leave the tty with no owner to report.
    const fg = this.fgPgrp();
    this.closed = true;
    if (fg > 0 && fg !== this.pid) s.killpg(fg, SIGKILL);
    s.killpg(this.pid, SIGKILL);
    s.close(this.masterFD);
    // SIGKILL cannot be caught, but it is not instant either, and nothing
    // drains this pty again. The reaper's timer collects the child instead.
    reap(this.pid);
  }
}
