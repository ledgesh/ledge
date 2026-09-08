// Session persistence: serializeLayout and restoreLayout, mostly the
// self-healing. `.layout.json` is machine-written state (architecture.md §6):
// a bad piece costs only itself, and a total failure falls back to a fresh
// start instead of throwing. Since the per-workspace split, restore also
// checks folders: a workspace needs a registered one, each tab must be in its
// own folder's boot noteList, and an unmounted folder goes dormant, not pruned.
import { afterEach, describe, expect, test } from "bun:test";
import type { NoteMeta, WorkspaceRootInfo } from "../../shared/rpc-schema";
import { initialState, reducer, type AppState } from "./store";
import { findLeaf, firstLeaf, tabPaths, type LeafNode, type SplitNode } from "./tree";
import { restoreLayout, restoredState, serializeLayout } from "./persist";
import { DEFAULT_ICON } from "./icons";
import { expandFolder, expandedIn, resetExpansion } from "../notes/expansion";

function note(path: string, title: string, mtimeMs = 1): NoteMeta {
  return { path, title, mtimeMs };
}

const FOLDER = "/r";
const FOLDER2 = "/r2";
const NOTES = [
  note("/r/alpha.md", "Alpha", 3),
  note("/r/beta.md", "Beta", 2),
  note("/r/gamma.md", "Gamma", 1),
];

// Notes in folders, so there is a tree for the open-folder tests to be about.
// folderList derives `projects`, `projects/api` and `admin` from these, and
// restore prunes the saved open set against that list. Both workspaces get a
// `projects`: the file has to keep apart two workspaces with a folder of the
// same name.
const filed = (path: string, title: string, folder: string): NoteMeta => ({ ...note(path, title), folder });
const FILED = [
  filed("/r/projects/api/spec.md", "Spec", "projects/api"),
  filed("/r/admin/tax.md", "Tax", "admin"),
];
const FILED2 = [filed("/r2/projects/old.md", "Old", "projects")];

const root = (folder: string, available = true): WorkspaceRootInfo => ({
  root: folder,
  kind: "managed",
  available,
});
const ROOTS = [root(FOLDER), root(FOLDER2)];
const NOTES_BY = { [FOLDER]: NOTES, [FOLDER2]: [] as NoteMeta[] };
const FILED_BY = { [FOLDER]: [...NOTES, ...FILED], [FOLDER2]: FILED2 };

// serializeLayout reads the live open set (notes/expansion.ts) and restore
// seeds it, so a test that opened a folder would leak it into the next one.
afterEach(resetExpansion);

// A state exercising everything the layout records: two workspaces (each on
// its own folder), a split, tab order, active tabs, focus, selection. Built
// through the reducer, per testing.md §4, because hand-assembled AppState
// literals rot as the shape grows.
function richState(): AppState {
  let s = initialState(FOLDER, NOTES);
  s = reducer(s, { type: "renameWorkspace", id: s.workspaces[0].id, name: "Writing" });
  s = reducer(s, { type: "setWorkspaceIcon", id: s.workspaces[0].id, symbol: "terminal" });
  s = reducer(s, { type: "openNote", note: NOTES[1] });
  s = reducer(s, { type: "splitPane", dir: "row" });
  s = reducer(s, { type: "openNote", note: NOTES[2] });
  s = reducer(s, { type: "addWorkspace", name: "Workspace 2", folder: FOLDER2 });
  return s;
}

