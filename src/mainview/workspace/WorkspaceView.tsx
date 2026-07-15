import { useWorkspace } from "./store";
import { PaneTree } from "./PaneTree";

// The right-hand content: the selected workspace's pane tree. Keyed by workspace
// id so switching workspaces gives a fresh view tree (matching the Swift build's
// `.id(session.id)`); the editors themselves survive in the pool, so switching
// back restores each pane's caret, scroll, and inline output.
export function WorkspaceView() {
  const { selected } = useWorkspace();
  return (
    <div key={selected.id} className="h-full w-full min-h-0 min-w-0">
      <PaneTree node={selected.root} />
    </div>
  );
}
