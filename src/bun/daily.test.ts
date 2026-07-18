// The pure half of daily.ts: how the daily.workspace setting resolves. The
// filesystem half — create-or-open, template instantiation against real
// roots — lives in daily.fs.test.ts.
import { describe, expect, test } from "bun:test";
import { resolveConfiguredWorkspace } from "./daily";
import { workspaceMatches } from "./workspaces";

const HOME = "/home/dan";
const ROOTS = ["/home/dan/.ledge/notes", "/home/dan/.ledge/journal", "/vault/journal"];

describe("workspaceMatches", () => {
  test("an exact registered path matches itself", () => {
    expect(workspaceMatches("/home/dan/.ledge/notes", ROOTS, HOME)).toEqual(["/home/dan/.ledge/notes"]);
  });

  test("~ expands before matching", () => {
    expect(workspaceMatches("~/.ledge/notes", ROOTS, HOME)).toEqual(["/home/dan/.ledge/notes"]);
  });

  test("a unique basename is shorthand for its root", () => {
    expect(workspaceMatches("notes", ROOTS, HOME)).toEqual(["/home/dan/.ledge/notes"]);
  });

  test("a shared basename returns every claimant", () => {
    expect(workspaceMatches("journal", ROOTS, HOME)).toEqual([
      "/home/dan/.ledge/journal",
      "/vault/journal",
    ]);
  });

  test("an unknown name matches nothing", () => {
    expect(workspaceMatches("scratch", ROOTS, HOME)).toEqual([]);
  });
});

describe("resolveConfiguredWorkspace", () => {
  test("empty (the seeded default) means unset, silently", () => {
    expect(resolveConfiguredWorkspace("", ROOTS, HOME)).toBeNull();
    expect(resolveConfiguredWorkspace("   ", ROOTS, HOME)).toBeNull();
  });

  test("resolves a path or a unique name", () => {
    expect(resolveConfiguredWorkspace("~/.ledge/notes", ROOTS, HOME)).toBe("/home/dan/.ledge/notes");
    expect(resolveConfiguredWorkspace("notes", ROOTS, HOME)).toBe("/home/dan/.ledge/notes");
  });

  test("an ambiguous name degrades to null rather than guessing", () => {
    expect(resolveConfiguredWorkspace("journal", ROOTS, HOME)).toBeNull();
  });

  test("a stale value degrades to null rather than stranding the command", () => {
    expect(resolveConfiguredWorkspace("gone", ROOTS, HOME)).toBeNull();
  });
});
