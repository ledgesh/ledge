import { useCallback, useEffect, useRef, useState } from "react";
import { PanelLeft, TerminalSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResizeHandle } from "@/components/ResizeHandle";
import { TerminalDrawer } from "@/terminal/TerminalDrawer";
import { configureBridge } from "@/editor/bridge";
import { sendTerminalPaste, closeSession, onTerminalExit } from "@/terminal/channel";
import { Sidebar } from "@/workspace/Sidebar";
import { WorkspaceView } from "@/workspace/WorkspaceView";
import { flushAll } from "@/notes/store";
import { listNotes } from "@/notes/channel";
import { refreshTrash } from "@/notes/actions";
import { allDocIds, useWorkspace, WorkspaceProvider, type AppState } from "@/workspace/store";
import { focusedDocId } from "@/workspace/tree";
import { releaseEditor } from "@/workspace/editorPool";
import { CommandProvider, useCommands } from "@/commands/CommandProvider";
import { configureUi } from "@/commands/glue";
import { tooltip } from "@/commands/format";
import { Overlay, type OverlayMode } from "@/commands/Overlay";

// `initial` is built in main.tsx from the notes already on disk, so the very
// first render has the right note in its tab.
export default function App({ initial }: { initial: AppState }) {
  return (
    <WorkspaceProvider initial={initial}>
      <CommandProvider>
        <Shell />
      </CommandProvider>
    </WorkspaceProvider>
  );
}

// Sidebar width bounds (px); the terminal's max is measured against the live
// content height so the editor can't be squeezed away.
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 460;
const TERM_MIN = 140;
const EDITOR_MIN = 160; // space the editor row keeps when the terminal grows

