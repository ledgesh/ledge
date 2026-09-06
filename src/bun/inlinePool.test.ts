import { describe, expect, test } from "bun:test";
import { InlinePool, type InlineEvent, type InlineShellIO } from "./inlinePool";
import { markerCommand, markerInit } from "./markers";

const NONCE = "testnonce";

// Who started a run. Most tests below use one client throughout. The pair
// matters only where two clients share a server (see "runs belong to the
// client that started them").
const MAC = "mac";
const PHONE = "phone";

// The byte stream a real shell would echo back: OSC 133 C when a block starts,
// D with the exit status when its prompt returns (markers.ts). The hook's ack
// goes out ahead of the start marker in the same write (markers.ts, and `run`
// in inlinePool.ts), so a block on a shell that can end it always shows those
// two in order. `unhooked` is the damaged case: the block marker with no ack.
const ready = `\x1b]133;R;ledge=${NONCE}\x07`;
const unhooked = (id: string) => `\x1b]133;C;ledge=${NONCE}:${id}\x07`;
const began = (id: string) => ready + unhooked(id);
const ended = (id: string, code = 0) => `\x1b]133;D;${code};ledge=${NONCE}:${id}\x07`;

class FakeShell implements InlineShellIO {
  written = "";
  // Kept apart from `written` so a test can check that the hook and the block
  // go out in a single write. A tty discards what it has not read yet, and two
  // writes can be separated where one cannot.
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  interrupts = 0;
  closed = false;
  exited = false;
  // What a real pty reports when the tty would not take all of a write
  // (pty.ts `pending`). Tests set it directly: a fake has no tty to refuse.
  pending = false;
  private queue: Uint8Array[] = [];

  write(data: string | Uint8Array): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    this.written += text;
    this.writes.push(text);
  }
  drain(): Uint8Array | null {
    return this.queue.shift() ?? null;
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  interrupt(): void {
    this.interrupts += 1;
  }
  close(): void {
    this.closed = true;
  }
  /** Queue bytes for the next drain, as if the pty produced them. */
  emit(text: string): void {
    this.queue.push(new TextEncoder().encode(text));
  }
}

function makePool() {
  const shells: FakeShell[] = [];
  const clock = { t: 1_000_000 };
  const pool = new InlinePool(
    () => {
      const s = new FakeShell();
      shells.push(s);
      return s;
    },
    NONCE,
    () => clock.t,
  );
  const drained = (): InlineEvent[] => {
    const events: InlineEvent[] = [];
    pool.drain((ev) => events.push(ev));
    return events;
  };
  return { pool, shells, drained, clock };
}

const textOf = (events: InlineEvent[]): string =>
  events
    .filter((e) => e.type === "output")
    .map((e) => new TextDecoder().decode((e as { data: Uint8Array }).data))
    .join("");

describe("restartSession", () => {
  test("kills the shells and the next run gets a fresh one", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    shells[0].emit(began("a") + ended("a"));
    drained();

    pool.restartSession("note", () => {});
    expect(shells[0].closed).toBe(true);

    pool.run("note", "b", "source /tmp/b.sh", { client: MAC });
    expect(shells.length).toBe(2);
    // The new shell gets the marker hook again: the hook lived in the dead zsh.
    expect(shells[1].written.startsWith(markerInit(NONCE))).toBe(true);
  });

  test("open runs are closed out through emit, overflow included", () => {
    // The tab is still open and watching, unlike closeSession. A run left
    // un-ended sits on "Running" with a run button that no longer works.
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    shells[0].emit(began("a"));
    drained();
    pool.run("note", "b", "source /tmp/b.sh", { client: MAC }); // overflow: a still running

    const events: InlineEvent[] = [];
    pool.restartSession("note", (ev) => events.push(ev));
    expect(events).toEqual([
      { type: "ended", blockId: "a", exitCode: null },
      { type: "ended", blockId: "b", exitCode: null },
    ]);
    expect(shells.every((s) => s.closed)).toBe(true);
  });

  test("an idle session restarts silently; an unknown one is a no-op", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    shells[0].emit(began("a") + ended("a"));
    drained();

    const events: InlineEvent[] = [];
    pool.restartSession("note", (ev) => events.push(ev));
    pool.restartSession("never-seen", (ev) => events.push(ev));
    expect(events).toEqual([]);
  });

  test("a resize stashed for a not-yet-started run dies with the restart", () => {
    // The stashed resize was measured against the panels of the session being
    // torn down. Applying it to a shell spawned after the restart would set a
    // stale grid.
    const { pool, shells } = makePool();
    pool.resize("note", "x", 33, 7);
    pool.restartSession("note", () => {});
    pool.run("note", "x", "source /tmp/x.sh", { client: MAC });
    expect(shells[0].resizes).toEqual([]);
  });
});

