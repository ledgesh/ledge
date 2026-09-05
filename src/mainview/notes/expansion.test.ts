import { afterEach, describe, expect, test } from "bun:test";
import {
  collapseFolder,
  expandFolder,
  expandedIn,
  isExpanded,
  resetExpansion,
  toggleFolder,
} from "./expansion";

const A = "/ws/a";
const B = "/ws/b";

afterEach(resetExpansion);

describe("expansion", () => {
  test("a workspace nobody has opened a folder in has none open", () => {
    // A total selector, like notesOf: callers stay branch-free.
    expect([...expandedIn(A)]).toEqual([]);
    expect(isExpanded(A, "projects")).toBe(false);
  });

  test("expanding opens the folder's ancestors with it", () => {
    expandFolder(A, "projects/api");
    expect([...expandedIn(A)].sort()).toEqual(["projects", "projects/api"]);
  });

  test("collapsing takes the folder's descendants with it", () => {
    expandFolder(A, "projects/api");
    collapseFolder(A, "projects");
    expect([...expandedIn(A)]).toEqual([]);
  });

  test("the top level has no row, so expanding it is a no-op", () => {
    expandFolder(A, "");
    expect([...expandedIn(A)]).toEqual([]);
  });

  test("toggle goes both ways", () => {
    toggleFolder(A, "admin");
    expect(isExpanded(A, "admin")).toBe(true);
    toggleFolder(A, "admin");
    expect(isExpanded(A, "admin")).toBe(false);
  });

  test("two workspaces do not share an answer for a folder name they share", () => {
    // Keyed by root, so switching workspaces and back finds the tree as it was
    // left rather than as the other workspace left its own.
    expandFolder(A, "projects");
    expect(isExpanded(B, "projects")).toBe(false);
    expandFolder(B, "admin");
    expect([...expandedIn(A)]).toEqual(["projects"]);
    expect([...expandedIn(B)]).toEqual(["admin"]);
  });
});
