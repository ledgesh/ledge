// Lining this client's runs up with the server's (bridge.ts reconcileRuns).
// A panel is the only record a run has on this side, and panels do not
// survive a reload. On the server the run is a process. The two ends drift
// both ways. Fake sinks stand in for mounted editors: a run the server is
// still running that nobody here can show, and a run shown here that the
// server finished while the wire was down.
import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../../shared/rpc-schema";
import { configureBridge, dispatchRunEvent, dispatchRunLink, onRunEvent, reconcileRuns, type RunSink } from "./bridge";

// One mounted editor: the runs it shows, and what it was told about them.
function fakeEditor(live: string[]) {
  const applied: RunEvent[] = [];
  const links: boolean[] = [];
  const sink: RunSink = { apply: (ev) => applied.push(ev), live: () => live, link: (up) => links.push(up) };
  return { sink, applied, links, off: onRunEvent(sink) };
}

// The server's half. It answers claimRuns with `running`, and the array it
// returns collects the ids from every call.
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

    // One claim per run: reconcileRuns puts every sink's live() through a Set
    // (bridge.ts), so the "r2" both fake editors list is asked about once. In
    // the app a note has a single view (workspace/editorPool.ts, tree.ts
    // findTabBy) and a run id lives in one view's panels, so the Set guards a
    // case that does not arise.
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

    // Closed out as ended with no exit status. The run finished while nobody
    // here was listening, so there is no code to report.
    expect(editor.applied).toEqual([{ id: "gone", kind: "ended", exitCode: null }]);
    editor.off();
  });

  // The answer can arrive behind output the server held for this client
  // (remote.md §7), and that output may include the `ended` that closed a run
  // out with its real exit code. reconcileRuns asks the editors again for that
  // reason: a run the release already ended is no longer live, so the blank
  // "Session ended" does not land on top of the exit code.
  test("a run the released gap already ended is not ended a second time", async () => {
    const live = ["finished", "alive"];
    const editor = fakeEditor(live);
    configureBridge({
      claimRuns: (ids) => {
        // The splice stands in for the released output: the panel took its
        // ending, and the run is gone from this editor's live list.
        expect(ids).toEqual(["finished", "alive"]);
        live.splice(live.indexOf("finished"), 1);
        return Promise.resolve(["alive"]);
      },
    });

    await reconcileRuns();

    expect(editor.applied).toEqual([]);
    editor.off();
  });

  test("a page that reloaded claims nothing and closes out nothing", async () => {
    const claims = fakeServer([]);

    // The boot call sends an empty claim rather than skipping it. That tells
    // the server every run it holds for this client is an orphan, and
    // inlinePool.claim interrupts every run a claim leaves out.
    await reconcileRuns();

    expect(claims).toEqual([[]]);
  });

  test("an editor that unregistered is not claimed for", async () => {
    const editor = fakeEditor(["r1"]);
    editor.off();
    const claims = fakeServer([]);

    await reconcileRuns();

    // A relock destroys the view and its panels with it (editorPool.ts).
    // Claiming those runs would keep processes alive that nobody can see.
    expect(claims).toEqual([[]]);
    expect(editor.applied).toEqual([]);
  });

  test("a claim the wire loses changes nothing on either side", async () => {
    const editor = fakeEditor(["r1"]);
    fakeServer(new Error("the connection dropped"));

    await reconcileRuns();

    // Not closed out: the panel is still the only record this side has of the
    // run, and the connection that replaces this one asks again.
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

  test("the link going and coming back reaches every sink too", () => {
    const a = fakeEditor([]);
    const b = fakeEditor([]);

    dispatchRunLink(false);
    dispatchRunLink(true);

    // Every sink, not just the note in front. A run outlives the tab it is
    // watched in, so a background note's panel shows the outage too.
    expect(a.links).toEqual([false, true]);
    expect(b.links).toEqual([false, true]);
    a.off();
    b.off();
  });

  test("a run this client is unsure about is still claimed", async () => {
    // What `live()` returns after an outage. runningRunIds counts "unknown"
    // runs as well as running ones (blocks.ts), because the server interrupts
    // every run a claim leaves out (inlinePool.claim). Naming only the certain
    // ones would kill the runs the outage made uncertain.
    const editor = fakeEditor(["r1"]);
    const claims = fakeServer(["r1"]);

    dispatchRunLink(false);
    await reconcileRuns();

    expect(claims).toEqual([["r1"]]);
    expect(editor.applied).toEqual([]);
    editor.off();
  });
});
