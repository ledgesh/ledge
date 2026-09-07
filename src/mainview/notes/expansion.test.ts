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
    // A total selector, like notesOf: expandedIn returns an empty set, never
    // undefined, so callers stay branch-free.
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
    // Seeding replaces the set rather than merging into it: the file is the
    // whole answer for that root (expansion.ts seedExpansion). Only a test
    // leaves the module holding folders before the saved layout is read, and
    // at boot there is nothing to merge with.
    expandFolder(A, "stale");
    seedExpansion(A, ["projects", "projects/api"]);
    expect([...expandedIn(A)].sort()).toEqual(["projects", "projects/api"]);
  });

  test("a change notifies listeners, which is how the layout save hears about one", () => {
    // Two things subscribe: the browser's rows (useExpanded) and the debounced
    // layout save (App.tsx). Opening a folder changes no AppState, so the save
    // hears about it by no other route, and a subscription that cannot be
    // dropped is the same hazard as one that never fires. Calling off() has to
    // stop the notifications, which is what the final expand checks.
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
    // The open folders are keyed by workspace root (expansion.ts). Switching
    // workspaces and back finds the tree as that workspace left it, not as the
    // other workspace left its own tree.
    expandFolder(A, "projects");
    expect(isExpanded(B, "projects")).toBe(false);
    expandFolder(B, "admin");
    expect([...expandedIn(A)]).toEqual(["projects"]);
    expect([...expandedIn(B)]).toEqual(["admin"]);
  });
});
