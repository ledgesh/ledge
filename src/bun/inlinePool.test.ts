import { describe, expect, test } from "bun:test";
import { InlinePool, type InlineEvent, type InlineShellIO } from "./inlinePool";
import { markerInit } from "./markers";

const NONCE = "testnonce";

// The byte stream a real shell would echo back: OSC 133 C when a block starts,
// D with the exit status when its prompt returns (see markers.ts).
const began = (id: string) => `\x1b]133;C;ledge=${NONCE}:${id}\x07`;
const ended = (id: string, code = 0) => `\x1b]133;D;${code};ledge=${NONCE}:${id}\x07`;

class FakeShell implements InlineShellIO {
  written = "";
  resizes: Array<[number, number]> = [];
  interrupts = 0;
  closed = false;
  exited = false;
  private queue: Uint8Array[] = [];

  write(data: string | Uint8Array): void {
    this.written += typeof data === "string" ? data : new TextDecoder().decode(data);
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
  const pool = new InlinePool(() => {
    const s = new FakeShell();
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

describe("restartSession", () => {
  test("kills the shells and the next run gets a fresh one", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh");
    shells[0].emit(began("a") + ended("a"));
    drained();

    pool.restartSession("note", () => {});
    expect(shells[0].closed).toBe(true);

    pool.run("note", "b", "source /tmp/b.sh");
    expect(shells.length).toBe(2);
    // A fresh shell, fully re-primed: the marker hook lives in the dead zsh.
    expect(shells[1].written.startsWith(markerInit(NONCE))).toBe(true);
  });

  test("open runs are closed out through emit, overflow included", () => {
    // The tab is still open and watching (unlike closeSession): a run left
    // un-ended would sit on "Running" with a dead run button forever.
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh");
    shells[0].emit(began("a"));
    drained();
    pool.run("note", "b", "source /tmp/b.sh"); // overflow: a still running

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
    pool.run("note", "a", "source /tmp/a.sh");
    shells[0].emit(began("a") + ended("a"));
    drained();

    const events: InlineEvent[] = [];
    pool.restartSession("note", (ev) => events.push(ev));
    pool.restartSession("never-seen", (ev) => events.push(ev));
    expect(events).toEqual([]);
  });

  test("a resize stashed for a not-yet-started run dies with the restart", () => {
    // The pre-run resize was measured against panels of the session being torn
    // down; applying it to a post-restart shell would be a stale grid.
    const { pool, shells } = makePool();
    pool.resize("note", "x", 33, 7);
    pool.restartSession("note", () => {});
    pool.run("note", "x", "source /tmp/x.sh");
    expect(shells[0].resizes).toEqual([]);
  });
});

describe("shell selection", () => {
  test("the first run goes to the note's persistent shell, primed with the marker hook", () => {
    const { pool, shells } = makePool();
    pool.run("note", "a", "source /tmp/a.sh");
    expect(shells.length).toBe(1);
    expect(shells[0].written.startsWith(markerInit(NONCE))).toBe(true);
    expect(shells[0].written).toContain("source /tmp/a.sh");
  });

  test("every spawn is told which session it is for, overflow included", () => {
    // The spawn uses it to give the shell that note's params (frontmatter cwd/
    // env); an overflow shell for the same note must be born with the same ones.
    const spawnedFor: string[] = [];
    const pool = new InlinePool((sessionId) => {
      spawnedFor.push(sessionId);
      return new FakeShell();
    }, NONCE);
    pool.run("note-1", "a", "source /tmp/a.sh");
    pool.run("note-1", "b", "source /tmp/b.sh"); // overflow: a is still running
    expect(spawnedFor).toEqual(["note-1", "note-1"]);
  });

  test("a second run while the first is still going gets an overflow shell of its own", () => {
    const { pool, shells } = makePool();
    pool.run("note", "a", "source /tmp/a.sh");
    pool.run("note", "b", "source /tmp/b.sh");
    expect(shells.length).toBe(2);
    // Nothing of b's may reach the busy shell: its echo would land in a's output.
    expect(shells[0].written).not.toContain("b.sh");
    expect(shells[1].written).toContain("source /tmp/b.sh");
  });

  test("a second run picks the overflow shell even before the first's begin marker echoes back", () => {
    // The write happens now; the C marker echoes back later. The busy check must
    // not depend on the echo or two rapid runs would share the shell.
    const { pool, shells } = makePool();
    pool.run("note", "a", "source /tmp/a.sh");
    // No drain between the two runs: shell 0 has echoed nothing yet.
    pool.run("note", "b", "source /tmp/b.sh");
    expect(shells.length).toBe(2);
  });

  test("sequential runs reuse the persistent shell, so cwd and env carry across blocks", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh");
    shells[0].emit(began("a") + ended("a"));
    drained();
    pool.run("note", "b", "source /tmp/b.sh");
    expect(shells.length).toBe(1);
    expect(shells[0].written).toContain("source /tmp/b.sh");
  });

  test("runs in different notes never share a shell", () => {
    const { pool, shells } = makePool();
    pool.run("note-1", "a", "source /tmp/a.sh");
    pool.run("note-2", "b", "source /tmp/b.sh");
    expect(shells.length).toBe(2);
    expect(shells[0].written).not.toContain("b.sh");
    expect(shells[1].written).not.toContain("a.sh");
  });
});

describe("event routing", () => {
  test("each concurrent run's output is sliced to its own block", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh");
    pool.run("note", "b", "source /tmp/b.sh");
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
    pool.run("note", "a", "source /tmp/a.sh");
    pool.run("note", "b", "source /tmp/b.sh");
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
    pool.run("note", "a", "source /tmp/a.sh");
    pool.run("note", "b", "source /tmp/b.sh");
    shells[0].emit(began("a") + ended("a"));
    shells[1].emit(began("b") + ended("b"));
    drained();
    expect(shells[0].closed).toBe(false);
    expect(shells[1].closed).toBe(true);
  });

  test("the persistent shell is free for the next run once its run ends, even with overflow still going", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh");
    pool.run("note", "b", "source /tmp/b.sh");
    shells[0].emit(began("a") + ended("a"));
    drained();
    pool.run("note", "c", "source /tmp/c.sh");
    expect(shells.length).toBe(2);
    expect(shells[0].written).toContain("source /tmp/c.sh");
  });

  test("a persistent shell dying mid-block ends its run with no exit code and respawns on the next run", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh");
    shells[0].emit(began("a"));
    drained();
    shells[0].exited = true;
    const events = drained();
    expect(events).toContainEqual({ type: "ended", blockId: "a", exitCode: null });
    expect(shells[0].closed).toBe(true);
    pool.run("note", "b", "source /tmp/b.sh");
    expect(shells.length).toBe(2);
  });

