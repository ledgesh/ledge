// Tests for push routing, the one thing the daemon and the app's own shell do
// identically once a server has more than one client (remote.md §7, §8a).
// Every test here is about when the client set is read. A server outlives
// every connection and window it was built with, so an audience that captured
// its clients would push at whoever was there when createServer ran.
import { describe, expect, test } from "bun:test";
import { audienceOf, fanout } from "./audience";
import type { ServerPush } from "../shared/wire";

// A push object that records what it was asked to send. That makes "who got
// it" a list of strings to compare, so these tests need no mock framework.
function recorder(name: string, into: string[]): ServerPush {
  return new Proxy({} as ServerPush, {
    get: (_t, method: string) => () => into.push(`${name}:${method}`),
  });
}

describe("fanout", () => {
  test("every push reaches everyone the picker names", () => {
    const sent: string[] = [];
    const one = recorder("a", sent);
    const two = recorder("b", sent);
    fanout(() => [one, two]).notesChanged({ root: "/notes" });
    expect(sent).toEqual(["a:notesChanged", "b:notesChanged"]);
  });

  // Nobody attached is the ordinary case, not an edge. With every window
  // closed, the watcher still fires whenever a file moves, and a run still
  // produces output.
  test("a push with nobody there is dropped, not an error", () => {
    fanout(() => []).vaultChanged({ state: "locked" });
  });

  // fanout takes a picker rather than a list of push objects so the set is
  // read at push time.
  test("the set is read at push time, not at build time", () => {
    const sent: string[] = [];
    let here: ServerPush[] = [];
    const push = fanout(() => here);
    push.notesChanged({ root: "/notes" });
    here = [recorder("late", sent)];
    push.notesChanged({ root: "/notes" });
    expect(sent).toEqual(["late:notesChanged"]);
  });
});

describe("audienceOf", () => {
  test("all reaches every client and to reaches exactly one", () => {
    const sent: string[] = [];
    const clients = new Map([
      ["mac", recorder("mac", sent)],
      ["phone", recorder("phone", sent)],
    ]);
    const push = audienceOf(clients, (held) => held);

    push.all.notesChanged({ root: "/notes" });
    expect(sent).toEqual(["mac:notesChanged", "phone:notesChanged"]);

    sent.length = 0;
    push.to("phone").terminalExit({ sessionId: "s1" });
    expect(sent).toEqual(["phone:terminalExit"]);
  });

  // A drawer's bytes addressed at a window that closed have nowhere to go.
  // That is not a failure: the next window boots and re-reads the state those
  // bytes described.
  test("a push addressed to a client that is not here is dropped", () => {
    const sent: string[] = [];
    const clients = new Map([["mac", recorder("mac", sent)]]);
    audienceOf(clients, (held) => held)
      .to("gone")
      .terminalExit({ sessionId: "s1" });
    expect(sent).toEqual([]);
  });

  // `to` memoizes one object per client id. That object has to keep working
  // across a client leaving and coming back under the same id. A reconnect
  // leaves and comes back that way, and so does re-selecting a connection
  // whose wire gave up.
  test("an address outlives the client it names leaving and returning", () => {
    const sent: string[] = [];
    const clients = new Map<string, ServerPush>();
    const push = audienceOf(clients, (held) => held);
    const addressed = push.to("mac");

    addressed.terminalExit({ sessionId: "s1" });
    expect(sent).toEqual([]);

    clients.set("mac", recorder("first", sent));
    addressed.terminalExit({ sessionId: "s1" });
    clients.set("mac", recorder("second", sent));
    addressed.terminalExit({ sessionId: "s1" });
    expect(sent).toEqual(["first:terminalExit", "second:terminalExit"]);
  });

  test("the same id gives back the same address object, once", () => {
    const push = audienceOf(new Map<string, ServerPush>(), (held) => held);
    expect(push.to("mac")).toBe(push.to("mac"));
    expect(push.to("mac")).not.toBe(push.to("phone"));
  });

  // `has` is the one question a caller asks before pushing rather than after,
  // and only run output needs it (server.ts sendRunEvent is the one caller).
  // A dropped state push is fine: the next connection re-reads that state. A
  // dropped run event is lost, so sendRunEvent holds the event for that
  // client instead. `has` reads the answer live rather than memoizing it like
  // `to` does, because the answer changes when a client leaves.
  test("has says whether that client is here, now", () => {
    const clients = new Map<string, ServerPush>();
    const push = audienceOf(clients, (held) => held);
    expect(push.has("mac")).toBe(false);

    clients.set("mac", recorder("mac", []));
    expect(push.has("mac")).toBe(true);
    expect(push.has("phone")).toBe(false);

    clients.delete("mac");
    expect(push.has("mac")).toBe(false);
  });
});