describe("round trip", () => {
  test("workspaces, folders, splits, tabs, active tab, focus, and selection survive", () => {
    const before = richState();
    const after = restoreLayout(serializeLayout(before), ROOTS, NOTES_BY, {});
    expect(after).not.toBeNull();

    expect(after!.workspaces.length).toBe(2);
    const [w1, w2] = after!.workspaces;
    expect(w1.name).toBe("Writing");
    expect(w1.symbol).toBe("terminal");
    expect(w1.folder).toBe(FOLDER);
    expect(w2.name).toBe("Workspace 2");
    expect(w2.folder).toBe(FOLDER2);

    // The split came back with its shape: alpha+beta on the left, gamma right.
    expect(w1.root.kind).toBe("split");
    const rootNode = w1.root as SplitNode;
    expect(rootNode.dir).toBe("row");
    const left = rootNode.children[0] as LeafNode;
    const right = rootNode.children[1] as LeafNode;
    expect(left.tabs.map((t) => t.path)).toEqual(["/r/alpha.md", "/r/beta.md"]);
    expect(left.activeTabId).toBe(left.tabs[1].id); // beta was the active tab
    expect(right.tabs.map((t) => t.path)).toEqual(["/r/gamma.md"]);

    // The new (right) pane held focus when the state was saved.
    expect(w1.focusedPaneId).toBe(right.id);

    // The second workspace was selected at save time.
    expect(after!.selectedId).toBe(w2.id);

    // Each folder's boot lists landed under its own key.
    expect(after!.notes[FOLDER]).toEqual(NOTES);
    expect(after!.notes[FOLDER2]).toEqual([]);
  });

  test("the open folders come back, and each workspace keeps its own", () => {
    // Both workspaces have a `projects`. Only the first one's is open. The
    // file records open folders per workspace for the same reason the live
    // module keys them by root: two workspaces cannot share an answer for a
    // folder name they have in common (notes/expansion.ts).
    const before = richState();
    expandFolder(FOLDER, "projects/api");
    const text = serializeLayout(before);
    resetExpansion(); // the relaunch: a fresh process has opened nothing

    expect(restoreLayout(text, ROOTS, FILED_BY, {})).not.toBeNull();
    expect([...expandedIn(FOLDER)].sort()).toEqual(["projects", "projects/api"]);
    expect([...expandedIn(FOLDER2)]).toEqual([]);
  });

  test("the saved order is the folders themselves, not the order they were opened in", () => {
    // The sort matters only because the save is deduped on its own text
    // (scheduleLayoutSave): open b then a, and an insertion-ordered list
    // would write a layout nobody changed.
    const s1 = richState();
    expandFolder(FOLDER, "admin");
    expandFolder(FOLDER, "projects");
    const opened = serializeLayout(s1);
    resetExpansion();
    expandFolder(FOLDER, "projects");
    expandFolder(FOLDER, "admin");
    expect(serializeLayout(s1)).toBe(opened);
  });

  test("restored ids are fresh: docIds name live sessions, which died with the process", () => {
    const before = richState();
    const after = restoreLayout(serializeLayout(before), ROOTS, NOTES_BY, {})!;
    const beforeDocs = before.workspaces.flatMap((w) => firstLeaf(w.root).tabs.map((t) => t.docId));
    const afterDocs = after.workspaces.flatMap((w) => firstLeaf(w.root).tabs.map((t) => t.docId));
    for (const d of afterDocs) expect(beforeDocs).not.toContain(d);
  });

  test("tab titles come from the boot noteList, not the file: a persisted title can only be stale", () => {
    const s = initialState(FOLDER, [note("/r/alpha.md", "Old Title")]);
    const text = serializeLayout(s);
    const after = restoreLayout(text, ROOTS, { [FOLDER]: [note("/r/alpha.md", "Renamed In A Shell")] }, {})!;
    expect(firstLeaf(after.workspaces[0].root).tabs[0].title).toBe("Renamed In A Shell");
  });
});

