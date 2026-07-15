import { useCallback, useEffect, useRef, useState } from "react";
import { TerminalSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TerminalDrawer } from "@/terminal/TerminalDrawer";
import { configureBridge } from "@/editor/bridge";
import { sendTerminalText } from "@/terminal/channel";
import { Sidebar } from "@/workspace/Sidebar";
import { WorkspaceView } from "@/workspace/WorkspaceView";
import { allDocIds, useWorkspace, WorkspaceProvider } from "@/workspace/store";
import { releaseEditor } from "@/workspace/editorPool";

export default function App() {
  return (
    <WorkspaceProvider>
      <Shell />
    </WorkspaceProvider>
  );
}

function Shell() {
  const { state, dispatch } = useWorkspace();
  const [termOpen, setTermOpen] = useState(false);
  // A "run in terminal" fired while the drawer is closed queues its command here
  // and flushes once the terminal has mounted, so its output is not dropped.
  const pending = useRef<string | null>(null);

  const runInTerminal = useCallback(
    (code: string) => {
      const cmd = code.endsWith("\n") ? code : code + "\n";
      if (termOpen) {
        sendTerminalText(cmd);
      } else {
        pending.current = cmd;
        setTermOpen(true);
      }
    },
    [termOpen],
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
      sendTerminalText(pending.current);
      pending.current = null;
    }
  }, []);

  // Tear down a pooled editor once its tab (or pane, or workspace) is gone. One
  // reconciliation point covers every close path: diff the live docId set against
  // the previous one and release whatever dropped out.
  const prevDocs = useRef<Set<string>>(new Set());
  useEffect(() => {
    const live = new Set(allDocIds(state));
    for (const id of prevDocs.current) if (!live.has(id)) releaseEditor(id);
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
              <TerminalDrawer onReady={onTerminalReady} />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
