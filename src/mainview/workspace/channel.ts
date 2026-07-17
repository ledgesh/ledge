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
  list: () => Promise<WorkspaceRootInfo[]>;
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

// Test seam: forget every recorded kind.
export function resetWorkspaceKinds(): void {
  kinds.clear();
}

export function listWorkspaceRoots(): Promise<WorkspaceRootInfo[]> {
  return bridge().list().then((infos) => {
    recordWorkspaceKinds(infos);
    return infos;
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