describe("shell selection", () => {
  test("the first run goes to the note's persistent shell, primed with the marker hook", () => {
    const { pool, shells } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    expect(shells.length).toBe(1);
    expect(shells[0].written.startsWith(markerInit(NONCE))).toBe(true);
    expect(shells[0].written).toContain("source /tmp/a.sh");
  });

  test("every spawn is told which session it is for, overflow included", () => {
    // The spawn uses the session id to give the shell that note's params (cwd
    // and env from its frontmatter). An overflow shell for the same note has
    // to start with the same ones.
    const spawnedFor: string[] = [];
    const pool = new InlinePool((sessionId) => {
      spawnedFor.push(sessionId);
      return new FakeShell();
    }, NONCE);
    pool.run("note-1", "a", "source /tmp/a.sh", { client: MAC });
    pool.run("note-1", "b", "source /tmp/b.sh", { client: MAC }); // overflow: a is still running
    expect(spawnedFor).toEqual(["note-1", "note-1"]);
  });

  test("a second run while the first is still going gets an overflow shell of its own", () => {
    const { pool, shells } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    pool.run("note", "b", "source /tmp/b.sh", { client: MAC });
    expect(shells.length).toBe(2);
    // Nothing of b's may reach the busy shell: its echo would land in a's output.
    expect(shells[0].written).not.toContain("b.sh");
    expect(shells[1].written).toContain("source /tmp/b.sh");
  });

  test("a second run picks the overflow shell even before the first's begin marker echoes back", () => {
    // The write happens now and the C marker echoes back later. The busy check
    // must not depend on the echo, or two rapid runs would share the shell.
    const { pool, shells } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    // No drain between the two runs: shell 0 has echoed nothing yet.
    pool.run("note", "b", "source /tmp/b.sh", { client: MAC });
    expect(shells.length).toBe(2);
  });

  test("sequential runs reuse the persistent shell, so cwd and env carry across blocks", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    shells[0].emit(began("a") + ended("a"));
    drained();
    pool.run("note", "b", "source /tmp/b.sh", { client: MAC });
    expect(shells.length).toBe(1);
    expect(shells[0].written).toContain("source /tmp/b.sh");
  });

  test("runs in different notes never share a shell", () => {
    const { pool, shells } = makePool();
    pool.run("note-1", "a", "source /tmp/a.sh", { client: MAC });
    pool.run("note-2", "b", "source /tmp/b.sh", { client: MAC });
    expect(shells.length).toBe(2);
    expect(shells[0].written).not.toContain("b.sh");
    expect(shells[1].written).not.toContain("a.sh");
  });
});

describe("event routing", () => {
  test("each concurrent run's output is sliced to its own block", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    pool.run("note", "b", "source /tmp/b.sh", { client: MAC });
    shells[0].emit(began("a") + "from-a");
    shells[1].emit(began("b") + "from-b");
    const events = drained();
    const outputs = events.filter((e) => e.type === "output");
    expect(outputs.length).toBe(2);
    expect(new TextDecoder().decode(outputs.find((e) => e.blockId === "a")!.data)).toBe("from-a");
    expect(new TextDecoder().decode(outputs.find((e) => e.blockId === "b")!.data)).toBe("from-b");
  });

  test("a concurrent run can end while the first is still going", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    pool.run("note", "b", "source /tmp/b.sh", { client: MAC });
    shells[0].emit(began("a"));
    shells[1].emit(began("b") + ended("b"));
    const events = drained();
    expect(events).toContainEqual({ type: "ended", blockId: "b", exitCode: 0 });
    expect(events.filter((e) => e.type === "ended" && e.blockId === "a").length).toBe(0);
  });
});

