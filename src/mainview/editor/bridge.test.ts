// Lining this client's runs up with the server's (bridge.ts reconcileRuns).
//
// A run exists on this side only as a panel, and panels do not survive a
// reload; on the other side it is a process. The two can therefore disagree in
// both directions, and both are covered here with fake sinks standing in for
// mounted editors: an id the server is running that nobody here can show, and
// an id shown here that the server finished while the wire was down.
import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../../shared/rpc-schema";
import { configureBridge, dispatchRunEvent, onRunEvent, reconcileRuns, type RunSink } from "./bridge";

// One mounted editor: the runs it shows, and what it was told about them.
function fakeEditor(live: string[]) {
  const applied: RunEvent[] = [];
  const sink: RunSink = { apply: (ev) => applied.push(ev), live: () => live };
  return { sink, applied, off: onRunEvent(sink) };
}

// The server's half: what it was asked, and what it admits to running.
function fakeServer(running: string[] | Error) {
  const claims: string[][] = [];
  configureBridge({
    claimRuns: (ids) => {
      claims.push([...ids]);
      return running instanceof Error ? Promise.reject(running) : Promise.resolve(running);
    },
  });
  return claims;
}

describe("reconcileRuns", () => {
  test("claims every editor's runs, once each", async () => {
    const a = fakeEditor(["r1", "r2"]);
    const b = fakeEditor(["r2", "r3"]);
    const claims = fakeServer(["r1", "r2", "r3"]);

    await reconcileRuns();

    // Deduped: one run's panel can be looked at through two panes, and asking
    // about it twice would invite two answers about one process.
    expect(claims).toEqual([["r1", "r2", "r3"]]);
    expect(a.applied).toEqual([]);
    expect(b.applied).toEqual([]);
    a.off();
    b.off();
  });

  test("closes out a run the server is no longer running", async () => {
    const editor = fakeEditor(["gone", "alive"]);
    fakeServer(["alive"]);

    await reconcileRuns();

    // No exit status, because there is none to report: what happened to this
    // run happened while nobody was listening.
    expect(editor.applied).toEqual([{ id: "gone", kind: "ended", exitCode: null }]);
    editor.off();
  });

  test("a page that reloaded claims nothing and closes out nothing", async () => {
    const claims = fakeServer([]);

    // The empty claim is the whole point of the boot call, so it is sent
    // rather than skipped: it is what tells the server its runs are orphans.
    await reconcileRuns();

    expect(claims).toEqual([[]]);
  });

  test("an editor that unregistered is not claimed for", async () => {
    const editor = fakeEditor(["r1"]);
    editor.off();
    const claims = fakeServer([]);

    await reconcileRuns();

    // A relock destroys the view and its panels with it; claiming those runs
    // would keep alive exactly what nobody can see.
    expect(claims).toEqual([[]]);
    expect(editor.applied).toEqual([]);
  });

  test("a claim the wire loses changes nothing on either side", async () => {
    const editor = fakeEditor(["r1"]);
    fakeServer(new Error("the connection dropped"));

    await reconcileRuns();

    // Not closed out: the panel is still the truth as far as anyone knows, and
    // the connection that replaces this one asks again.
    expect(editor.applied).toEqual([]);
    editor.off();
  });

  test("dispatch reaches every sink, reconcile or not", () => {
    const a = fakeEditor([]);
    const b = fakeEditor([]);
    dispatchRunEvent({ id: "r1", kind: "began" });
    expect(a.applied).toEqual([{ id: "r1", kind: "began" }]);
    expect(b.applied).toEqual([{ id: "r1", kind: "began" }]);
    a.off();
    b.off();
  });
});