describe("folders", () => {
  test("v1 text restores as null: no migration, a fresh boot instead", () => {
    const text = JSON.stringify({
      version: 1,
      selectedIndex: 0,
      workspaces: [
        { name: "A", symbol: DEFAULT_ICON, root: { kind: "leaf", tabs: ["/r/alpha.md"], activeIndex: 0 } },
      ],
    });
    expect(restoreLayout(text, ROOTS, NOTES_BY, {})).toBeNull();
  });

  test("a workspace whose folder is no longer registered costs itself", () => {
    const before = richState(); // Writing on /r, Workspace 2 on /r2
    const after = restoreLayout(serializeLayout(before), [root(FOLDER)], NOTES_BY, {})!;
    expect(after.workspaces.map((w) => w.name)).toEqual(["Writing"]);
  });

  test("a workspace with no folder at all is dropped", () => {
    const text = JSON.stringify({
      version: 2,
      selectedIndex: 0,
      workspaces: [
        { name: "A", symbol: DEFAULT_ICON, root: { kind: "leaf", tabs: [], activeIndex: 0 } },
      ],
    });
    expect(restoreLayout(text, ROOTS, NOTES_BY, {})).toBeNull();
  });

  test("a tab pointing into ANOTHER workspace's folder is pruned: tabs live in their own folder", () => {
    // A hand-edited layout must not smuggle one folder's file into another
    // workspace: each workspace's tabs validate against its own folder's boot
    // noteList.
    const text = JSON.stringify({
      version: 2,
      selectedIndex: 0,
      workspaces: [
        {
          name: "B",
          symbol: DEFAULT_ICON,
          folder: FOLDER2,
          root: { kind: "leaf", tabs: ["/r/alpha.md"], activeIndex: 0 },
        },
      ],
    });
    const after = restoreLayout(text, ROOTS, NOTES_BY, {})!;
    // The pane survives, reseeded; alpha.md did not cross folders.
    expect(tabPaths(after.workspaces[0].root)).toEqual([]);
  });

  test("an unavailable folder's workspace goes dormant: dropped from the session, carried through saves", () => {
    const before = richState();
    const rootsWithVolumeOut = [root(FOLDER), root(FOLDER2, false)];
    const after = restoreLayout(serializeLayout(before), rootsWithVolumeOut, NOTES_BY, {})!;
    // Not shown this session.
    expect(after.workspaces.map((w) => w.name)).toEqual(["Writing"]);
    // The next save still records it, with enough to restore it later.
    const saved = JSON.parse(serializeLayout(after)) as { workspaces: Array<{ name: string; folder: string }> };
    expect(saved.workspaces.map((w) => w.name)).toEqual(["Writing", "Workspace 2"]);
    expect(saved.workspaces[1].folder).toBe(FOLDER2);
    // And with the volume back, the full layout restores.
    const remounted = restoreLayout(JSON.stringify(saved), ROOTS, NOTES_BY, {})!;
    expect(remounted.workspaces.map((w) => w.name)).toEqual(["Writing", "Workspace 2"]);
  });

  test("a dormant workspace's open folders ride through too, since nothing can prune them", () => {
    const before = richState();
    expandFolder(FOLDER2, "projects");
    const text = serializeLayout(before);
    resetExpansion();

    // FOLDER2's volume is out, so its workspace is held dormant. This session
    // has no noteList for it, so its open folders are carried verbatim rather
    // than pruned against one.
    const out = [root(FOLDER), root(FOLDER2, false)];
    const after = restoreLayout(text, out, FILED_BY, {})!;
    expect([...expandedIn(FOLDER2)]).toEqual([]); // not this session: no workspace to open

    const saved = serializeLayout(after);
    expect((JSON.parse(saved) as { workspaces: Array<{ expanded: string[] }> }).workspaces[1].expanded).toEqual([
      "projects",
    ]);
    // And with the volume back it opens where it was left.
    resetExpansion();
    restoreLayout(saved, ROOTS, FILED_BY, {});
    expect([...expandedIn(FOLDER2)]).toEqual(["projects"]);
  });

  test("a layout whose only workspace is dormant falls back fresh but keeps the record on save", () => {
    const s = initialState(FOLDER, NOTES);
    const rootsOut = [root(FOLDER, false), root(FOLDER2)];
    // Serialized once, before any restore: serializeLayout appends whatever
    // the latest restore left dormant. That is the behavior under test, not
    // an input this fixture should already carry.
    const text = serializeLayout(s);
    expect(restoreLayout(text, rootsOut, NOTES_BY, {})).toBeNull();
    const fresh = restoredState(text, rootsOut, NOTES_BY, {});
    expect(fresh.workspaces[0].folder).toBe(FOLDER2); // the first available folder
    const saved = JSON.parse(serializeLayout(fresh)) as { workspaces: Array<{ folder: string }> };
    expect(saved.workspaces.map((w) => w.folder)).toEqual([FOLDER2, FOLDER]);
  });

  test("the fresh-start fallback never lands on the docs root", () => {
    // Bun lists the built-in docs root first (bun/workspaces.ts registers it
    // at every load) and it is available. A first launch still has to boot
    // into a folder a first note can save to, not the read-only
    // documentation.
    const docs: WorkspaceRootInfo = { root: "/docs", kind: "docs", available: true };
    const fresh = restoredState(null, [docs, root(FOLDER)], { [FOLDER]: NOTES, "/docs": [] }, {});
    expect(fresh.workspaces[0].folder).toBe(FOLDER);
  });

  test("a docs workspace recorded in the layout restores like any other", () => {
    // Open docs tabs survive a relaunch: the folder is registered and its
    // boot noteList vouches for the page paths, so the ordinary restore path
    // carries them. The strip hides the docs workspace (Sidebar.tsx), which
    // is presentation, not persistence.
    const page = note("/docs/getting-started.md", "Getting Started");
    let s = initialState(FOLDER, NOTES);
    s = reducer(s, { type: "addWorkspace", name: "Documentation", folder: "/docs", note: page });
    const docs: WorkspaceRootInfo = { root: "/docs", kind: "docs", available: true };
    const after = restoreLayout(serializeLayout(s), [...ROOTS, docs], { ...NOTES_BY, "/docs": [page] }, {})!;
    const ws = after.workspaces.find((w) => w.folder === "/docs")!;
    expect(ws.name).toBe("Documentation");
    expect(tabPaths(ws.root)).toEqual([page.path]);
  });

  test("an empty pane in the docs workspace restores empty, not reseeded", () => {
    // Reseeding it would put back what the docs workspace refuses to create:
    // a read-only "Untitled" that can never be typed in or saved. The split
    // commands pass `empty` there (commands/registry.ts), and splitPane makes
    // an empty leaf for it (store.tsx).
    const page = note("/docs/getting-started.md", "Getting Started");
    let s = initialState(FOLDER, NOTES);
    s = reducer(s, { type: "addWorkspace", name: "Documentation", folder: "/docs", note: page });
    s = reducer(s, { type: "splitPane", dir: "row", empty: true });
    const docs: WorkspaceRootInfo = { root: "/docs", kind: "docs", available: true };
    const after = restoreLayout(serializeLayout(s), [...ROOTS, docs], { ...NOTES_BY, "/docs": [page] }, {})!;
    const ws = after.workspaces.find((w) => w.folder === "/docs")!;
    const empty = (ws.root as SplitNode).children[1] as LeafNode;
    expect(empty.tabs).toEqual([]);
    // The split itself is arrangement and survives, as it does everywhere else.
    expect(tabPaths(ws.root)).toEqual([page.path]);
  });

  test("a docs workspace with no surviving page is dropped, even when it was selected", () => {
    // From a real bug: quitting inside the docs workspace with its pages
    // closed (or with paths a corpus upgrade retired) restored a blank
    // read-only workspace, and the strip has no row for it. The help button
    // then selected the already-selected docs, so it looked dead. Dropping
    // the workspace restores elsewhere, and the help button builds it again
    // on a page (actions.ts openDocs).
    const stale = note("/docs/getting-started.md", "Getting Started");
    const current = note("/docs/01-getting-started.md", "Getting Started");
    let s = initialState(FOLDER, NOTES);
    s = reducer(s, { type: "addWorkspace", name: "Documentation", folder: "/docs", note: stale });
    // The docs workspace was added last, so it was selected at quit time.
    const docs: WorkspaceRootInfo = { root: "/docs", kind: "docs", available: true };
    const after = restoredState(serializeLayout(s), [...ROOTS, docs], { ...NOTES_BY, "/docs": [current] }, {});
    expect(after.workspaces.some((w) => w.folder === "/docs")).toBe(false);
    // The rest of the session restored, not a fresh start: dropping the docs
    // workspace costs exactly itself.
    expect(after.workspaces[0].folder).toBe(FOLDER);
  });
});

