// The CLI's pure half: argv parsing and row formatting. What a verb DOES is
// cli.fs.test.ts's subject; this file pins the grammar a shell user types
// against and the shapes their terminal shows.
import { describe, expect, test } from "bun:test";
import { formatNoteList, hitPath, parseCliArgs, resolveWorkspaceArg, tildify } from "./cli";

describe("parseCliArgs", () => {
  test("verb, positionals, and flags separate wherever the flags sit", () => {
    const p = parseCliArgs(["append", "Shipping", "Notes", "-m", "hello", "--heading", "Log"]);
    expect(p).toEqual({
      verb: "append",
      positionals: ["Shipping", "Notes"],
      flags: { message: "hello", heading: "Log", json: false, all: false, help: false },
    });
  });

  test("no argv at all is the empty verb (open the app)", () => {
    expect(parseCliArgs([])).toEqual({ verb: "", positionals: [], flags: { json: false, all: false, help: false } });
  });

  test("boolean flags and short aliases", () => {
    const p = parseCliArgs(["ls", "-a", "--json", "-w", "notes"]);
    expect(p).toEqual({
      verb: "ls",
      positionals: [],
      flags: { workspace: "notes", json: true, all: true, help: false },
    });
  });

  test("a valued flag with nothing after it is an error, not an undefined", () => {
    expect(parseCliArgs(["append", "-m"])).toEqual({ error: "-m needs a value" });
  });

  test("an unknown flag is an error, not a positional", () => {
    expect(parseCliArgs(["ls", "--frobnicate"])).toEqual({ error: "unknown flag: --frobnicate" });
  });

  test("-- ends flag parsing so a dash-leading title stays reachable", () => {
    const p = parseCliArgs(["cat", "--", "--dashed-title"]);
    expect(p).toMatchObject({ verb: "cat", positionals: ["--dashed-title"] });
  });

  test("a bare dash is a positional (a stdin marker, not a flag)", () => {
    expect(parseCliArgs(["cat", "-"])).toMatchObject({ positionals: ["-"] });
  });
});

describe("tildify", () => {
  test("shortens the home prefix and home itself", () => {
    expect(tildify("/home/u/notes/a.md", "/home/u")).toBe("~/notes/a.md");
    expect(tildify("/home/u", "/home/u")).toBe("~");
  });

  test("a sibling whose name merely starts with home stays untouched", () => {
    expect(tildify("/home/uber/x.md", "/home/u")).toBe("/home/uber/x.md");
  });
});

describe("hitPath", () => {
  test("relative under the cwd, ~-shortened outside it, never ..", () => {
    expect(hitPath("/w/notes/a.md", "/w/notes", "/home/u")).toBe("a.md");
    expect(hitPath("/w/notes/sub/a.md", "/w/notes", "/home/u")).toBe("sub/a.md");
    expect(hitPath("/home/u/other/b.md", "/w/notes", "/home/u")).toBe("~/other/b.md");
  });
});

describe("formatNoteList", () => {
  test("pads the title column and puts the variable-width path last", () => {
    const lines = formatNoteList(
      [
        { title: "A", path: "/home/u/w/a.md", modified: "2026-07-18T09:00:00.000Z" },
        { title: "Longer Title", path: "/home/u/w/longer-title.md", modified: "2026-07-17T09:00:00.000Z" },
      ],
      "/home/u",
    );
    expect(lines).toEqual([
      "A             2026-07-18  ~/w/a.md",
      "Longer Title  2026-07-17  ~/w/longer-title.md",
    ]);
  });
});

describe("resolveWorkspaceArg", () => {
  const registered = ["/home/u/.ledge/notes", "/vol/project"];

  test("a registered path passes, ~ expanding first", () => {
    expect(resolveWorkspaceArg("/vol/project", registered, "/home/u")).toBe("/vol/project");
    expect(resolveWorkspaceArg("~/.ledge/notes", registered, "/home/u")).toBe("/home/u/.ledge/notes");
  });

  test("a folder name is shorthand for the one root that carries it", () => {
    expect(resolveWorkspaceArg("project", registered, "/home/u")).toBe("/vol/project");
  });

  test("a name two roots share is ambiguous, and the error lists the paths", () => {
    const both = ["/a/notes", "/b/notes"];
    expect(() => resolveWorkspaceArg("notes", both, "/home/u")).toThrow(/several workspaces.*\/a\/notes.*\/b\/notes/);
  });

  test("an unknown value names the known roots; an empty registry says open the app", () => {
    expect(() => resolveWorkspaceArg("nope", registered, "/home/u")).toThrow(/known: ~\/.ledge\/notes/);
    expect(() => resolveWorkspaceArg("nope", [], "/home/u")).toThrow(/open the app/);
  });
});