describe("lifecycle", () => {
  test("an overflow shell is closed the moment its run ends; the persistent shell survives its own", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    pool.run("note", "b", "source /tmp/b.sh", { client: MAC });
    shells[0].emit(began("a") + ended("a"));
    shells[1].emit(began("b") + ended("b"));
    drained();
    expect(shells[0].closed).toBe(false);
    expect(shells[1].closed).toBe(true);
  });

  test("the persistent shell is free for the next run once its run ends, even with overflow still going", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    pool.run("note", "b", "source /tmp/b.sh", { client: MAC });
    shells[0].emit(began("a") + ended("a"));
    drained();
    pool.run("note", "c", "source /tmp/c.sh", { client: MAC });
    expect(shells.length).toBe(2);
    expect(shells[0].written).toContain("source /tmp/c.sh");
  });

  // running() and sessionsOpen() are the two questions the daemon asks, and
  // the gap between them is what a session hold covers. A note's shell that
  // finished its last block is not running. It still holds the cwd and the
  // exported variables a client that asked for a hold comes back to
  // (daemon.ts).
  test("a finished run leaves a session open, though nothing is running", () => {
    const { pool, shells, drained } = makePool();
    expect(pool.running()).toBe(false);
    expect(pool.sessionsOpen()).toBe(false);

    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    shells[0].emit(began("a"));
    drained();
    expect(pool.running()).toBe(true);
    expect(pool.sessionsOpen()).toBe(true);

    shells[0].emit(ended("a"));
    drained();
    expect(pool.running()).toBe(false);
    expect(pool.sessionsOpen()).toBe(true);
  });

  test("closing the note's session leaves nothing to hold", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    shells[0].emit(began("a") + ended("a"));
    drained();
    pool.closeSession("note");
    expect(pool.sessionsOpen()).toBe(false);
  });

  test("a persistent shell dying mid-block ends its run with no exit code and respawns on the next run", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    shells[0].emit(began("a"));
    drained();
    shells[0].exited = true;
    const events = drained();
    expect(events).toContainEqual({ type: "ended", blockId: "a", exitCode: null });
    expect(shells[0].closed).toBe(true);
    pool.run("note", "b", "source /tmp/b.sh", { client: MAC });
    expect(shells.length).toBe(2);
  });

  test("a shell dying before its begin marker echoed still ends the run it was written", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    shells[0].exited = true;
    const events = drained();
    expect(events).toContainEqual({ type: "ended", blockId: "a", exitCode: null });
  });

  test("an overflow shell dying mid-block ends only its own run", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    pool.run("note", "b", "source /tmp/b.sh", { client: MAC });
    shells[0].emit(began("a"));
    drained();
    shells[1].exited = true;
    const events = drained();
    expect(events).toContainEqual({ type: "ended", blockId: "b", exitCode: null });
    expect(events.filter((e) => e.type === "ended" && e.blockId === "a").length).toBe(0);
    expect(shells[0].closed).toBe(false);
  });

  test("closeSession closes every one of the note's shells and no other note's", () => {
    const { pool, shells } = makePool();
    pool.run("note-1", "a", "source /tmp/a.sh", { client: MAC });
    pool.run("note-1", "b", "source /tmp/b.sh", { client: MAC });
    pool.run("note-2", "c", "source /tmp/c.sh", { client: MAC });
    pool.closeSession("note-1");
    expect(shells[0].closed).toBe(true);
    expect(shells[1].closed).toBe(true);
    expect(shells[2].closed).toBe(false);
  });
});

