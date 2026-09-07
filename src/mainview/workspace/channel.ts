// The view end of the workspace-registry RPC, mirroring notes/channel.ts.
// workspace/actions.ts calls these, boot.tsx binds them to the server's RPC,
// the harness binds an in-memory fake. The folder strings crossing here are
// opaque root handles Bun handed out (workspaceList, create, attach); the
// view never constructs one (architecture.md §2).

// This module also records each root's kind (managed, external, or docs) as
// the handles pass through the wrappers below. workspaceDefaultCwd,
// workspaceKind and docsFolder read the map. It mirrors Bun-side truth and is
// never persisted: layout.json must not store kind (architecture.md §6a). A
// stale entry after a detach is harmless: its folder has no notes open.
import type { WorkspaceRootInfo } from "../../shared/rpc-schema";

export interface AttachResult {
  root: string | null;
  kind: "managed" | "external" | null;
  error: string | null;
}

interface WorkspaceHandlers {
  list: () => Promise<{ workspaces: WorkspaceRootInfo[]; dailyRoot: string | null }>;
  create: (name: string) => Promise<string>;
  // Opens the native folder picker Bun-side. A null root with a null error
  // means the user cancelled.
  attach: () => Promise<AttachResult>;
  detach: (root: string) => Promise<boolean>;
  // Runs the native picker again for the destination parent folder. Bun
  // renames the root's folder into it. The result has the same shape as
  // attach's: the new root handle, a refusal, or the cancelled nulls. `home`
  // skips the picker and targets the app home (the Move Workspace Folder
  // Home face).
  move: (root: string, home: boolean) => Promise<AttachResult>;
}

let handlers: WorkspaceHandlers | null = null;

export function configureWorkspaces(h: WorkspaceHandlers): void {
  handlers = h;
}

function bridge(): WorkspaceHandlers {
  if (!handlers) throw new Error("workspace bridge not configured");
  return handlers;
}

const kinds = new Map<string, "managed" | "external" | "docs">();

/**
 * Record roots that entered the view outside the wrappers below. The boot
 * fetch in boot.tsx calls the RPC directly; the harness and the tests record
 * from their own fakes.
 */
export function recordWorkspaceKinds(infos: WorkspaceRootInfo[]): void {
  for (const info of infos) kinds.set(info.root, info.kind);
}

// The daily.workspace setting resolved Bun-side to a registered root, null
// when unset or stale. It comes from the same workspaceList response as the
// kinds. Two consumers: the Edit/New Daily Template faces (they must point
// where ⌘J acts) and ⌘J's own visibility gate in the docs workspace. Bun
// re-resolves on every ⌘J, so it never decides where a daily note lands.
let dailyRoot: string | null = null;

/** The boot fetch records the daily root here, as it does the kinds. */
export function recordDailyRoot(root: string | null): void {
  dailyRoot = root;
}

export function dailyWorkspaceRoot(): string | null {
  return dailyRoot;
}

/**
 * The default working directory for shells of notes in `folder`, null for
 * none (Bun spawns in $HOME). An external workspace anchors its shells to the
 * folder the user attached, which is mostly why anyone attaches a project
 * folder. A managed ~/.ledge/<slug>/ gets null: a shell born in a hidden
 * dotfolder helps nobody. A note's own `cwd:` wins over both (notes/store.ts
 * syncParams), and Bun validates the cwd it receives (bun/spawnParams.ts
 * resolveCwd, architecture.md §6a).
 */
export function workspaceDefaultCwd(folder: string): string | null {
  return kinds.get(folder) === "external" ? folder : null;
}

// Test seam: forget every recorded kind (and the daily root).
export function resetWorkspaceKinds(): void {
  kinds.clear();
  dailyRoot = null;
}

export function listWorkspaceRoots(): Promise<WorkspaceRootInfo[]> {
  return bridge().list().then((r) => {
    recordWorkspaceKinds(r.workspaces);
    recordDailyRoot(r.dailyRoot);
    return r.workspaces;
  });
}

// Bun slugs `name` into a fresh managed folder and returns its root handle.
export function createWorkspaceFolder(name: string): Promise<string> {
  return bridge().create(name).then((root) => {
    kinds.set(root, "managed");
    return root;
  });
}

export function attachWorkspaceFolder(): Promise<AttachResult> {
  return bridge().attach().then((res) => {
    if (res.root !== null && res.kind !== null) kinds.set(res.root, res.kind);
    return res;
  });
}

// Deregisters only. The folder and every note in it stay on disk.
export function detachWorkspaceFolder(root: string): Promise<boolean> {
  return bridge().detach(root);
}

// Bun runs the destination picker and the rename, handing back only the new
// root handle. A move can flip the kind: into the app home makes it managed,
// out of it makes it external. The map is re-recorded under the new handle so
// workspaceDefaultCwd sees the flip, since a folder moved out of ~/.ledge now
// anchors its notes' shells. `home` skips the picker and targets the app home.
export function moveWorkspaceFolder(root: string, home = false): Promise<AttachResult> {
  return bridge().move(root, home).then((res) => {
    if (res.root !== null && res.kind !== null) {
      kinds.delete(root);
      kinds.set(res.root, res.kind);
    }
    return res;
  });
}

// The recorded kind of a root, for the surfaces that show or gate per kind.
// The Move Home face exists only for external workspaces, and every read-only
// gate keys off "docs". Like workspaceDefaultCwd, this mirrors Bun-side truth
// and guards nothing. Bun re-derives the kind on every move, and it refuses
// every docs write whatever this map says.
export function workspaceKind(folder: string): "managed" | "external" | "docs" | null {
  return kinds.get(folder) ?? null;
}

// The root handle of the built-in Documentation workspace, the one folder
// whose kind is "docs". It is recorded off the boot workspaceList with the
// other kinds. Null when Bun never reported one (a harness with no docs
// seeded, or a boot that failed), and the Documentation command then hides.
export function docsFolder(): string | null {
  for (const [folder, kind] of kinds) if (kind === "docs") return folder;
  return null;
}

export type { WorkspaceRootInfo };
