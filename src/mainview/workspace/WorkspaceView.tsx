import { useWorkspace } from "./store";
import { PaneTree } from "./PaneTree";

// The main content area, right of the sidebar: the selected workspace's pane
// tree. The `key` is the workspace id, so switching workspaces remounts this
// subtree (the Swift build did the same with `.id(session.id)`). The editors
// stay in the pool (editorPool.ts), so switching back restores each pane's
// caret, scroll, and inline output.
export function WorkspaceView() {
  const { selected } = useWorkspace();
  return (
    <div key={selected.id} className="h-full w-full min-h-0 min-w-0">
      <PaneTree node={selected.root} />
    </div>
  );
}