describe("run-addressed plumbing", () => {
  test("cancel reaches the shell running that block and no other", () => {
    const { pool, shells } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    pool.run("note", "b", "source /tmp/b.sh", { client: MAC });
    pool.cancel("note", "b");
    expect(shells[0].interrupts).toBe(0);
    expect(shells[1].interrupts).toBe(1);
  });

  test("input reaches the shell running that block", () => {
    const { pool, shells } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    pool.run("note", "b", "source /tmp/b.sh", { client: MAC });
    pool.input("note", "b", new TextEncoder().encode("q"));
    expect(shells[1].written.endsWith("q")).toBe(true);
    expect(shells[0].written.endsWith("q")).toBe(false);
  });

  test("a resize during a run reaches that run's shell", () => {
    const { pool, shells } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    pool.run("note", "b", "source /tmp/b.sh", { client: MAC });
    pool.resize("note", "b", 100, 5);
    expect(shells[0].resizes).toEqual([]);
    expect(shells[1].resizes).toEqual([[100, 5]]);
  });

  test("a resize arriving before its run is applied when the run picks its shell", () => {
    // The panel fits itself the moment it renders, and that resize can beat
    // runBlock across the RPC.
    const { pool, shells } = makePool();
    pool.resize("note", "a", 120, 1);
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    expect(shells[0].resizes).toEqual([[120, 1]]);
  });

  test("a stashed resize is dropped once used, not replayed on a later run of the same shell", () => {
    const { pool, shells, drained } = makePool();
    pool.resize("note", "a", 120, 1);
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    shells[0].emit(began("a") + ended("a"));
    drained();
    pool.run("note", "b", "source /tmp/b.sh", { client: MAC });
    expect(shells[0].resizes).toEqual([[120, 1]]);
  });
});

describe("per-host persistent shells", () => {
  // Like makePool, but the fake spawn records which host each shell was
  // spawned for. That is what these tests check.
  function makeHostPool() {
    const shells: Array<FakeShell & { host?: string }> = [];
    const pool = new InlinePool((_sessionId, host) => {
      const s = new FakeShell() as FakeShell & { host?: string };
      s.host = host;
      shells.push(s);
      return s;
    }, NONCE);
    const drained = (): InlineEvent[] => {
      const events: InlineEvent[] = [];
      pool.drain((ev) => events.push(ev));
      return events;
    };
    return { pool, shells, drained };
  }

  test("a run with no host lands on the local shell, exactly as before hosts existed", () => {
    const { pool, shells } = makeHostPool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    expect(shells.map((s) => s.host)).toEqual(["local"]);
  });

  test("each host gets its own persistent shell, and each is reused per host", () => {
    const { pool, shells, drained } = makeHostPool();
    pool.run("note", "a", "cmd-a", { client: MAC, host: "web1" });
    shells[0].emit(began("a") + ended("a"));
    drained();
    pool.run("note", "b", "cmd-b", { client: MAC, host: "db2" });
    shells[1].emit(began("b") + ended("b"));
    drained();
    // Back to web1: its shell (with its cwd/env) is the one that runs it.
    pool.run("note", "c", "cmd-c", { client: MAC, host: "web1" });
    expect(shells.map((s) => s.host)).toEqual(["web1", "db2"]);
    expect(shells[0].written).toContain("cmd-c");
    expect(shells[1].written).not.toContain("cmd-c");
  });

  test("a run while its host's shell is busy overflows onto that same host", () => {
    const { pool, shells, drained } = makeHostPool();
    pool.run("note", "a", "cmd-a", { client: MAC, host: "web1" });
    shells[0].emit(began("a"));
    drained(); // a is mid-block on web1's persistent shell
    pool.run("note", "b", "cmd-b", { client: MAC, host: "web1" });
    expect(shells.length).toBe(2);
    expect(shells[1].host).toBe("web1");
    // The overflow shell closes when its run ends, as it does anywhere else.
    shells[1].emit(began("b") + ended("b"));
    drained();
    expect(shells[1].closed).toBe(true);
    expect(shells[0].closed).toBe(false);
  });

  test("one host's dead shell costs that host only; the other machines keep theirs", () => {
    const { pool, shells, drained } = makeHostPool();
    pool.run("note", "a", "cmd-a", { client: MAC, host: "web1" });
    shells[0].emit(began("a") + ended("a"));
    drained();
    pool.run("note", "b", "cmd-b", { client: MAC, host: "db2" });
    shells[1].emit(began("b") + ended("b"));
    drained();
    shells[0].exited = true; // web1's block ran `exit` (or ssh dropped)
    drained();
    pool.run("note", "c", "cmd-c", { client: MAC, host: "web1" });
    pool.run("note", "d", "cmd-d", { client: MAC, host: "db2" });
    // web1 respawned; db2 still on its original shell.
    expect(shells.length).toBe(3);
    expect(shells[2].host).toBe("web1");
    expect(shells[1].written).toContain("cmd-d");
  });

  test("restartSession kills every host's shell", () => {
    const { pool, shells, drained } = makeHostPool();
    pool.run("note", "a", "cmd-a", { client: MAC, host: "web1" });
    shells[0].emit(began("a") + ended("a"));
    drained();
    pool.run("note", "b", "cmd-b", { client: MAC, host: "db2" });
    shells[1].emit(began("b") + ended("b"));
    drained();
    pool.restartSession("note", () => {});
    expect(shells.every((s) => s.closed)).toBe(true);
  });
});

