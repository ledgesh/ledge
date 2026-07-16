import { useCallback, useEffect, useRef, useState } from "react";
import { TerminalSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TerminalDrawer } from "@/terminal/TerminalDrawer";
import { configureBridge } from "@/editor/bridge";
import { sendTerminalText, closeSession, onTerminalExit } from "@/terminal/channel";
import { Sidebar } from "@/workspace/Sidebar";
import { WorkspaceView } from "@/workspace/WorkspaceView";
import { allDocIds, useWorkspace, WorkspaceProvider } from "@/workspace/store";
import { focusedDocId } from "@/workspace/tree";
import { releaseEditor } from "@/workspace/editorPool";

export default function App() {
  return (
    <WorkspaceProvider>
      <Shell />
    </WorkspaceProvider>
  );
}

function Shell() {
  const { state, dispatch, selected } = useWorkspace();
  const [termOpen, setTermOpen] = useState(false);
  // The note whose terminal the drawer shows: the focused pane's active tab. Its
  // docId is the sessionId for that note's per-note terminal shell.
  const activeDocId = focusedDocId(selected);
  // A "run in terminal" fired while the drawer is closed (or for a note other than
  // the one shown) queues its command here and flushes once the terminal for that
  // note has mounted, so its output is not dropped.
  const pending = useRef<{ sessionId: string; cmd: string } | null>(null);

  const runInTerminal = useCallback(
    (sessionId: string, code: string) => {
      const cmd = code.endsWith("\n") ? code : code + "\n";
      if (termOpen && sessionId === activeDocId) {
        sendTerminalText(sessionId, cmd);
      } else {
        pending.current = { sessionId, cmd };
        setTermOpen(true);
      }
    },
    [termOpen, activeDocId],
  );

  // The editor bridges Ctrl+` (toggle) and "run in terminal" here; main.tsx wires
  // the RPC-backed inline-run handler separately, and configureBridge merges.
  useEffect(() => {
    configureBridge({
      toggleTerminal: () => setTermOpen((o) => !o),
      runInTerminal,
    });
  }, [runInTerminal]);

  const onTerminalReady = useCallback(() => {
    if (pending.current) {
      sendTerminalText(pending.current.sessionId, pending.current.cmd);
      pending.current = null;
    }
  }, []);

  // When the shown note's terminal shell exits (the user typed `exit`), close the
  // drawer; Bun has already torn the shell down, so reopening spawns a fresh one.
  useEffect(
    () => onTerminalExit((sid) => { if (sid === activeDocId) setTermOpen(false); }),
    [activeDocId],
  );

  // Tear down a pooled editor AND its per-note shells once the tab (or pane, or
  // workspace) is gone. One reconciliation point covers every close path: diff the
  // live docId set against the previous one and release whatever dropped out.
  const prevDocs = useRef<Set<string>>(new Set());
  useEffect(() => {
    const live = new Set(allDocIds(state));
    for (const id of prevDocs.current) {
      if (!live.has(id)) {
        releaseEditor(id);
        closeSession(id);
      }
    }
    prevDocs.current = live;
  }, [state]);

  // Layout commands, mirroring the Swift menu bar. The editor doesn't bind these,
  // so they bubble to the window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "t" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "newTab" });
      } else if (k === "d" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "splitPane", dir: "row" });
      } else if (k === "d" && e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "splitPane", dir: "col" });
      } else if (k === "w" && e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "closePane" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <span className="h-2 w-2 rounded-full bg-primary" />
        <span className="text-sm font-semibold">Ledge</span>
        <div className="flex-1" />
        <Button
          variant={termOpen ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setTermOpen((o) => !o)}
          title="Toggle terminal (Ctrl+`)"
        >
          <TerminalSquare />
          Terminal
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="min-h-0 min-w-0 flex-1">
            <WorkspaceView />
          </main>
        </div>

        {termOpen && (
          <section className="flex h-[280px] shrink-0 flex-col border-t bg-background">
            <div className="flex h-7 shrink-0 items-center gap-2 border-b px-2">
              <TerminalSquare className="size-3.5 text-muted-foreground" />
              <span className="text-[11px] font-medium text-muted-foreground">Terminal</span>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => setTermOpen(false)}
                title="Close terminal"
              >
                <X className="size-3.5" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden p-1.5">
              {activeDocId ? (
                // Keyed by the note: switching tabs remounts, detaching the old
                // note's shell (it keeps running) and attaching the new note's.
                <TerminalDrawer
                  key={activeDocId}
                  sessionId={activeDocId}
                  onReady={onTerminalReady}
                  onClose={() => setTermOpen(false)}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
                  No note selected
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
