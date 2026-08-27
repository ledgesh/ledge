// A child shell attached to a pseudo-terminal, driven entirely from Bun via
// bun:ffi. A port of Sources/SessionKit/PTYProcess.swift.
//
// Why FFI and not node-pty: node-pty's native read stream never delivers data
// under Bun. Why posix_spawn and not fork(): forking from Bun's multithreaded
// runtime segfaults, but posix_spawn's fork+exec happens inside libc and is
// safe. Why poll() on reads: it is cheaper than a syscall that answers EAGAIN,
// and it distinguishes "nothing yet" from the hangup that means the child is
// gone. Writes cannot use poll — on a pty master it reports writable and then
// the write blocks anyway — so the master fd is O_NONBLOCK (through the
// ledge_set_nonblock trampoline, because fcntl is variadic and bun:ffi
// mis-marshals variadic calls on arm64) and write() queues what the tty
// refuses.
import { dlopen, ptr, CString, cc } from "bun:ffi";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NATIVE_C, NATIVE_DIR, NATIVE_LIB, NATIVE_SYMBOLS, PLATFORM } from "./ptyNative";

// The first library that has all of `symbols`. Every candidate failing is
// fatal and should be: there is no PTY without a libc, and the alternative is
// a null check on every syscall in this file.
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

// Its own handle, because on glibc it may live in libutil rather than libc
// (ptyNative.ts, PLATFORM) and dlopen resolves a table all at once.
const { openpty } = openFirst(PLATFORM.ptyLib, {
  openpty: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
}).symbols;

const O_RDWR = 0x0002;
const POSIX_SPAWN_SETSID = PLATFORM.POSIX_SPAWN_SETSID;
const POLLIN = 0x0001;
// Same value on both kernels, unlike almost everything else here.
const POLLHUP = 0x0010;
const SIGINT = 2;
// ETX: what the tty turns back into SIGINT at the far end of a connection.
const INTR = "\x03";
const SIGTERM = 15;
const SIGKILL = 9;
const WNOHANG = 1;

// Children we have reason to think are dead, waiting to be collected.
//
// A pty's child is OUR child and nothing else in this process waits for it, so
// an exit nobody reaps is a zombie holding a pid slot. On the desktop that is
// bounded by how many terminals one window opens; on a server that runs for
// weeks it is not, and the container has a pid limit (remote.md §11).
//
// waitpid(-1) would be one line instead of this and is wrong: it would also
// collect whatever `Bun.spawn` is waiting for and take that exit code with it.
// So the set holds pids we spawned, and only those.
const unreaped = new Set<number>();
let reaper: ReturnType<typeof setInterval> | null = null;