// A shell that cannot reach the block has usually said why, and the marker
// parser drops those bytes: they fall outside a C..D pair. These tests show
// the two ways they reach the panel anyway (inlinePool.ts): the shell stays
// silent too long (SILENT_MS), or it dies. Remote runs need it most: ssh
// talks before the shell exists (host key, passphrase, "Permission denied"),
// and without it a first run against a new host runs forever, showing nothing.
describe("a shell that never starts the block", () => {
  test("says nothing extra while it is merely starting up", () => {
    const { pool, shells, drained, clock } = makePool();
    pool.run("note", "a", "cmd", { client: MAC });
    shells[0].emit("some prompt noise\r\n");
    expect(textOf(drained())).toBe("");
    clock.t += 1000; // still well inside the grace period
    shells[0].emit(began("a") + "real output" + ended("a"));
    // The held output is dropped once the block begins. The panel shows the
    // block's own output and nothing else.
    expect(textOf(drained())).toBe("real output");
  });

  test("hands over what it said once it has been silent too long", () => {
    const { pool, shells, drained, clock } = makePool();
    pool.run("note", "a", "cmd", { client: MAC });
    shells[0].emit("The authenticity of host 'prod' can't be established.\r\n");
    drained();
    clock.t += 5000;
    expect(textOf(drained())).toContain("The authenticity of host");
  });

  test("keeps streaming after that, so a question can be answered", () => {
    // The panel takes keystrokes (pool.input), so a prompt shown there can be
    // answered. That only works if what follows the answer is shown too.
    const { pool, shells, drained, clock } = makePool();
    pool.run("note", "a", "cmd", { client: MAC });
    shells[0].emit("Are you sure you want to continue connecting? ");
    drained();
    clock.t += 5000;
    drained();
    pool.input("note", "a", new TextEncoder().encode("yes\r"));
    shells[0].emit("Warning: Permanently added 'prod'.\r\n");
    expect(textOf(drained())).toContain("Permanently added");
  });

  test("a shell that dies first reports its reason without waiting", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "cmd", { client: MAC });
    shells[0].emit("prod: Permission denied (publickey).\r\n");
    shells[0].exited = true;
    const events = drained();
    expect(textOf(events)).toContain("Permission denied");
    // The run still closes out. Otherwise the panel sits on Running forever.
    expect(events.at(-1)).toEqual({ type: "ended", blockId: "a", exitCode: null });
  });

  test("the held output is per run, not carried into the next one", () => {
    const { pool, shells, drained, clock } = makePool();
    pool.run("note", "a", "cmd-a", { client: MAC });
    shells[0].emit(began("a") + "a-out" + ended("a"));
    drained();
    shells[0].emit("prompt noise between blocks\r\n");
    drained();
    pool.run("note", "b", "cmd-b", { client: MAC });
    clock.t += 5000;
    // The noise belonged to no run, so nothing held it. Block b's silence has
    // nothing to hand over.
    expect(textOf(drained())).toBe("");
  });
});

describe("the shell's echo of what we typed", () => {
  test("is dropped from what a surfaced shell shows", () => {
    const { pool, shells, drained, clock } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    // A tty echoes every byte written to it, with a CR before each LF, and the
    // pool wrote two lines before the shell ever spoke.
    const echo = (markerInit(NONCE) + markerCommand("source /tmp/a.sh", NONCE, "a")).replace(/\n/g, "\r\n");
    shells[0].emit(echo + "Permission denied (publickey).\r\n");
    drained();
    clock.t += 5000;
    // The panel gets the shell's own message, not the marker hook.
    expect(textOf(drained())).toBe("Permission denied (publickey).\r\n");
  });

  test("a partial or mangled echo is shown rather than guessed at", () => {
    // Half a match means the rest is still arriving or came back wrapped.
    // Stripping there would eat the first line of the real message.
    const { pool, shells, drained, clock } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    shells[0].emit(markerInit(NONCE).slice(0, 40) + "\r\nsomething went wrong\r\n");
    drained();
    clock.t += 5000;
    expect(textOf(drained())).toContain("something went wrong");
  });
});