  test("a shell dying before its begin marker echoed still ends the run it was written", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh");
    shells[0].exited = true;
    const events = drained();
    expect(events).toContainEqual({ type: "ended", blockId: "a", exitCode: null });
  });

  test("an overflow shell dying mid-block ends only its own run", () => {
    const { pool, shells, drained } = makePool();
    pool.run("note", "a", "source /tmp/a.sh");
    pool.run("note", "b", "source /tmp/b.sh");
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
    pool.run("note-1", "a", "source /tmp/a.sh");
    pool.run("note-1", "b", "source /tmp/b.sh");
    pool.run("note-2", "c", "source /tmp/c.sh");
    pool.closeSession("note-1");
    expect(shells[0].closed).toBe(true);
    expect(shells[1].closed).toBe(true);
    expect(shells[2].closed).toBe(false);
  });
});

describe("run-addressed plumbing", () => {
  test("cancel reaches the shell running that block and no other", () => {
    const { pool, shells } = makePool();
    pool.run("note", "a", "source /tmp/a.sh");
    pool.run("note", "b", "source /tmp/b.sh");
    pool.cancel("note", "b");
    expect(shells[0].interrupts).toBe(0);
    expect(shells[1].interrupts).toBe(1);
  });

  test("input reaches the shell running that block", () => {
    const { pool, shells } = makePool();
    pool.run("note", "a", "source /tmp/a.sh");
    pool.run("note", "b", "source /tmp/b.sh");
    pool.input("note", "b", new TextEncoder().encode("q"));
    expect(shells[1].written.endsWith("q")).toBe(true);
    expect(shells[0].written.endsWith("q")).toBe(false);
  });

  test("a resize during a run reaches that run's shell", () => {
    const { pool, shells } = makePool();
    pool.run("note", "a", "source /tmp/a.sh");
    pool.run("note", "b", "source /tmp/b.sh");
    pool.resize("note", "b", 100, 5);
    expect(shells[0].resizes).toEqual([]);
    expect(shells[1].resizes).toEqual([[100, 5]]);
  });

  test("a resize arriving before its run is applied when the run picks its shell", () => {
    // The panel fits itself the moment it renders, and that resize can beat
    // runBlock across the RPC.
    const { pool, shells } = makePool();
    pool.resize("note", "a", 120, 1);
    pool.run("note", "a", "source /tmp/a.sh");
    expect(shells[0].resizes).toEqual([[120, 1]]);
  });

  test("a stashed resize is dropped once used, not replayed on a later run of the same shell", () => {
    const { pool, shells, drained } = makePool();
    pool.resize("note", "a", 120, 1);
    pool.run("note", "a", "source /tmp/a.sh");
    shells[0].emit(began("a") + ended("a"));
    drained();
    pool.run("note", "b", "source /tmp/b.sh");
    expect(shells[0].resizes).toEqual([[120, 1]]);
  });
});
