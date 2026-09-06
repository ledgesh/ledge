// The PTY against a real shell: whether the child got a controlling terminal,
// whether the line discipline turns ^C into a signal, whether TIOCSWINSZ
// reaches the program inside. All of that is a property of the kernel rather
// than of this code.
//
// This is the one test file that is also the Linux port's proof. `pty.ts`
// reaches libc by name and by flag value, and both differ between libSystem
// and glibc (`ptyNative.ts`, PLATFORM). The C reaches login_tty through a
// different header on each. A mistake there is invisible in the source and
// fails quietly: a terminal that runs commands fine and has no Ctrl-C. The
// suite runs in the container too (`Dockerfile`, `docs/contributor/remote.md`
// §13), so the same assertions answer for both libcs.
import { describe, expect, test } from "bun:test";
import { PtyProcess, type PtyOptions } from "./pty";

const SH = "/bin/sh";
const ENV = { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", TERM: "xterm-256color" };

function shell(opts: Partial<PtyOptions> = {}): PtyProcess {
  return new PtyProcess({ executable: SH, args: [], env: ENV, ...opts });
}

/**
 * Drains until `want` shows up, returning everything read. It polls rather
 * than waiting a fixed time, because a shell's startup has no duration this
 * code gets to assume. The timeout error quotes the tail of what did arrive,
 * which separates "Ctrl-C is broken" from "the shell never came up".
 *
 * `normalize` rewrites the copy that `want` is matched against, and the raw
 * text is still what gets returned. The long-line test needs it, because the
 * terminal's own line wrapping sits between what was written and what came
 * back.
 */
async function readUntil(
  pty: PtyProcess,
  want: RegExp,
  ms = 5000,
  normalize: (s: string) => string = (s) => s,
): Promise<string> {
  const dec = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const chunk = pty.drain();
    if (chunk) seen += dec.decode(chunk, { stream: true });
    if (want.test(normalize(seen))) return seen;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${want}\nsaw: ${JSON.stringify(seen.slice(-500))}`);
}

/**
 * Returns how long it takes the shell to run something again. That is the
 * portable way to ask whether an interrupt landed.
 *
 * What happens after the signal differs by platform: `sh` is bash in posix
 * mode on macOS and dash on Debian, and one carries on to the next command in
 * the list while the other abandons it for a prompt. On both, a shell still
 * inside `sleep 30` runs nothing.
 *
 * It asks repeatedly rather than once. Raising SIGINT also flushes the
 * terminal's input queue, so a command typed in the same breath as the
 * interrupt is echoed and then discarded, and that looks like a shell that is
 * still busy.
 */
async function idleWithin(pty: PtyProcess, ms: number): Promise<number> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < ms) {
    pty.write("echo BACK-$((6*7))\n");
    try {
      await readUntil(pty, /BACK-42/, 400);
      return Date.now() - start;
    } catch (err) {
      // Still busy, or the ask was flushed with the signal. Ask again.
      last = (err as Error).message;
    }
  }
  throw new Error(`the shell was still busy ${ms}ms after the interrupt\n${last}`);
}

/**
 * True when the shell runs nothing within `ms`. It asks idleWithin and
 * reports the opposite answer.
 */
async function stillBusy(pty: PtyProcess, ms: number): Promise<boolean> {
  try {
    await idleWithin(pty, ms);
    return false;
  } catch {
    return true;
  }
}

// The window that eats the first thing written to a shell. A master takes
// bytes from the moment it exists. The child claims the slave a moment later,
// and the line discipline coming up discards whatever is still queued, with no
// error and no short write. What is lost is whichever line went first. For an
// inline shell that is the line that lets the shell end a block
// (bun/markers.ts).
describe("input written before the child has spoken", () => {
  test("waits for it rather than going into a tty nobody has claimed", async () => {
    // A child that stays quiet long enough to ask the question. Without the
    // gate in pty.ts flush(), the tty would take this write at once (an empty
    // input queue has room) and `pending` would already be false.
    const pty = shell({ args: ["-c", "sleep 0.4; echo AWAKE; exec cat"] });
    try {
      pty.write("held-until-awake\n");
      expect(pty.pending).toBe(true);

      // The queue goes out on the drain tick that reads the child's first
      // output, not the tick after it.
      const seen = await readUntil(pty, /AWAKE/);
      expect(seen).not.toContain("held-until-awake");
      await readUntil(pty, /held-until-awake/);
      expect(pty.pending).toBe(false);
    } finally {
      pty.close();
    }
  });

  test("goes out when the child dies without ever speaking", async () => {
    // Nothing will read this write, and nothing needs to. A queue held for a
    // child that is gone would be held forever, and the drain loop reads
    // `pending` to decide whether it may slow down (bun/server.ts).
    const pty = shell({ args: ["-c", "exit 0"] });
    try {
      pty.write("nobody is listening\n");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !pty.exited) {
        pty.drain();
        await Bun.sleep(5);
      }
      expect(pty.exited).toBe(true);
      expect(pty.pending).toBe(false);
    } finally {
      pty.close();
    }
  });
});

describe("a shell on a pty", () => {
  test("runs a command and echoes it back", async () => {
    const pty = shell();
    try {
      pty.write("echo READY-$((6*7))\n");
      await readUntil(pty, /READY-42/);
    } finally {
      pty.close();
    }
  });

  // The claim that separates a pty from a pipe. login_tty ran, so the child is
  // a session leader whose session holds this terminal, and `tty` can name it.
  test("the child holds the terminal as its controlling one", async () => {
    const pty = shell();
    try {
      pty.write("tty\n");
      const out = await readUntil(pty, /\/dev\/(pts\/\d+|ttys\d+)/);
      expect(out).not.toContain("not a tty");
    } finally {
      pty.close();
    }
  });

  // An interrupt, in the two ways it is delivered. Both tests assert on the
  // clock: a shell inside `sleep 30` runs nothing, so the difference between
  // working and inert is thirty seconds.
  //
  // `interrupt()` signals the terminal's foreground process group. The
  // terminal has that group only because the child claimed the terminal as
  // its controlling one. On BSD that claim is an explicit TIOCSCTTY, and
  // posix_spawn has no file action for an ioctl (ptyNative.ts).
  test("interrupt stops the foreground job", async () => {
    const pty = shell();
    try {
      pty.write("echo GO-$((6*7)); sleep 30\n");
      // The arithmetic makes the marker differ from what the terminal echoes
      // back. Without it, the echo of the written line satisfies the wait.
      await readUntil(pty, /GO-42/);
      // Confirm the shell is inside the sleep before interrupting. An
      // interrupt that lands between `echo` and `sleep` stops the list without
      // reaching a signal handler, and the test would pass without having
      // tested anything.
      expect(await stillBusy(pty, 1000)).toBe(true);
      pty.interrupt();
      expect(await idleWithin(pty, 8000)).toBeLessThan(8000);
    } finally {
      pty.close();
    }
  }, 30_000);

  // The stricter version: nothing here raises a signal. The ^C character goes
  // into the terminal, and the line discipline raises SIGINT on the foreground
  // process group. The test above could pass by killpg'ing the pid it was
  // handed. Neither test shows whether the native library loaded, because the
  // fallback spawn acquires a controlling terminal too. Resize below is the
  // test that does (remote.md §13).
  test("a typed ^C is turned into a signal by the line discipline", async () => {
    const pty = shell({ interruptViaChar: true });
    try {
      pty.write("echo GO-$((6*7)); sleep 30\n");
      // The arithmetic makes the marker differ from what the terminal echoes
      // back. Without it, the echo of the written line satisfies the wait.
      await readUntil(pty, /GO-42/);
      // Confirm the shell is inside the sleep before interrupting. An
      // interrupt that lands between `echo` and `sleep` stops the list without
      // reaching a signal handler, and the test would pass without having
      // tested anything.
      expect(await stillBusy(pty, 1000)).toBe(true);
      pty.interrupt();
      expect(await idleWithin(pty, 8000)).toBeLessThan(8000);
    } finally {
      pty.close();
    }
  }, 30_000);

  // ioctl(TIOCSWINSZ) through the fixed-arity wrapper. The constant differs
  // between the two kernels (0x80087467 and 0x5414) and never reaches
  // TypeScript, so this test also checks that the C was compiled against the
  // headers of the machine it runs on.
  test("resize is visible to the program inside", async () => {
    const pty = shell({ columns: 120, rows: 30 });
    try {
      pty.write("stty size\n");
      await readUntil(pty, /30 120/);
      pty.resize(100, 24);
      pty.write("stty size\n");
      await readUntil(pty, /24 100/);
    } finally {
      pty.close();
    }
  });

  // The write queue, exercised by the case it exists for: the first thing
  // written to a shell, before that shell has read anything or switched the
  // terminal out of canonical mode. Production does this with the marker hook
  // (bun/markers.ts). Every byte has to survive being refused, because a
  // dropped tail is the tail of somebody's command.
  //
  // The 900 characters stay under a real kernel limit: MAX_CANON is 1024 on
  // macOS, and Linux uses a 4096-byte buffer. A longer line is one the
  // terminal can never complete and the shell can never read. O_NONBLOCK turns
  // that deadlock into a stall. A test that crossed the limit would assert a
  // difference between the two kernels rather than the queue's behavior.
  test("a long first line, written before the shell reads, survives whole", async () => {
    const pty = shell({ columns: 80 });
    try {
      pty.write(`echo ${"A".repeat(900)}-DONE\n`);
      // The terminal wraps at its width, and macOS marks each wrap with a
      // space and a CR, so the A's arrive in 80-column pieces. Joining them
      // back up is the assertion: every byte written came back, in order.
      const flat = (s: string) => s.replace(/[ \r\n]/g, "");
      const out = await readUntil(pty, /A{900}-DONE/, 6000, flat);
      expect(flat(out)).toContain(`${"A".repeat(900)}-DONE`);
    } finally {
      pty.close();
    }
  }, 20_000);

  // Closing a drawer used to leave a zombie behind. Nothing else in this
  // process waits for a pty's child, so its exit status sat in the process
  // table forever. One window's worth goes unnoticed. A server that runs for
  // weeks leaks pids, and a container has a pid limit (remote.md §11).
  test("a closed shell is collected, not left as a zombie", async () => {
    const pty = shell();
    pty.write("echo READY\n");
    await readUntil(pty, /READY/);
    const { pid } = pty;
    pty.close();
    const deadline = Date.now() + 5000;
    let stat = "";
    while (Date.now() < deadline) {
      const ps = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
      stat = ps.stdout.toString().trim();
      if (stat === "") break; // gone from the table entirely: collected
      await Bun.sleep(25);
    }
    expect(stat).toBe("");
  }, 20_000);

  test("the child exiting latches", async () => {
    const pty = shell();
    try {
      pty.write("echo READY\n");
      await readUntil(pty, /READY/);
      expect(pty.exited).toBe(false);
      pty.write("exit\n");
      const deadline = Date.now() + 5000;
      while (!pty.exited && Date.now() < deadline) {
        pty.drain();
        await Bun.sleep(5);
      }
      expect(pty.exited).toBe(true);
    } finally {
      pty.close();
    }
  });
});
