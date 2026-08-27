// The PTY against a real shell, because everything interesting about it is a
// property of the kernel rather than of this code: whether the child got a
// CONTROLLING terminal, whether the line discipline turns ^C into a signal,
// whether TIOCSWINSZ reaches the program inside.
//
// This is the one test file that is also the Linux port's proof. `pty.ts`
// reaches libc by name and by flag value, and both differ between libSystem
// and glibc (`ptyNative.ts`, PLATFORM); the C reaches login_tty through a
// different header on each. None of that is checkable by reading it, and all
// of it fails quietly — a terminal that runs commands fine and has no Ctrl-C.
// So the suite runs in the container too (`Dockerfile`, `docs/contributor/
// remote.md` §13) and the same assertions answer for both libcs.
import { describe, expect, test } from "bun:test";
import { PtyProcess, type PtyOptions } from "./pty";

const SH = "/bin/sh";
const ENV = { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", TERM: "xterm-256color" };

function shell(opts: Partial<PtyOptions> = {}): PtyProcess {
  return new PtyProcess({ executable: SH, args: [], env: ENV, ...opts });
}

/**
 * Drain until `want` shows up, returning everything read. A poll rather than a
 * fixed wait: a shell's startup is not a duration anything here gets to
 * assume, and the failure message carries what did arrive, which is the
 * difference between "Ctrl-C is broken" and "the shell never came up".
 *
 * `normalize` matches against a rewritten copy while still returning the raw
 * text, for the one case where the terminal's own line wrapping sits between
 * what was written and what came back.
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
 * How long until the shell will run something again — the portable way to ask
 * whether an interrupt landed.
 *
 * What the two platforms do AFTER the signal is not common ground: `sh` is
 * bash in posix mode on macOS and dash on Debian, and one carries on to the
 * next command in the list while the other abandons it for a prompt. What is
 * common is that a shell still inside `sleep 30` runs nothing at all.
 *
 * Asking repeatedly rather than once, because raising SIGINT also FLUSHES the
 * terminal's input queue: a command typed in the same breath as the interrupt
 * is echoed and then discarded, which reads exactly like a shell that is still
 * busy.
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

/** The same question, expecting the answer no. */
async function stillBusy(pty: PtyProcess, ms: number): Promise<boolean> {
  try {
    await idleWithin(pty, ms);
    return false;
  } catch {
    return true;
  }
}

// The window that eats the first thing written to a shell. A master takes
// bytes from the moment it exists; the child claims the slave a moment later,
// and the line discipline coming up discards whatever is still queued. Nothing
// reports it — no error, no short write — and what is lost is whichever line
// went first, which for an inline shell is the one that lets it end a block
// (bun/markers.ts).
describe("input written before the child has spoken", () => {
  test("waits for it rather than going into a tty nobody has claimed", async () => {
    // A child that stays quiet long enough to ask the question. Without the
    // gate the tty takes this write at once — an empty input queue has room —
    // and `pending` would already be false.
    const pty = shell({ args: ["-c", "sleep 0.4; echo AWAKE; exec cat"] });
    try {
      pty.write("held-until-awake\n");
      expect(pty.pending).toBe(true);

      // It goes out on the tick that hears the child, not the one after.
      const seen = await readUntil(pty, /AWAKE/);
      expect(seen).not.toContain("held-until-awake");
      await readUntil(pty, /held-until-awake/);
      expect(pty.pending).toBe(false);
    } finally {
      pty.close();
    }
  });

  test("goes out when the child dies without ever speaking", async () => {
    // Nothing will read it and nothing needs to, but a queue held for a child
    // that is gone would be held forever, and `pending` is what the drain loop
    // reads to decide it may slow down (bun/server.ts).
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
  // a session leader whose session HAS this terminal, and `tty` can name it.
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

  // What the trampoline exists for, in the two ways it is delivered. Both
  // assert on the CLOCK: a shell inside `sleep 30` runs nothing, so the
  // difference between working and inert is thirty seconds.
  //
  // `interrupt()` is a signal to the terminal's FOREGROUND PROCESS GROUP,
  // which the terminal only has because a process claimed it — on BSD an
  // explicit TIOCSCTTY that posix_spawn has no file action for.
  test("interrupt stops the foreground job", async () => {
    const pty = shell();
    try {
      pty.write("echo GO-$((6*7)); sleep 30\n");
      // The marker has to differ from what the terminal ECHOES back, or the
      // wait is satisfied by our own keystrokes: hence the arithmetic.
      await readUntil(pty, /GO-42/);
      // Confirm it is genuinely inside the sleep BEFORE interrupting. An
      // interrupt that lands in the moment between `echo` and `sleep` stops
      // the list without ever reaching a signal handler, and the test would
      // pass without having asked anything.
      expect(await stillBusy(pty, 1000)).toBe(true);
      pty.interrupt();
      expect(await idleWithin(pty, 8000)).toBeLessThan(8000);
    } finally {
      pty.close();
    }
  }, 30_000);

  // The stricter version: nothing here signals anything. A ^C CHARACTER is
  // inert unless the line discipline has a foreground process group to raise
  // SIGINT on, so this is the assertion that fails if the trampoline never
  // loaded — where the previous one could still pass by killpg'ing the pid it
  // was handed.
  test("a typed ^C is turned into a signal by the line discipline", async () => {
    const pty = shell({ interruptViaChar: true });
    try {
      pty.write("echo GO-$((6*7)); sleep 30\n");
      // The marker has to differ from what the terminal ECHOES back, or the
      // wait is satisfied by our own keystrokes: hence the arithmetic.
      await readUntil(pty, /GO-42/);
      // Confirm it is genuinely inside the sleep BEFORE interrupting. An
      // interrupt that lands in the moment between `echo` and `sleep` stops
      // the list without ever reaching a signal handler, and the test would
      // pass without having asked anything.
      expect(await stillBusy(pty, 1000)).toBe(true);
      pty.interrupt();
      expect(await idleWithin(pty, 8000)).toBeLessThan(8000);
    } finally {
      pty.close();
    }
  }, 30_000);

  // ioctl(TIOCSWINSZ) through the fixed-arity wrapper. The constant differs
  // between the two kernels (0x80087467 and 0x5414) and never reaches
  // TypeScript, so this is also the test that the C was compiled against the
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
  // terminal out of canonical mode. Production does exactly this with the
  // marker hook. Every byte has to survive being refused, because the tail
  // this drops is the tail of somebody's command.
  //
  // 900 characters, not more, and the ceiling is real rather than timid:
  // MAX_CANON is 1024 on macOS and a 4096-byte buffer on Linux, and a line
  // over the limit is one the terminal can never complete and the shell can
  // never read — the deadlock O_NONBLOCK downgrades to a stall. Which side of
  // that line a long paste falls on is a property of the kernel, so a test
  // that crossed it would assert a difference rather than the queue.
  test("a long first line, written before the shell reads, survives whole", async () => {
    const pty = shell({ columns: 80 });
    try {
      pty.write(`echo ${"A".repeat(900)}-DONE\n`);
      // The terminal wraps at its width, and macOS marks each wrap with a
      // space and a CR, so the A's arrive in 80-column pieces. Joining them
      // back up IS the assertion: every byte written came back, in order.
      const flat = (s: string) => s.replace(/[ \r\n]/g, "");
      const out = await readUntil(pty, /A{900}-DONE/, 6000, flat);
      expect(flat(out)).toContain(`${"A".repeat(900)}-DONE`);
    } finally {
      pty.close();
    }
  }, 20_000);

  // A closed drawer used to leave a zombie apiece: nothing in this process
  // waits for a pty's child, so its exit status sat in the table forever. One
  // window's worth is invisible; a server that runs for weeks (remote.md §11)
  // is where it becomes a pid leak, and a container has a pid limit.
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
