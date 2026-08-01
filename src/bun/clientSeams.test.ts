// The seams the client keeps (remote.md §10). Two of the five reach the real
// pasteboard, so what is tested here is everything around them: the list both
// ends read, the gate that decides whether a paste pays for an osascript
// spawn, and the guard on link opening. Nothing in this file writes the
// clipboard or opens a browser — a test suite that clobbered the user's
// pasteboard would be worse than the bug it was looking for.
import { describe, expect, test } from "bun:test";
import { CLIENT_METHODS, clientSeams, NATIVE_METHODS, wantsHtml } from "./clientSeams";
import { CONNECTION_METHODS } from "./connectionManager";

describe("the client's methods", () => {
  // NATIVE_METHODS is what clientSeams implements; CLIENT_METHODS is what the
  // server refuses, which is that plus the connection list
  // (bun/connectionManager.ts implements those). A name in one and not the
  // other is a method served by nobody or refused by everybody.
  test("the native list and its implementations name the same five", () => {
    expect(Object.keys(clientSeams({})).sort()).toEqual([...NATIVE_METHODS].sort());
  });

  test("what the server refuses is the native seams plus the connection list", () => {
    expect([...CLIENT_METHODS].sort()).toEqual([...NATIVE_METHODS, ...CONNECTION_METHODS].sort());
  });

  test("nothing is listed twice", () => {
    expect(new Set(CLIENT_METHODS).size).toBe(CLIENT_METHODS.length);
  });
});

describe("the rich-paste gate", () => {
  test("HTML on the pasteboard is read", () => {
    expect(wantsHtml(["public.utf8-plain-text", "html"])).toBe(true);
  });

  // The common case, and the one the gate exists for: a copy made inside Ledge
  // (pbcopy writes text alone) must not cost an osascript spawn per ⌘V.
  test("text alone skips the spawn", () => {
    expect(wantsHtml(["public.utf8-plain-text"])).toBe(false);
  });

  // Both spellings of "we could not tell": the flavor list is an optional
  // native seam, and being wrong here has to cost latency rather than the
  // paste itself.
  test.each([
    [null, "no format list at all"],
    [[], "an empty one"],
  ])("%p (%s) asks the pasteboard anyway", (formats) => {
    expect(wantsHtml(formats)).toBe(true);
  });
});

describe("opening a link", () => {
  // `open` treats a non-URL argument as a file path and will launch an .app
  // bundle, so this guard is the boundary, not a nicety — and the urls arrive
  // from note text, which is to say from anywhere. A refusal returns rather
  // than throws: the view has nothing useful to do with the exception.
  test.each([
    ["javascript:alert(1)", "script"],
    ["file:///Applications/Calculator.app", "a local file"],
    ["/Applications/Calculator.app", "a bare path"],
    ["", "nothing at all"],
  ])("%p (%s) is refused", async (url) => {
    expect(await clientSeams({}).linkOpen({ url })).toEqual({ ok: false });
  });
});

describe("the native halves", () => {
  // Both are optional because a client that is not macOS has neither, and the
  // one that matters is the menu: a shell with no setMenu must still answer
  // menuSet, or every menu push the view makes turns into an unhandled
  // rejection.
  test("menuSet answers with no platform to hand the menu to", async () => {
    expect(await clientSeams({}).menuSet({ items: [] })).toEqual({ ok: true });
  });

  test("menuSet passes the view's items through untouched", async () => {
    const seen: unknown[][] = [];
    const items = [{ label: "Ledge", submenu: [{ label: "Quit", action: "app.quit" }] }];
    await clientSeams({ setMenu: (i) => seen.push(i) }).menuSet({ items });
    expect(seen).toEqual([items]);
  });
});