describe("stopping a run that never began", () => {
  test("ends the run and discards the shell it could not start on", () => {
    // ssh reading the block's command line as the answer to a host-key
    // question leaves a live shell that will never produce a marker. Nothing
    // else can close the run, so the block's button would stay dead.
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    drained();
    pool.cancel("note", "a");
    const events = drained();
    expect(events).toEqual([{ type: "ended", blockId: "a", exitCode: null }]);
    expect(shells[0].closed).toBe(true);
    // The next run gets a clean shell rather than that one.
    pool.run("note", "b", "source /tmp/b.sh", { client: MAC });
    expect(shells.length).toBe(2);
  });

  test("a running block is only interrupted, and keeps its shell", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    shells[0].emit(began("a"));
    drained();
    pool.cancel("note", "a");
    expect(shells[0].interrupts).toBe(1);
    expect(drained()).toEqual([]);
    expect(shells[0].closed).toBe(false);
    // The shell reports the interrupt itself, as 130.
    shells[0].emit(ended("a", 130));
    expect(drained()).toEqual([{ type: "ended", blockId: "a", exitCode: 130 }]);
  });
});

describe("claiming what a client can still show", () => {
  test("stops the runs the claim leaves out and reports the ones it keeps", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    pool.run("other", "b", "source /tmp/b.sh", { client: MAC });
    shells[0].emit(began("a"));
    shells[1].emit(began("b"));
    drained();

    expect(pool.claim(MAC, ["a"])).toEqual({ running: ["a"], orphaned: ["b"] });
    expect(shells[0].interrupts).toBe(0);
    expect(shells[1].interrupts).toBe(1);
  });

  test("a page that reloaded claims nothing, and everything stops", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    shells[0].emit(began("a"));
    drained();

    expect(pool.claim(MAC, []).orphaned).toEqual(["a"]);
    expect(shells[0].interrupts).toBe(1);
    // An interrupt, not a teardown. The shell keeps the cwd and the exports
    // the last block left it. That state is what a session hold keeps for a
    // client that comes back (daemon.ts).
    expect(shells[0].closed).toBe(false);
    shells[0].emit(ended("a", 130));
    expect(drained()).toEqual([{ type: "ended", blockId: "a", exitCode: 130 }]);
  });

  test("an unclaimed run that never began is closed out, shell and all", () => {
    // Same pair as cancel: no job to signal and no marker coming, so the pool
    // is the only thing that can end this run.
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    drained();

    expect(pool.claim(MAC, []).orphaned).toEqual(["a"]);
    expect(drained()).toEqual([{ type: "ended", blockId: "a", exitCode: null }]);
    expect(shells[0].closed).toBe(true);
  });

  test("a claim for a run that already ended is simply not confirmed", () => {
    // The client still shows a panel because the ended event went out over a
    // wire that was down. There is nothing to stop. The answer leaves the run
    // out of both lists, and the client takes that as the end.
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    shells[0].emit(began("a") + ended("a", 0));
    drained();

    expect(pool.claim(MAC, ["a"])).toEqual({ running: [], orphaned: [] });
    expect(shells[0].interrupts).toBe(0);
  });

  test("an idle pool answers a claim without stopping anything", () => {
    const { pool } = makePool();
    expect(pool.claim(MAC, [])).toEqual({ running: [], orphaned: [] });
  });

  test("reaches the overflow shell a second concurrent run got", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    shells[0].emit(began("a"));
    drained();
    pool.run("note", "b", "source /tmp/b.sh", { client: MAC });
    shells[1].emit(began("b"));
    drained();

    expect(pool.claim(MAC, ["a"]).orphaned).toEqual(["b"]);
    expect(shells[0].interrupts).toBe(0);
    expect(shells[1].interrupts).toBe(1);
    // The overflow shell goes with its run, as it does on any other end.
    shells[1].emit(ended("b", 130));
    drained();
    expect(shells[1].closed).toBe(true);
  });
});

