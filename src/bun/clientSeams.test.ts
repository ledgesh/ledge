// Tests for the seams the client serves itself (remote.md §10). No test reads
// or writes the real pasteboard, and none opens a browser: every assetPaste
// call injects a readImage, and linkOpen is only given urls it refuses. What
// the tests cover is the list both ends read, the gate that decides whether a
// paste pays for an osascript spawn, and the guard on link opening.
import { describe, expect, test } from "bun:test";
import { clientSeams, wantsHtml } from "./clientSeams";
import { CLIENT_METHODS, CONNECTION_METHODS, NATIVE_METHODS } from "../shared/wire";

describe("the client's methods", () => {
  // NATIVE_METHODS is what clientSeams implements. CLIENT_METHODS is what the
  // server refuses: that list plus the connection list. The connection list is
  // implemented by bun/connectionManager.ts. A name in one list and not the
  // other is a method served by nobody or refused by everybody.
  test("the native list and its implementations name the same six", () => {
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

  // The gate exists for the common case: a copy made inside Ledge. Ledge
  // copies with pbcopy, and pbcopy writes text alone. ⌘V after one must not
  // cost an osascript spawn.
  test("text alone skips the spawn", () => {
    expect(wantsHtml(["public.utf8-plain-text"])).toBe(false);
  });

  // Two answers mean the flavors are unknown: a null list and an empty one.
  // Null covers an absent native seam and a pasteboard that cannot be read
  // (clientSeams.ts clipboardFormats). Either way the pasteboard is asked, so
  // a wrong answer costs latency rather than the paste.
  test.each([
    [null, "no format list at all"],
    [[], "an empty one"],
  ])("%p (%s) asks the pasteboard anyway", (formats) => {
    expect(wantsHtml(formats)).toBe(true);
  });
});

describe("opening a link", () => {
  // `open` treats a non-URL argument as a file path and will launch an .app
  // bundle, so openableUrl (shared/links.ts) is the boundary. It refuses empty
  // and whitespace-bearing text as well as unlisted schemes. The urls come from
  // note text, so they can be anything. A refusal returns { ok: false } rather
  // than throwing: the view has nothing useful to do with the exception.
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
  // setMenu and readImage, the two natives this file injects, are optional
  // because a client that is not macOS has neither. The menu is the one that
  // matters here: a shell with no setMenu must still answer menuSet. The view
  // re-pushes the menu on every state change and fires each push with `void`
  // (boot.tsx configureMenu), so a rejection would go unhandled.
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

// A pasted image splits across two machines (remote.md §10): the image is read
// on the machine holding the pasteboard, and the file is named on the machine
// holding the notes. The osascript read cannot run in a test suite, since it
// would read the developer's own clipboard. These tests cover the seam between
// the two ends, including the case that never reaches the server.
describe("a pasted image is two machines' work", () => {
  test("no image on the pasteboard answers null without asking the server", async () => {
    let asked = 0;
    const seams = clientSeams(
      { readImage: async () => null },
      {
        assetWrite: async () => {
          asked += 1;
          return { src: "never" };
        },
      },
    );
    expect(await seams.assetPaste({ root: "/w", notePath: "/w/a.md" })).toEqual({ src: null });
    expect(asked).toBe(0);
  });

  test("bytes go over as base64 and the NAME comes back", async () => {
    const seen: unknown[] = [];
    const seams = clientSeams(
      { readImage: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
      {
        assetWrite: async (p) => {
          seen.push(p);
          return { src: ".ledge-assets/pasted-2026-08-01.png" };
        },
      },
    );
    expect(await seams.assetPaste({ root: "/w", notePath: "/w/a.md" })).toEqual({
      src: ".ledge-assets/pasted-2026-08-01.png",
    });
    // The client sends the bytes plus the root and note path it was given.
    // The client does not name the file; the server does.
    expect(seen).toEqual([{ root: "/w", notePath: "/w/a.md", dataB64: "iVBORw==" }]);
  });

  test("an empty pasteboard image is the same as none", async () => {
    const seams = clientSeams({ readImage: async () => new Uint8Array(0) }, { assetWrite: async () => ({ src: "never" }) });
    expect(await seams.assetPaste({ root: "/w", notePath: null })).toEqual({ src: null });
  });

  test("bytes a paste event carried go to the server without a pasteboard read", async () => {
    // A Mac's paste event never carries a picture (editor/clipboard.ts
    // pasteEvent), but the method is one contract: bytes given are bytes sent.
    const seen: unknown[] = [];
    const seams = clientSeams(
      {
        readImage: async () => {
          throw new Error("the pasteboard was read");
        },
      },
      {
        assetWrite: async (p) => {
          seen.push(p);
          return { src: ".ledge-assets/pasted.jpg" };
        },
      },
    );
    expect(await seams.assetPaste({ root: "/w", notePath: "/w/a.md", dataB64: "/9j/" })).toEqual({
      src: ".ledge-assets/pasted.jpg",
    });
    expect(seen).toEqual([{ root: "/w", notePath: "/w/a.md", dataB64: "/9j/" }]);
  });
});