function Shell() {
  const { state, dispatch, selected } = useWorkspace();
  const { exec } = useCommands();
  const [termOpen, setTermOpen] = useState(false);
  const [termHeight, setTermHeight] = useState(280);
  const [sidebarWidth, setSidebarWidth] = useState(224);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [overlay, setOverlay] = useState<OverlayMode | null>(null);
  // The vertical stack (below the header) that holds the editor row and the
  // terminal drawer; its height bounds how tall the terminal can grow.
  const stackRef = useRef<HTMLDivElement>(null);

  const resizeSidebar = useCallback((w: number) => {
    setSidebarWidth(Math.max(SIDEBAR_MIN, Math.min(w, SIDEBAR_MAX)));
  }, []);
  const resizeTerm = useCallback((h: number) => {
    const avail = stackRef.current?.clientHeight ?? window.innerHeight;
    setTermHeight(Math.max(TERM_MIN, Math.min(h, avail - EDITOR_MIN)));
  }, []);
  // The note whose terminal the drawer shows: the focused pane's active tab. Its
  // docId is the sessionId for that note's per-note terminal shell.
  const activeDocId = focusedDocId(selected);
  // A "run in terminal" fired while the drawer is closed (or for a note other than
  // the one shown) queues its command here and flushes once the terminal for that
  // note has mounted, so its output is not dropped.
  const pending = useRef<{ sessionId: string; cmd: string } | null>(null);

  const runInTerminal = useCallback(
    (sessionId: string, code: string) => {
      // Bun wraps this as a bracketed paste and gates it on the shell being ready,
      // so it is safe to fire even the instant a lazily-spawned shell starts.
      if (termOpen && sessionId === activeDocId) {
        sendTerminalPaste(sessionId, code);
      } else {
        pending.current = { sessionId, cmd: code };
        setTermOpen(true);
      }
    },
    [termOpen, activeDocId],
  );

  // Shell owns the chrome state (terminal drawer, sidebar, overlay), so it
  // registers the ui hooks the command registry reaches them through. The
  // editor bridge routes its Ctrl+` through the same command, so the header
  // button, the editor keymap, the window hotkey, and the palette all converge
  // on one implementation; main.tsx wires the RPC-backed inline-run handler
  // separately, and configureBridge merges.
  useEffect(() => {
    configureUi({
      toggleTerminal: () => setTermOpen((o) => !o),
      closeTerminal: () => setTermOpen(false),
      toggleSidebar: () => setSidebarOpen((o) => !o),
      openOverlay: setOverlay,
    });
  }, []);
  useEffect(() => {
    configureBridge({
      toggleTerminal: () => exec("terminal.toggle"),
      runInTerminal,
    });
  }, [exec, runInTerminal]);

  const onTerminalReady = useCallback(() => {
    if (pending.current) {
      sendTerminalPaste(pending.current.sessionId, pending.current.cmd);
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

  // Notes autosave on a short debounce, so the only real exposure is quitting (or
  // crashing) inside that window. Flushing when the window loses focus and on
  // pagehide narrows it to the case where you edit and quit in the same instant.
  //
  // Re-reading the folder on the way back in is the mirror image: there is no file
  // watcher yet, so this is what notices a note you created or deleted in the
  // terminal while Ledge was in the background.
  useEffect(() => {
    const refresh = () => {
      void listNotes()
        .then((notes) => dispatch({ type: "notesLoaded", notes }))
        .catch((err) => console.error("[notes] refresh failed", err));
      // The trash is read on the same trip: it is a folder like any other, and a
      // note deleted (or restored) from a shell should not leave a stale count.
      void refreshTrash(dispatch);
    };
    window.addEventListener("blur", flushAll);
    window.addEventListener("pagehide", flushAll);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("blur", flushAll);
      window.removeEventListener("pagehide", flushAll);
      window.removeEventListener("focus", refresh);
    };
  }, [dispatch]);

  // Suppress the WebView's native context menu app-wide. In this dev WKWebView it
  // carries only debug items (Reload, Inspect Element), unwanted in a notes app.
  // Our own right-click menus (e.g. the workspace strip) call preventDefault in
  // their handlers and render custom menus, so this doesn't interfere with them.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  // Hotkeys live in the command registry (commands/keys.ts); CommandProvider
  // installs the single window-level dispatcher that replaced the ad-hoc
  // keydown handlers that used to sit here.

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <Button
          variant={sidebarOpen ? "secondary" : "ghost"}
          size="icon"
          className="size-7"
          onClick={() => exec("sidebar.toggle")}
          title={tooltip("sidebar.toggle")}
        >
          <PanelLeft className="size-4" />
        </Button>
        <span className="h-2 w-2 rounded-full bg-primary" />
        <span className="text-sm font-semibold">Ledge</span>
        <div className="flex-1" />
        <Button
          variant={termOpen ? "secondary" : "ghost"}
          size="sm"
          onClick={() => exec("terminal.toggle")}
          title={tooltip("terminal.toggle")}
        >
          <TerminalSquare />
          Terminal
        </Button>
      </header>

      <div ref={stackRef} className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          {sidebarOpen && (
            <>
              <div style={{ width: sidebarWidth }} className="min-w-0 shrink-0">
                <Sidebar />
              </div>
              <ResizeHandle
                axis="x"
                current={sidebarWidth}
                onResize={resizeSidebar}
                title="Drag to resize workspaces"
              />
            </>
          )}
          <main className="min-h-0 min-w-0 flex-1">
            <WorkspaceView />
          </main>
        </div>

        {termOpen && (
          <ResizeHandle
            axis="y"
            invert
            current={termHeight}
            onResize={resizeTerm}
            title="Drag to resize terminal"
          />
        )}
        {termOpen && (
          <section style={{ height: termHeight }} className="flex shrink-0 flex-col bg-background">
            <div className="flex h-7 shrink-0 items-center gap-2 border-b px-2">
              <TerminalSquare className="size-3.5 text-muted-foreground" />
              <span className="text-[11px] font-medium text-muted-foreground">Terminal</span>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => exec("terminal.close")}
                title={tooltip("terminal.close")}
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

      {overlay && <Overlay initialMode={overlay} onClose={() => setOverlay(null)} />}
    </div>
  );
}