describe("runs belong to the client that started them", () => {
  test("a claim does not collect another client's runs", () => {
    // A phone finishing its boot must not interrupt the build a Mac is
    // watching. The phone cannot show that run, cannot stop it, and was never
    // told it existed.
    const { pool, shells, drained } = makePool();
    pool.run("note", "mac-build", "source /tmp/a.sh", { client: MAC });
    shells[0].emit(began("mac-build"));
    drained();

    expect(pool.claim(PHONE, [])).toEqual({ running: [], orphaned: [] });
    expect(shells[0].interrupts).toBe(0);
  });

  test("and does not report them as running either", () => {
    // The same scoping, in the reporting direction. A phone asking about an id
    // it did not start could only be a collision, and answering "yes, running"
    // would hand it a panel over another client's shell.
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    shells[0].emit(began("a"));
    drained();

    expect(pool.claim(PHONE, ["a"])).toEqual({ running: [], orphaned: [] });
    expect(shells[0].interrupts).toBe(0);
  });

  test("each client's own orphans are still collected, in the same note", () => {
    // Scoping by client changes nothing within a client: a client's own
    // unclaimed runs are still interrupted. Two clients running blocks in one
    // note get two shells, not a shared one.
    const { pool, shells, drained } = makePool();
    pool.run("note", "mine", "source /tmp/a.sh", { client: MAC });
    shells[0].emit(began("mine"));
    drained();
    pool.run("note", "theirs", "source /tmp/b.sh", { client: PHONE });
    shells[1].emit(began("theirs"));
    drained();

    expect(pool.claim(MAC, [])).toEqual({ running: [], orphaned: ["mine"] });
    expect(shells[0].interrupts).toBe(1);
    expect(shells[1].interrupts).toBe(0);

    expect(pool.claim(PHONE, [])).toEqual({ running: [], orphaned: ["theirs"] });
    expect(shells[1].interrupts).toBe(1);
  });

  test("a persistent shell carries whoever's block it is running now", () => {
    // The slot outlives the run, so the client belongs to the run and not to
    // the shell. Sequential blocks from two clients reuse one shell, and each
    // claim has to see the run that is in it now.
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    shells[0].emit(began("a") + ended("a"));
    drained();
    pool.run("note", "b", "source /tmp/b.sh", { client: PHONE });
    shells[0].emit(began("b"));
    drained();
    expect(shells.length).toBe(1);

    expect(pool.claim(MAC, [])).toEqual({ running: [], orphaned: [] });
    expect(shells[0].interrupts).toBe(0);
    expect(pool.claim(PHONE, ["b"])).toEqual({ running: ["b"], orphaned: [] });
  });

  test("clients with no id of their own share one bucket", () => {
    // Clients with no id share one layout key too (bun/layout.ts). Two of them
    // cannot be told apart, so they collect each other's runs. That is the
    // answer the pool gave every client before it recorded who started a run.
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: "" });
    shells[0].emit(began("a"));
    drained();

    expect(pool.claim("", []).orphaned).toEqual(["a"]);
    expect(shells[0].interrupts).toBe(1);
  });
});

