import { afterEach, describe, expect, test } from "bun:test";
import {
  collapseFolder,
  expandFolder,
  expandedIn,
  isExpanded,
  resetExpansion,
  seedExpansion,
  subscribeExpansion,
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

  test("seeding replaces a workspace's set: the saved layout is the whole answer for that root", () => {
    // Boot order in one line — the module can hold something before the file
    // is read only in a test, but a merge would be the wrong rule either way.
    expandFolder(A, "stale");
    seedExpansion(A, ["projects", "projects/api"]);
    expect([...expandedIn(A)].sort()).toEqual(["projects", "projects/api"]);
  });

  test("a change notifies listeners, which is how the layout save hears about one", () => {
    // The browser's rows are one listener; App's debounced layout save is the
    // other, and opening a folder reaches it by no other route (it changes no
    // AppState). Unsubscribing has to work for the same reason.
    let heard = 0;
    const off = subscribeExpansion(() => {
      heard += 1;
    });
    expandFolder(A, "projects");
    collapseFolder(A, "projects");
    off();
    expandFolder(A, "admin");
    expect(heard).toBe(2);
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
