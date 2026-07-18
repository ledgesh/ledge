// The view end of the workspace-registry RPC, mirroring notes/channel.ts:
// workspace/actions.ts calls these, main.tsx binds them to the Electroview RPC,
// the harness binds an in-memory fake. The folder strings crossing here are
// opaque root handles Bun handed out (workspaceList / create / attach); the
// view never constructs one (architecture.md §2).
//
// This module also remembers each root's KIND (managed vs external), recorded
// as the handles come through the wrappers below — the one place every root
// enters the view. The map exists for exactly one consumer: the per-workspace
// default cwd (workspaceDefaultCwd; notes/store.ts merges it into the spawn
// params it sends). It is derived Bun-side truth mirrored for a default, never
// persisted — layout.json must not store kind (architecture.md §2), and a
// stale entry after detach costs nothing because its folder has no notes open.
import type { WorkspaceRootInfo } from "../../shared/rpc-schema";

export interface AttachResult {
  root: string | null;
  kind: "managed" | "external" | null;
  error: string | null;
}

interface WorkspaceHandlers {
  list: () => Promise<{ workspaces: WorkspaceRootInfo[]; dailyRoot: string | null }>;
  create: (name: string) => Promise<string>;
  // Opens the NATIVE folder picker Bun-side; root null + error null = cancelled.
  attach: () => Promise<AttachResult>;
  detach: (root: string) => Promise<boolean>;
}

let handlers: WorkspaceHandlers | null = null;

export function configureWorkspaces(h: WorkspaceHandlers): void {
  handlers = h;
}

function bridge(): WorkspaceHandlers {
  if (!handlers) throw new Error("workspace bridge not configured");
  return handlers;
}

const kinds = new Map<string, "managed" | "external">();

/**
 * Record roots that entered the view outside the wrappers below — the boot
 * fetch in main.tsx (and the harness), which calls the RPC directly.
 */
export function recordWorkspaceKinds(infos: WorkspaceRootInfo[]): void {
  for (const info of infos) kinds.set(info.root, info.kind);
}

// The daily.workspace setting resolved Bun-side to a registered root (null =
// unset/stale), recorded off the same workspaceList response the kinds come
// from. One consumer: the Edit/New Daily Template faces, which must point at
// the workspace ⌘J will actually act in — Bun still re-resolves on every ⌘J,
// so this mirror is display truth, never authority.
let dailyRoot: string | null = null;

/** The boot fetch's share, recordWorkspaceKinds's sibling. */
export function recordDailyRoot(root: string | null): void {
  dailyRoot = root;
}

export function dailyWorkspaceRoot(): string | null {
  return dailyRoot;
}

/**
 * The default working directory for shells of notes in `folder`, or null for
 * "no opinion" ($HOME, Bun's own default). An EXTERNAL workspace anchors its
 * shells to the folder the user attached — that folder being a project
 * directory is the main reason to attach one — while a managed
 * ~/.ledge/<slug>/ stays null: a shell born inside a hidden dotfolder is
 * rarely what anyone wants. A note's own frontmatter `cwd:` beats both
 * (notes/store.ts syncParams), and Bun still validates whatever is sent
 * (bun/spawnParams.ts resolveCwd — a missing dir degrades to $HOME + warning).
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

// Deregisters only — the folder and every note in it stay on disk.
export function detachWorkspaceFolder(root: string): Promise<boolean> {
  return bridge().detach(root);
}

export type { WorkspaceRootInfo };