// The drain loop runs fast while bytes are moving and backs off when they are
// not (bun/server.ts). These are the two answers the pool owes it: whether any
// shell spoke, and whether any shell still has input the tty has not taken.
// Getting either wrong stalls rather than crashes: output arrives late, or
// never, with nothing in the log.
describe("what the drain loop reads to set its cadence", () => {
  test("drain reports whether any shell spoke", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });

    // The spawn wrote the marker hook, but nothing has come back yet.
    expect(pool.drain(() => {})).toBe(false);

    shells[0].emit(began("a") + "hello");
    expect(pool.drain(() => {})).toBe(true);

    // Drained dry: silent again, even with the run still open.
    expect(pool.drain(() => {})).toBe(false);
    expect(pool.running()).toBe(true);

    shells[0].emit(ended("a"));
    drained();
    expect(pool.running()).toBe(false);
  });

  test("a shell the tty has not taken all of keeps the pool pending", () => {
    const { pool, shells } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });

    expect(pool.pending()).toBe(false);
    // A paste into a program reading with echo off: nothing comes back, so
    // this is the only sign the loop gets that it must not slow down.
    shells[0].pending = true;
    expect(pool.pending()).toBe(true);
    shells[0].pending = false;
    expect(pool.pending()).toBe(false);
  });

  test("a pool with no shells is silent and has nothing pending", () => {
    const { pool } = makePool();
    expect(pool.drain(() => {})).toBe(false);
    expect(pool.pending()).toBe(false);
    expect(pool.sessionsOpen()).toBe(false);
  });

  test("a shell too old to report pending never holds the loop fast", () => {
    // `pending` is optional on InlineShellIO. A shell that does not report it
    // never keeps the loop at its fast cadence. It does not force the loop to
    // slow down either: pending() is true as soon as any shell reports
    // pending.
    const { pool, shells } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });
    delete (shells[0] as { pending?: boolean }).pending;
    expect(pool.pending()).toBe(false);
  });
});

// The hook that ends blocks, and what happens to a shell that never got it. A
// pty discards whatever is queued when its line discipline comes up, and the
// hook used to be written on its own at spawn. A shell that lost the hook
// still began and printed every block it ran. It could never end one, so the
// panel sat on "Running" with the shell's own prompt inside (bun/markers.ts).
describe("installing the hook that ends a block", () => {
  test("it rides on the block's own line, so the two cannot be separated", () => {
    const { pool, shells } = makePool();
    pool.run("note", "a", "source /tmp/a.sh", { client: MAC });

    // One write, and the hook is in front of the block within it.
    expect(shells[0].writes).toEqual([markerInit(NONCE) + markerCommand("source /tmp/a.sh", NONCE, "a")]);
  });

  test("a shell that has acked is not sent it again", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "cmd-a", { client: MAC });
    shells[0].emit(began("a") + ended("a"));
    drained();

    pool.run("note", "b", "cmd-b", { client: MAC });
    expect(shells.length).toBe(1);
    expect(shells[0].writes[1]).toBe(markerCommand("cmd-b", NONCE, "b"));
    expect(shells[0].writes[1]).not.toContain("__ledge_precmd");
  });

  test("a shell that never acked is sent it again with the next block", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "cmd-a", { client: MAC });
    // The line arrived damaged: the block runs and ends, the hook never landed.
    // A real shell could not end a block without the hook, so this fake is
    // contrived. What it pins is that the pool keeps offering the hook.
    shells[0].emit(unhooked("a") + ended("a"));
    drained();

    pool.run("note", "b", "cmd-b", { client: MAC });
    expect(shells[0].writes[1]).toBe(markerInit(NONCE) + markerCommand("cmd-b", NONCE, "b"));
  });

  test("the ack is the pool's business and is never sent on to a client", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "cmd-a", { client: MAC });
    shells[0].emit(ready);
    // Nothing for a panel to show, and no client could act on it.
    expect(drained()).toEqual([]);
  });

  test("stop ends a block that began on a shell with no hook", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "cmd-a", { client: MAC });
    // The ack comes before the start marker in the same write, so a start
    // marker without one is damage rather than a race: no prompt on this shell
    // will ever report a D, and the block would sit on "Running" for good.
    shells[0].emit(unhooked("a"));
    drained();

    pool.cancel("note", "a");
    expect(shells[0].interrupts).toBe(1);
    // The pool closes the run out, since nothing else can. The shell goes with
    // it rather than serving the next block from an unknown state.
    expect(drained()).toEqual([{ type: "ended", blockId: "a", exitCode: null }]);
    expect(shells[0].closed).toBe(true);
  });

  test("a healthy running block is still only interrupted", () => {
    // The guard on the rule above. An acked shell reports its own 130, and
    // closing the run out here would replace that with a null exit code.
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "cmd-a", { client: MAC });
    shells[0].emit(began("a"));
    drained();

    pool.cancel("note", "a");
    expect(drained()).toEqual([]);
    expect(shells[0].closed).toBe(false);
    shells[0].emit(ended("a", 130));
    expect(drained()).toEqual([{ type: "ended", blockId: "a", exitCode: 130 }]);
  });
});
