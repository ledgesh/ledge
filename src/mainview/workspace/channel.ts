// The view end of the workspace-registry RPC, mirroring notes/channel.ts.
// workspace/actions.ts calls these, boot.tsx binds them to the server's RPC,
// the harness binds an in-memory fake. The folder strings crossing here are
// opaque root handles Bun handed out (workspaceList, create, attach); the
// view never constructs one (architecture.md §2). The one string that is not
// a handle is the path `attach` sends, typed or picked, which the server
// checks before it becomes one.

// This module also records each root's kind (managed, external, or docs) as
// the handles pass through the wrappers below. workspaceDefaultCwd,
// workspaceKind and docsFolder read the map. It mirrors Bun-side truth and is
// never persisted: layout.json must not store kind (architecture.md §6a). A
// stale entry after a detach is harmless: its folder has no notes open.
import { useSyncExternalStore } from "react";
import type { TrashedWorkspace, WorkspaceRootInfo } from "../../shared/rpc-schema";

export interface AttachResult {
  root: string | null;
  kind: "managed" | "external" | null;
  error: string | null;
}

interface WorkspaceHandlers {
  list: () => Promise<{ workspaces: WorkspaceRootInfo[]; dailyRoot: string | null }>;
  create: (name: string) => Promise<string>;
  // Registers the folder at `path` on the server, which checks the path. A
  // null root comes with the refusal in `error`.
  attach: (path: string) => Promise<AttachResult>;
  detach: (root: string) => Promise<boolean>;
  // This client's own folder dialog, for the field `attach` sends. Null where
  // the user cancelled, or where this client has none (lib/shell.ts
  // picksFolders says so before this is called).
  pickFolder: () => Promise<string | null>;
  // Moves a managed root's folder into the app home's trash, storing the
  // display name and icon beside it. An id for the entry, or a refusal.
  trash: (root: string, name: string, symbol: string) => Promise<{ id: string | null; error: string | null }>;
  trashList: () => Promise<TrashedWorkspace[]>;
  restore: (id: string) => Promise<{ root: string | null; name: string; symbol: string; error: string | null }>;
  removeTrashed: (id: string) => Promise<boolean>;
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

export function attachWorkspaceFolder(path: string): Promise<AttachResult> {
  return bridge().attach(path).then((res) => {
    if (res.root !== null && res.kind !== null) kinds.set(res.root, res.kind);
    return res;
  });
}

/** A folder from this client's own dialog, as a path for the attach field. */
export function pickFolderPath(): Promise<string | null> {
  return bridge().pickFolder();
}

// Deregisters only. The folder and every note in it stay on disk.
export function detachWorkspaceFolder(root: string): Promise<boolean> {
  return bridge().detach(root);
}

// Moves a managed workspace's folder into the trash. The mirror below
// refreshes either way, since a refusal can follow a change another client
// made.
export function trashWorkspaceFolder(
  root: string,
  name: string,
  symbol: string,
): Promise<{ id: string | null; error: string | null }> {
  return bridge().trash(root, name, symbol).finally(() => void refreshTrashedWorkspaces());
}

export function restoreTrashedWorkspace(
  id: string,
): Promise<{ root: string | null; name: string; symbol: string; error: string | null }> {
  return bridge().restore(id).then((res) => {
    if (res.root !== null) kinds.set(res.root, "managed");
    return res;
  }).finally(() => void refreshTrashedWorkspaces());
}

export function deleteTrashedWorkspace(id: string): Promise<boolean> {
  return bridge().removeTrashed(id).finally(() => void refreshTrashedWorkspaces());
}

// The deleted workspaces the strip's Trash section shows, mirrored from the
// server like the kinds above. A module mirror rather than AppState, since
// only that section reads it (architecture.md §5).
let trashed: TrashedWorkspace[] = [];
const trashListeners = new Set<() => void>();

export function refreshTrashedWorkspaces(): Promise<void> {
  return bridge().trashList().then(
    (items) => {
      trashed = items;
      for (const fn of trashListeners) fn();
    },
    (err) => console.error("[workspace] trash list failed", err),
  );
}

export function trashedWorkspace(id: string): TrashedWorkspace | undefined {
  return trashed.find((t) => t.id === id);
}

export function useTrashedWorkspaces(): TrashedWorkspace[] {
  return useSyncExternalStore(
    (fn) => {
      trashListeners.add(fn);
      return () => trashListeners.delete(fn);
    },
    () => trashed,
  );
}

// The recorded kind of a root, for the surfaces that show or gate per kind:
// every read-only gate keys off "docs". Like workspaceDefaultCwd, this mirrors
// Bun-side truth and guards nothing. Bun refuses every docs write whatever
// this map says.
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

export type { TrashedWorkspace, WorkspaceRootInfo };
