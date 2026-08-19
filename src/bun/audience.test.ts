// Push routing, which is the one thing the daemon and the app's own shell do
// identically once a server has more than one client (remote.md §7, §8a).
//
// The failures worth catching are all about WHEN the set is read: a server
// outlives every connection and every window it was built with, so an audience
// that captured its clients would push at whoever was there when createServer
// ran.
import { describe, expect, test } from "bun:test";
import { audienceOf, fanout } from "./audience";
import type { ServerPush } from "../shared/wire";

// A push object that records what it was asked to send, so "who got it" is a
// list rather than a mock framework.
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

  // Nobody attached is the ORDINARY case, not an edge: the watcher fires
  // whenever a file moves and a run keeps producing output, both of them
  // happily while every window is closed.
  test("a push with nobody there is dropped, not an error", () => {
    fanout(() => []).vaultChanged({ state: "locked" });
  });

  // The whole reason this is a picker and not a list.
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

  // A drawer's bytes addressed at a window that closed have nowhere to go, and
  // that is not a failure — the state they described is re-read at the next
  // window's boot.
  test("a push addressed to a client that is not here is dropped", () => {
    const sent: string[] = [];
    const clients = new Map([["mac", recorder("mac", sent)]]);
    audienceOf(clients, (held) => held)
      .to("gone")
      .terminalExit({ sessionId: "s1" });
    expect(sent).toEqual([]);
  });

  // `to` memoizes one object per client id, and that object has to keep working
  // across a client leaving and coming back under the same id — which is what a
  // reconnect is, and what re-selecting a connection whose wire gave up is.
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

  // The one question a caller asks before pushing rather than after, and it
  // exists for run output alone: dropping a state is fine because the next
  // connection re-reads it, and dropping a sequence loses it (server.ts
  // sendRunEvent). Read live, not memoized like `to`, since the whole point is
  // that the answer changes when a client leaves.
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