describe("pruning", () => {
  test("a persisted note that no longer exists is dropped, and the neighbour inherits its active slot", () => {
    let s = initialState(FOLDER, NOTES); // opens alpha
    s = reducer(s, { type: "openNote", note: NOTES[1] });
    s = reducer(s, { type: "openNote", note: NOTES[2] });
    s = reducer(s, { type: "selectTab", paneId: s.workspaces[0].focusedPaneId, tabId: firstLeaf(s.workspaces[0].root).tabs[1].id });
    // beta (the active tab) was deleted while the app was closed.
    const survivors = [NOTES[0], NOTES[2]];
    const after = restoreLayout(serializeLayout(s), ROOTS, { [FOLDER]: survivors }, {})!;
    const leaf = firstLeaf(after.workspaces[0].root);
    expect(leaf.tabs.map((t) => t.path)).toEqual(["/r/alpha.md", "/r/gamma.md"]);
    // closeTab's rule: gamma slid into beta's slot and takes its active status.
    expect(leaf.activeTabId).toBe(leaf.tabs[1].id);
  });

  test("the preview tab comes back a preview, and only it", () => {
    // Which tab the next click replaces is arrangement like the rest of the
    // strip (interactions.md §1b).
    let s = initialState(FOLDER, NOTES); // opens alpha, permanent
    s = reducer(s, { type: "openNote", note: NOTES[1], preview: true });
    const after = restoreLayout(serializeLayout(s), ROOTS, NOTES_BY, {})!;
    const leaf = firstLeaf(after.workspaces[0].root);
    expect(leaf.tabs.map((t) => [t.path, t.preview])).toEqual([
      ["/r/alpha.md", false],
      ["/r/beta.md", true],
    ]);
  });

  test("a pruned preview tab promotes nothing in its place", () => {
    // The slot is matched by its index in the FILE, so a preview note deleted
    // while the app was closed leaves a strip of ordinary tabs rather than
    // handing the mark to whichever tab slid down.
    let s = initialState(FOLDER, NOTES); // opens alpha
    s = reducer(s, { type: "openNote", note: NOTES[1], preview: true });
    s = reducer(s, { type: "openNote", note: NOTES[2] });
    const after = restoreLayout(serializeLayout(s), ROOTS, { [FOLDER]: [NOTES[0], NOTES[2]] }, {})!;
    const leaf = firstLeaf(after.workspaces[0].root);
    expect(leaf.tabs.map((t) => [t.path, t.preview])).toEqual([
      ["/r/alpha.md", false],
      ["/r/gamma.md", false],
    ]);
  });

  test("a file written before the preview field existed restores ordinary tabs", () => {
    // The same defensive read `expanded` gets: an absent field is a good file
    // from a build that had no previews, not a broken one.
    const text = serializeLayout(richState()).replace(/"preview":\d+,?/g, "");
    const after = restoreLayout(text, ROOTS, NOTES_BY, {})!;
    const leaf = firstLeaf(after.workspaces[0].root);
    expect(leaf.tabs.every((t) => !t.preview)).toBe(true);
  });

  test("an open folder that no longer exists is dropped, like a tab on a missing note", () => {
    const before = richState();
    expandFolder(FOLDER, "projects/api");
    expandFolder(FOLDER, "gone");
    const text = serializeLayout(before);
    resetExpansion();

    restoreLayout(text, ROOTS, FILED_BY, {});
    // `gone` holds no note in the boot list, so the browser draws no row for
    // it and the entry can never match one. Without the drop, a folder
    // deleted in a shell would sit in the file forever.
    expect([...expandedIn(FOLDER)].sort()).toEqual(["projects", "projects/api"]);
  });

  test("unsaved tabs are not persisted: their text lives only in the editor", () => {
    let s = initialState(FOLDER, NOTES);
    s = reducer(s, { type: "newTab" }); // a scratch tab, never typed in
    const after = restoreLayout(serializeLayout(s), ROOTS, NOTES_BY, {})!;
    const leaf = firstLeaf(after.workspaces[0].root);
    expect(leaf.tabs.map((t) => t.path)).toEqual(["/r/alpha.md"]);
    // The unsaved tab was active; its saved neighbour inherits.
    expect(leaf.activeTabId).toBe(leaf.tabs[0].id);
  });

  test("a pane whose every tab was pruned survives as arrangement, reseeded with a scratch tab", () => {
    let s = initialState(FOLDER, NOTES);
    s = reducer(s, { type: "splitPane", dir: "col" }); // new pane holds only a scratch tab
    const after = restoreLayout(serializeLayout(s), ROOTS, NOTES_BY, {})!;
    expect(after.workspaces[0].root.kind).toBe("split");
    const seeded = (after.workspaces[0].root as SplitNode).children[1] as LeafNode;
    expect(seeded.tabs.length).toBe(1);
    expect(seeded.tabs[0].path).toBeNull();
  });

  test("a note duplicated across the file opens once: two tabs on one path would race autosaves", () => {
    const text = JSON.stringify({
      version: 2,
      selectedIndex: 0,
      workspaces: [
        { name: "A", symbol: DEFAULT_ICON, folder: FOLDER, root: { kind: "leaf", tabs: ["/r/alpha.md"], activeIndex: 0 } },
        { name: "B", symbol: DEFAULT_ICON, folder: FOLDER, root: { kind: "leaf", tabs: ["/r/alpha.md", "/r/beta.md"], activeIndex: 0 } },
      ],
    });
    const after = restoreLayout(text, ROOTS, NOTES_BY, {})!;
    const all = after.workspaces.flatMap((w) => tabPaths(w.root));
    expect(all.filter((p) => p === "/r/alpha.md").length).toBe(1);
    // The duplicate was dropped from B, whose remaining tab carries on.
    expect(tabPaths(after.workspaces[1].root)).toEqual(["/r/beta.md"]);
  });
});