function reap(pid: number): void {
  if (pid <= 0) return;
  unreaped.add(pid);
  if (reaper) return;
  // A poll rather than SIGCHLD: the handler would be process-wide, and this
  // module does not get to install one on a runtime that has its own.
  reaper = setInterval(() => {
    for (const p of unreaped) {
      // Nonzero is settled — the pid was collected, or it is ECHILD and never
      // was ours to collect. Zero means it is still running, so keep waiting.
      if (s.waitpid(p, null, WNOHANG) !== 0) unreaped.delete(p);
    }
    if (unreaped.size === 0 && reaper) {
      clearInterval(reaper);
      reaper = null;
    }
  }, 100);
  // Nothing should stay alive on account of a corpse.
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

// Where a prebuilt libledge_pty may sit. The entries are the SAME file at
// four moments in its life: `scripts/build-native.ts` writes it to
// dist-native/ in the checkout, the app bundle's copy map lands it beside this
// module in Resources/app/bun (the cli.js placement, for the cli.js reason —
// import.meta.dir is the one path that reads the same in both layouts), a
// `bun build --compile` server ships it beside the executable, and an
// installed `ledge-server` package holds all four targets at once under
// native/ (ptyNative.ts, nativeDir).
//
// The compiled case needs its own entry because import.meta.dir inside such a
// binary names a path in the embedded filesystem, where nothing was copied.
// The package case does not: `bun build` leaves import.meta.dir alone, so in
// the bundled lib/serve.js it resolves at runtime to that file's own
// directory, which is what puts native/ within reach of a relative join.
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
//   1. dlopen the library we compiled at build time. This is the path that
//      runs on a user's machine, and the only one that works without the
//      system headers installed (ptyNative.ts's header) — the macOS SDK, or
//      libc6-dev on a Linux server, neither of which a machine that downloads
//      a binary has any reason to carry.
//   2. Compile the same source in-process with bun:ffi's TinyCC. Covers a
//      checkout with no `bun run build:native` yet — a dev machine, where the
//      headers this needs are present by construction.
//
// null means neither worked: the shell still runs, spawned by plain
// posix_spawn below. What that costs is narrower than it reads, and it was
// measured rather than reasoned about — scripts/probe-npm.ts runs a whole
// server with the library removed. Resize becomes a no-op, because TIOCSWINSZ
// is variadic and the trampoline is the only way to reach it, and writes to a
// shell that is not reading can stall for want of O_NONBLOCK. Job control
// SURVIVES: the fallback spawns with SETSID and has the child open the slave
// itself without O_NOCTTY, and a session leader that opens a tty that way
// acquires it as its controlling terminal, so ^C still reaches the foreground
// group. Measured on Linux; the acquisition rule is POSIX and macOS implements
// it too.
//
// The warning below is still the only way to attribute a dead resize from the
// outside, which is the whole reason it is worded as specifically as it is.
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

// pollfd { int fd; short events; short revents; } -> 8 bytes, with a view onto
// the answer. Reading revents back is what makes the hangup legible: poll is
// here to tell "nothing yet" apart from "the child is gone", and the two
// kernels agree on POLLHUP while disagreeing about everything else.
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
   * Deliver an interrupt as the ^C character rather than as a signal, for a
   * child that is a transport rather than the shell itself.
   *
   * Set this when the child is ssh. The foreground process group on THIS tty is
   * then ssh, and a SIGINT to it ends the connection: the block stops, but so
   * does the shell behind it, and the note's remote cwd and exports go with it.
   * The character instead travels down the connection to the remote tty, whose
   * own line discipline raises SIGINT for whatever is running over there, which
   * is what the user meant by "stop this block".
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
  // Input the tty has not taken yet, and how far into it we got. See write().
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

    // Before the child exists, so no write can ever find a blocking fd. The
    // flag rides on the open file description, and the child is handed the
    // SLAVE — a different one — so this is the parent's business only.
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

    // Fallback. The controlling terminal survives it, and these two lines are
    // why: SETSID makes the child a session leader, and it OPENS the slave
    // itself rather than inheriting it — with no O_NOCTTY, which is what makes
    // the kernel hand it over. What is actually lost is the winsize ioctl and
    // O_NONBLOCK on the master; loadNative above has the measurement.
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
   * True once the child has exited: `poll` reports the fd readable (a hangup)
   * but `read` returns 0 (EOF), which is how a shell quitting (e.g. the user
   * types `exit`) shows up on the master fd. Latches; cleared only by close.
   */
  get exited(): boolean {
    return this.ended;
  }

  /**
   * Whether input is still queued for the tty (see write()).
   *
   * The drain loop's business, not the caller's: a tty in canonical mode takes
   * one line at a time, so a paste leaves a remainder that only the next tick
   * can push, and a loop that had backed off to its idle cadence would trickle
   * it out a chunk per tick. Usually the echo of what did land keeps the loop
   * awake by itself; this is the case where it cannot, because the program
   * reading has echo off (a password prompt).
   *
   * True as well for the whole of a queue that is being held for a child which
   * has not spoken yet (see flush), which is the same answer for the same
   * reason: the loop must be at full speed for the tick that lets it go.
   */
  get pending(): boolean {
    return this.outBuf !== null;
  }

  /** Drain everything currently readable. Never blocks (poll gates the read). */
  drain(): Uint8Array | null {
    if (this.closed) return null;
    // The other half of the tick: input the tty had no room for last time.
    this.flush();
    const chunks: Uint8Array[] = [];
    while (s.poll(ptr(this.poll.buf), 1n, 0) > 0) {
      const n = Number(s.read(this.masterFD, this.readBufPtr, BigInt(this.readBuf.length)));
      if (n > 0) {
        chunks.push(this.readBuf.slice(0, n));
        continue;
      }
      // Nothing left to read. Whether that is a hangup or a momentary EAGAIN
      // is POLLHUP's answer and not read()'s, because the two kernels report
      // the same fact differently: a master whose slave is closed reads 0 on
      // macOS and fails with EIO on Linux. Taking read()==0 as the only sign
      // meant a shell that exited was never noticed there — no terminalExit,
      // and a session that stayed in the map forever.
      //
      // Checked only after read comes up empty, because both kernels raise
      // POLLHUP while the last of the output is still buffered, and a child's
      // final line is exactly the one worth keeping.
      if (!this.ended && (n === 0 || this.poll.revents[0] & POLLHUP)) {
        this.ended = true;
        reap(this.pid);
      }
      break;
    }
    // The child spoke, or it is never going to. Either way the queue stops
    // being held, and it goes out on this tick rather than the next one so
    // that waiting costs a shell's startup and not a drain interval on top.
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
   * The queue is not an optimisation. With O_NONBLOCK the fd answers EAGAIN
   * rather than sleeping, and something has to hold the remainder — and there
   * is always a remainder to hold, because a tty in canonical mode takes only
   * one line's worth of bytes and every shell starts out that way. The first
   * thing written to a shell is a block's line with the marker hook on the
   * front of it, base64 body and all, which is exactly what lands in that
   * window. Before this queue existed, that write slept in the kernel forever
   * and took the main process with it.
   *
   * It is also what holds everything back until the child has spoken, which is
   * a second and unrelated reason a write may not have reached the tty yet;
   * flush() has that one.
   *
   * Unbounded on purpose: every queued byte is something someone asked to type,
   * and dropping the tail of a command is worse than holding it. A stopped
   * child bounds it in practice, since nothing is written to a shell that is
   * not being watched.
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
   * which is also when it switches the tty to raw mode and the line limit stops
   * applying — so a stalled queue unblocks itself as the shell comes up.
   */
  private flush(): void {
    // Nothing goes into a tty that has never said anything.
    //
    // A master accepts bytes from the moment it exists, which is before the
    // child has finished claiming the slave as its controlling terminal — and
    // the line discipline coming up DISCARDS whatever is still queued. There
    // is no error and no short write: the bytes are simply gone, and the first
    // thing written to an inline shell is the line that lets it end a block
    // (markers.ts). A child that has produced output has a claimed tty and is
    // reading, so waiting for one byte is what makes that window shut.
    //
    // Waiting has no deadline on purpose. The wait ends when the child speaks
    // or when it dies, and a child that does neither is one whose tty nothing
    // could have been delivered to anyway — a remote shell mid-connect is
    // exactly that, and holding a block's command line until ssh is through is
    // the behaviour worth having. Every call site here is an interactive shell
    // (bun/server.ts), and those announce themselves before they read.
    if (!this.spoken) return;
    // The child is gone: there is nobody to take this and there never will be.
    // Dropped rather than left queued, because a write to a dead pty fails
    // without consuming anything, and a queue that can never empty reports
    // `pending` forever — which is the drain loop's signal to stay at full
    // speed (bun/server.ts).
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
    // Read the foreground group before anything dies: killing the shell first would
    // leave us asking a tty whose owner is already gone.
    const fg = this.fgPgrp();
    this.closed = true;
    if (fg > 0 && fg !== this.pid) s.killpg(fg, SIGKILL);
    s.killpg(this.pid, SIGKILL);
    s.close(this.masterFD);
    // SIGKILL cannot be caught, but it is not instant either, and nothing will
    // drain this pty again — so the collection has to be somebody else's tick.
    reap(this.pid);
  }
}