describe("self-healing", () => {
  test("no saved layout, unparseable JSON, a non-object, and an unknown version each fall back to a fresh start", () => {
    for (const text of [null, "{not json", '"a string"', JSON.stringify({ version: 3, workspaces: [] })]) {
      expect(restoreLayout(text, ROOTS, NOTES_BY, {})).toBeNull();
      // restoredState turns that into initialState's single-note boot on the
      // first available folder.
      const s = restoredState(text, ROOTS, NOTES_BY, {});
      expect(s.workspaces.length).toBe(1);
      expect(s.workspaces[0].folder).toBe(FOLDER);
      expect(firstLeaf(s.workspaces[0].root).tabs[0].path).toBe("/r/alpha.md");
    }
  });

  test("a malformed workspace costs itself, not the file", () => {
    const text = JSON.stringify({
      version: 2,
      selectedIndex: 0,
      workspaces: [
        { name: "Good", symbol: DEFAULT_ICON, folder: FOLDER, root: { kind: "leaf", tabs: ["/r/alpha.md"], activeIndex: 0 } },
        { name: "Bad", symbol: DEFAULT_ICON, folder: FOLDER2, root: { kind: "what" } },
      ],
    });
    const after = restoreLayout(text, ROOTS, NOTES_BY, {})!;
    expect(after.workspaces.length).toBe(1);
    expect(after.workspaces[0].name).toBe("Good");
  });

  test("a malformed open-folder list, and a file written before there was one, both restore closed", () => {
    const leaf = { kind: "leaf", tabs: ["/r/alpha.md"], activeIndex: 0 };
    const ws = (folder: string, expanded: unknown) => ({ name: "W", symbol: DEFAULT_ICON, folder, expanded, root: leaf });
    // `expanded: "projects"` is a string where a list belongs, and one entry
    // in the next workspace is a number. Each bad value costs only the open
    // folders, not the workspace. Both workspaces restore: the first with
    // every folder shut, the second with its one good entry open.
    const text = JSON.stringify({
      version: 2,
      selectedIndex: 0,
      workspaces: [ws(FOLDER, "projects"), { ...ws(FOLDER2, ["projects", 7]), root: leaf }],
    });
    const after = restoreLayout(text, ROOTS, FILED_BY, {})!;
    expect(after.workspaces.length).toBe(2);
    expect([...expandedIn(FOLDER)]).toEqual([]);
    expect([...expandedIn(FOLDER2)]).toEqual(["projects"]);

    // A file with no `expanded` key at all is what an older build wrote. It
    // is still a valid version 2, and it restores with nothing open, which is
    // what that build did.
    resetExpansion();
    const old2 = JSON.stringify({
      version: 2,
      selectedIndex: 0,
      workspaces: [{ name: "W", symbol: DEFAULT_ICON, folder: FOLDER, root: leaf }],
    });
    expect(restoreLayout(old2, ROOTS, FILED_BY, {})).not.toBeNull();
    expect([...expandedIn(FOLDER)]).toEqual([]);
  });

  test("a malformed half of a split costs that half: the sibling takes its place", () => {
    const text = JSON.stringify({
      version: 2,
      selectedIndex: 0,
      workspaces: [
        {
          name: "A",
          symbol: DEFAULT_ICON,
          folder: FOLDER,
          root: {
            kind: "split",
            dir: "row",
            ratio: 0.5,
            children: [42, { kind: "leaf", tabs: ["/r/beta.md"], activeIndex: 0 }],
          },
        },
      ],
    });
    const after = restoreLayout(text, ROOTS, NOTES_BY, {})!;
    const rootNode = after.workspaces[0].root;
    expect(rootNode.kind).toBe("leaf");
    expect((rootNode as LeafNode).tabs[0].path).toBe("/r/beta.md");
  });

  test("every workspace failing means no restore at all", () => {
    const text = JSON.stringify({ version: 2, selectedIndex: 0, workspaces: [{ root: null }, "junk"] });
    expect(restoreLayout(text, ROOTS, NOTES_BY, {})).toBeNull();
  });

  test("bad fields degrade alone: ratio clamps, dir defaults, name and symbol fall back, selection clamps", () => {
    const text = JSON.stringify({
      version: 2,
      selectedIndex: 99,
      workspaces: [
        {
          name: "   ",
          symbol: "not-an-icon",
          folder: FOLDER,
          root: {
            kind: "split",
            dir: "diagonal",
            ratio: 7,
            children: [
              { kind: "leaf", tabs: ["/r/alpha.md"], activeIndex: 99 },
              { kind: "leaf", tabs: ["/r/beta.md"], activeIndex: 0 },
            ],
          },
        },
      ],
    });
    const after = restoreLayout(text, ROOTS, NOTES_BY, {})!;
    const ws = after.workspaces[0];
    expect(ws.name).toBe("Workspace 1");
    expect(ws.symbol).toBe(DEFAULT_ICON);
    const rootNode = ws.root as SplitNode;
    expect(rootNode.dir).toBe("row");
    expect(rootNode.ratio).toBe(0.88); // same clamp the reducer applies to drags
    const left = rootNode.children[0] as LeafNode;
    expect(left.activeTabId).toBe(left.tabs[0].id); // out-of-range active clamps
    expect(after.selectedId).toBe(ws.id); // out-of-range selection clamps
  });

  test("a path that is not a string is dropped, not opened: paths are opaque handles from the noteList", () => {
    const text = JSON.stringify({
      version: 2,
      selectedIndex: 0,
      workspaces: [
        {
          name: "A",
          symbol: DEFAULT_ICON,
          folder: FOLDER,
          root: { kind: "leaf", tabs: [42, { evil: true }, "/r/alpha.md", "/r/not-listed.md"], activeIndex: 0 },
        },
      ],
    });
    const after = restoreLayout(text, ROOTS, NOTES_BY, {})!;
    expect(tabPaths(after.workspaces[0].root)).toEqual(["/r/alpha.md"]);
  });

  test("focus falls back to the first pane when no leaf carries the flag", () => {
    const text = JSON.stringify({
      version: 2,
      selectedIndex: 0,
      workspaces: [
        { name: "A", symbol: DEFAULT_ICON, folder: FOLDER, root: { kind: "leaf", tabs: ["/r/alpha.md"], activeIndex: 0 } },
      ],
    });
    const after = restoreLayout(text, ROOTS, NOTES_BY, {})!;
    const ws = after.workspaces[0];
    expect(findLeaf(ws.root, ws.focusedPaneId)).not.toBeNull();
  });
});
