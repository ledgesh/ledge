import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CircleHelp, Hash, Link2, PanelLeft, Search, TableOfContents, TerminalSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSinglePane } from "@/lib/viewport";
import { hasTerminal } from "@/lib/shell";
import { pushLayer } from "@/commands/layers";
import { ResizeHandle } from "@/components/ResizeHandle";
import { TerminalDrawer } from "@/terminal/TerminalDrawer";
import { configureBridge, requestHostPick, type HostPickRequest, type RunConfirmRequest } from "@/editor/bridge";
import { sendTerminalPaste, closeSession, onTerminalExit, terminalStatus } from "@/terminal/channel";
import { Sidebar } from "@/workspace/Sidebar";
import { BacklinksPanel } from "@/workspace/BacklinksPanel";
import { OutlinePanel } from "@/workspace/OutlinePanel";
import { TagsPanel } from "@/workspace/TagsPanel";
import { WorkspaceView } from "@/workspace/WorkspaceView";
import { HostPicker } from "@/components/HostPicker";
import { LOCAL_HOST } from "../shared/frontmatter";
import { flushAll, folderOf, paramsOf } from "@/notes/store";
import { parseWikiTarget, resolveWikiTitle } from "@/editor/wikilinks";
import { refreshWikilinks } from "@/editor/livePreview";
import { refreshFolder } from "@/workspace/actions";
import { docsFolder, workspaceKind } from "@/workspace/channel";
import { allDocIds, notesOf, useWorkspace, WorkspaceProvider, type AppState } from "@/workspace/store";
import { flushLayout, scheduleLayoutSave } from "@/workspace/persist";
import { findTabBy, focusedDocId } from "@/workspace/tree";
import { allEditorViews, configureLockedUi, releaseEditor, reloadOpenNotes, requestHeadingReveal } from "@/workspace/editorPool";
import { VaultDialog } from "@/components/VaultDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { lockNoteAndRefresh, removeLockAndRefresh } from "@/vault/channel";
import type { VaultFollowUp } from "@/commands/types";
import { listTags, onExternalOpen, onNotesChanged, takeOpenRequest, type ExternalOpenInfo } from "@/notes/channel";
import type { TagInfo } from "../shared/tags";
import { CommandProvider, useCommands } from "@/commands/CommandProvider";
import { ProfileEditor } from "@/components/ProfileEditor";
import { SettingsEditor } from "@/components/SettingsEditor";
import { ConnectionPicker } from "@/components/ConnectionPicker";
import { configureUi, uiHooks } from "@/commands/glue";
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

// A side panel that covers the editor instead of taking width from it: the
// arrangement below PANES_MIN_WIDTH (lib/viewport.ts, ios.md §9). A phone that
// gave the sidebar its usual 224 points would leave the editor 165, which is
// the arrangement phase 2 shipped and called bad; this is the answer.
//
// 280 points, and no resize handle: the handle is a drag target for a pointer,
// and on the client this exists for there is no pointer to drag it with. 280
// of a phone's 390 also leaves 110 of the editor showing under the scrim,
// which is what says the thing behind is still there. The 85% is for the
// narrow end — a 320-point phone would otherwise get a drawer with almost no
// editor beside it.
function Drawer({
  side,
  onClose,
  children,
}: {
  side: "left" | "right";
  onClose: () => void;
  children: ReactNode;
}) {
  // A dismissible surface over the app is a modal layer like any other
  // (interactions.md §6), so Escape closes it and the topmost-only rule sorts
  // out a row menu opened inside it. The keyboard suppression that comes with
  // being a layer costs nothing on the client this is for and is right on a
  // narrowed window: the drawer is covering the app.
  useEffect(() => pushLayer("overlay", onClose), [onClose]);
  return (
    <>
      {/* onClick, not onPointerDown: WebKit sends a click after every touch,
          and closing on the down would hand that click to whatever the drawer
          was covering — the bug phase 2 found under the row menus. The
          target check is ConfirmDialog's: a drag that starts inside and
          releases out here must not dismiss. */}
      <div
        className="absolute inset-0 z-30 bg-black/40"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      />
      <aside
        className={cn(
          "absolute inset-y-0 z-40 w-[min(280px,85%)] bg-background shadow-xl",
          side === "left" ? "left-0 border-r" : "right-0 border-l",
        )}
      >
        {children}
      </aside>
    </>
  );
}

function Shell() {
  const { state, dispatch, selected } = useWorkspace();
  const { exec } = useCommands();
  // Whether the side panels take width or cover the editor (lib/viewport.ts).
  // Live rather than boot-static, so a rotated phone and a dragged window both
  // land in the arrangement that fits.
  const singlePane = useSinglePane();
  const [termOpen, setTermOpen] = useState(false);
  const [termHeight, setTermHeight] = useState(280);
  const [sidebarWidth, setSidebarWidth] = useState(224);
  // Open by default where it is a pane, closed where it is a drawer: a phone
  // that booted behind a scrim would be showing its chrome instead of the note
  // the last session left focused.
  const [sidebarOpen, setSidebarOpen] = useState(!singlePane);
  // The right-hand panel: one slot, three faces (Backlinks, Outline, Tags) —
  // the toggles are radio-with-off, opening one closes the others. Closed by
  // default (it earns its width per session), sized within the sidebar's own
  // bounds — the two sides are mirrors. The width is the SLOT's, shared by
  // all faces, so swapping faces doesn't reflow the editor.
  const [rightPanel, setRightPanel] = useState<"backlinks" | "outline" | "tags" | null>(null);
  const [rightWidth, setRightWidth] = useState(260);
  // The tag the Tags face is drilled into, or null for the directory. Shell's
  // because clicks elsewhere route INTO it (ui.showTag): a rendered #tag in
  // the editor and a tag row in the overlay both land here. It survives face
  // swaps and toggles — the back affordance is one click, and losing the
  // drill-in every time the panel blinks would punish the routing that makes
  // it useful.
  const [tagShown, setTagShown] = useState<string | null>(null);

  // The two side panels are panes on a desktop and drawers on a phone, and the
  // difference the toggles have to know about is that two drawers do not
  // coexist: §9's tree is single-PANE, and stacking a second scrim on the
  // first would cover a 390-point screen twice over. Read through refs because
  // configureUi below binds these once, at mount, and a captured `singlePane`
  // would still be the boot value after the first rotation.
  const singlePaneRef = useRef(singlePane);
  singlePaneRef.current = singlePane;
  const sidebarOpenRef = useRef(sidebarOpen);
  sidebarOpenRef.current = sidebarOpen;
  const rightPanelRef = useRef(rightPanel);
  rightPanelRef.current = rightPanel;

  const openSidebar = useCallback((open: boolean) => {
    if (open && singlePaneRef.current) setRightPanel(null);
    setSidebarOpen(open);
  }, []);
  const openRightPanel = useCallback((face: "backlinks" | "outline" | "tags" | null) => {
    if (face !== null && singlePaneRef.current) setSidebarOpen(false);
    setRightPanel(face);
  }, []);
  // Stable identities: each is a <Drawer>'s onClose, and the layer it pushes
  // is keyed on that function — a fresh one per render would unregister and
  // re-register the Escape handler on every keystroke in the note behind it.
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const closeRightPanel = useCallback(() => setRightPanel(null), []);

  // The one "land on this tag" move, shared by the ui hook (panel/overlay
  // rows via tag.open) and the editor bridge (clicked #tags): open the Tags
  // face drilled into it.
  const showTag = useCallback(
    (tag: string) => {
      setTagShown(tag);
      openRightPanel("tags");
    },
    [openRightPanel],
  );
  // Mode plus the seed for its input (note.fromTemplate opens the palette
  // pre-filtered; every other opener seeds ""). `seq` increments on every
  // open and keys the <Overlay>, forcing a REMOUNT even when one is already
  // up: the component reads initialQuery/initialMode into state at mount, so
  // without the new key, a command run from inside the palette that re-opens
  // it (note.fromTemplate, palette.notes) would leave the old input text on
  // screen — an exec that visibly did nothing. The counter is a ref, NOT
  // derived from the previous overlay state: the palette row's Enter closes
  // (state → null) before the command re-opens, and a null-derived counter
  // would land back on the same seq — same key, no remount, the very bug.
  const overlaySeq = useRef(0);
  const [overlay, setOverlay] = useState<{ mode: OverlayMode; query: string; seq: number } | null>(null);
  // The profile the editor dialog is open on, or null. Shell owns it like the
  // rest of the chrome: the command reaches it through the ui hook below.
  const [profileEditing, setProfileEditing] = useState<string | null>(null);
  // The ⌘, settings editor dialog (settings.jsonc in an in-app CodeMirror).
  const [settingsEditing, setSettingsEditing] = useState(false);
  const [pickingConnection, setPickingConnection] = useState(false);
  // The vault passphrase dialog, carrying the act that was waiting on it
  // (lock this note, remove that lock) — App performs the follow-up on
  // success, so the user's intent completes instead of dead-ending at the
  // prompt (locking.md §7). null = closed.
  const [vaultDialog, setVaultDialog] = useState<{ then?: VaultFollowUp } | null>(null);
  // The Remove Lock confirmation's subject, or null. A confirm because the
  // consequence is silent EXPOSURE (sync and agent scans see the body), not
  // because anything is destroyed.
  const [removeLockConfirm, setRemoveLockConfirm] = useState<{ path: string; title: string; folder: string } | null>(null);
  // The vertical stack (below the header) that holds the editor row and the
  // terminal drawer; its height bounds how tall the terminal can grow.
  const stackRef = useRef<HTMLDivElement>(null);

  const resizeSidebar = useCallback((w: number) => {
    setSidebarWidth(Math.max(SIDEBAR_MIN, Math.min(w, SIDEBAR_MAX)));
  }, []);
  const resizeRight = useCallback((w: number) => {
    setRightWidth(Math.max(SIDEBAR_MIN, Math.min(w, SIDEBAR_MAX)));
  }, []);
  // Crossing INTO the drawer arrangement closes whatever was open, so a window
  // dragged narrow does not land with its editor behind a scrim it never asked
  // for. Deliberately one-way: coming back out does not reopen, because a pane
  // that reappears on its own is harder to explain than one that stayed shut,
  // and the toggle is right there in the header either way.
  useEffect(() => {
    if (!singlePane) return;
    setSidebarOpen(false);
    setRightPanel(null);
  }, [singlePane]);

  // A drawer's job ends when you pick something out of it. This covers every
  // route into a note — a row in the browser, a tab, a workspace, a wikilink,
  // the palette — because all of them land on a different focused doc. Picking
  // the note that is already focused changes nothing and so closes nothing,
  // which is the one case that reads as a dead tap; it is also the one case
  // where leaving the drawer up costs the user nothing.
  const focusedDoc = focusedDocId(selected);
  useEffect(() => {
    if (singlePane) setSidebarOpen(false);
  }, [singlePane, focusedDoc, selected.id]);

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
  const pending = useRef<{ sessionId: string; cmd: string; language: string | null; host: string | null } | null>(
    null,
  );
  // The open host-picker request, if any (multi-host note about to run/spawn).
  const [hostPick, setHostPick] = useState<HostPickRequest | null>(null);
  // The open run confirmation, if any: a block marked `confirm` on its fence
  // (or in a `confirm: true` note) that has not been answered yet. Nothing has
  // executed while this is up — the dialog IS the run's first step.
  const [runConfirm, setRunConfirm] = useState<RunConfirmRequest | null>(null);
  // The machine the drawer's shell is on (attach response), for the badge.
  const [termHost, setTermHost] = useState<string | null>(null);
  // The host picked for the NEXT drawer spawn. A ref, not state: it is consumed
  // by the mount that follows the very setTermOpen that reads it, and must
  // never linger — the doc-change effect below clears it so a tab switch spawns
  // on the new note's own frontmatter default, not a stale pick.
  const spawnHost = useRef<string | null>(null);
  useEffect(() => {
    spawnHost.current = null;
    setTermHost(null); // the badge describes one note's shell; never carry it across
  }, [activeDocId]);
  useEffect(() => {
    if (!termOpen) setTermHost(null);
  }, [termOpen]);

  // The header Terminal button: the anchor for pickers with no better one
  // (the ⌃` toggle, a run whose block position is unknown).
  const termBtnRef = useRef<HTMLButtonElement>(null);
  const headerPickAnchor = () => {
    const r = termBtnRef.current?.getBoundingClientRect();
    return r ? { x: r.right - 200, y: r.bottom + 6 } : { x: window.innerWidth - 240, y: 48 };
  };

  const runInTerminal = useCallback(
    (
      sessionId: string,
      code: string,
      language: string | null,
      hosts: string[],
      anchor?: { x: number; y: number },
      confirm?: { message: string | null } | null,
    ) => {
      const proceed = (host: string | null) => {
        // Bun wraps this as a bracketed paste and gates it on the shell being ready,
        // so it is safe to fire even the instant a lazily-spawned shell starts.
        if (termOpen && sessionId === activeDocId) {
          sendTerminalPaste(sessionId, code, language, host);
          return;
        }
        // The block can live in an unfocused pane: its buttons are in the overlay
        // layer parented to <body>, so clicking one never hits the pane's
        // focus-on-mousedown handler. The drawer always shows the focused pane's
        // note, so focus the note's pane first — otherwise the drawer opens on
        // some other note and the paste runs in a shell nothing is showing.
        if (sessionId !== activeDocId) {
          const hit = findTabBy(selected.root, (t) => t.docId === sessionId);
          if (hit) dispatch({ type: "selectTab", paneId: hit.paneId, tabId: hit.tabId });
        }
        pending.current = { sessionId, cmd: code, language, host };
        spawnHost.current = host;
        setTermOpen(true);
      };
      // The confirmation, when the block asked for one, sits between the
      // settled machine and the paste (interactions.md §4b) — after the
      // picker, so the question can name the machine. `named` is the host the
      // dialog may claim: null past a LIVE shell, which runs wherever it
      // already is (the drawer's badge is what says where), so the dialog says
      // "this note's terminal" rather than guessing the list's first entry.
      const gate = (named: string | null, run: () => void) => {
        if (!confirm) {
          run();
          return;
        }
        setRunConfirm({
          message: confirm.message,
          code,
          lang: language,
          host: named,
          destination: "terminal",
          onConfirm: run,
        });
      };
      // Only a spawn-to-be warrants the picker: a live drawer shell has one
      // host for its whole life, and the paste can only go there (the badge
      // says where that is). Restart Note Shell is the way to move it.
      void terminalStatus(sessionId).then(({ live }) => {
        const first = hosts[0] ?? null;
        if (live) gate(null, () => proceed(first));
        else if (hosts.length <= 1) gate(first, () => proceed(first));
        else {
          requestHostPick(sessionId, {
            hosts,
            anchor: anchor ?? headerPickAnchor(),
            onPick: (host) => gate(host, () => proceed(host)),
          });
        }
      });
    },
    [termOpen, activeDocId, selected.root, dispatch],
  );

  // Shell owns the chrome state (terminal drawer, sidebar, overlay), so it
  // registers the ui hooks the command registry reaches them through. The
  // editor bridge routes its Ctrl+` through the same command, so the header
  // button, the editor keymap, the window hotkey, and the palette all converge
  // on one implementation; main.tsx wires the RPC-backed inline-run handler
  // separately, and configureBridge merges.
  // The toggle needs the CURRENT note and drawer state, but configureUi is
  // registered once; refs carry the latest values into that stable closure.
  const termOpenRef = useRef(termOpen);
  termOpenRef.current = termOpen;
  const activeDocRef = useRef(activeDocId);
  activeDocRef.current = activeDocId;
  // The wikilink handlers below resolve against the store's CURRENT note
  // lists; the bridge registration is a stable closure, so a ref carries them.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    configureUi({
      toggleTerminal: () => {
        if (termOpenRef.current) {
          setTermOpen(false);
          return;
        }
        // Opening the drawer on a multi-host note whose shell is not alive is
        // a spawn: the machine must be chosen before it happens. Single-host
        // and local notes open silently, spawning on their frontmatter's own
        // answer; a live shell reopens wherever it already is.
        const sid = activeDocRef.current;
        const hosts = sid ? (paramsOf(sid)?.hosts ?? []) : [];
        if (!sid || hosts.length <= 1) {
          spawnHost.current = hosts[0] ?? null;
          setTermOpen(true);
          return;
        }
        void terminalStatus(sid).then(({ live }) => {
          if (live) {
            setTermOpen(true);
            return;
          }
          requestHostPick(sid, {
            hosts,
            anchor: headerPickAnchor(),
            onPick: (host) => {
              spawnHost.current = host;
              setTermOpen(true);
            },
          });
        });
      },
      closeTerminal: () => setTermOpen(false),
      toggleSidebar: () => openSidebar(!sidebarOpenRef.current),
      toggleBacklinks: () => openRightPanel(rightPanelRef.current === "backlinks" ? null : "backlinks"),
      toggleOutline: () => openRightPanel(rightPanelRef.current === "outline" ? null : "outline"),
      toggleTags: () => openRightPanel(rightPanelRef.current === "tags" ? null : "tags"),
      showTag,
      openOverlay: (mode, initialQuery) => {
        overlaySeq.current += 1;
        setOverlay({ mode, query: initialQuery ?? "", seq: overlaySeq.current });
      },
      openProfileEditor: setProfileEditing,
      openSettingsEditor: () => setSettingsEditing(true),
      openConnectionPicker: () => setPickingConnection(true),
      openVaultDialog: (then) => setVaultDialog({ then }),
      confirmRemoveLock: setRemoveLockConfirm,
    });
    // The locked placeholder's Unlock button runs the same vault.unlock the
    // palette runs — the pool reaches it through its own configureX seam
    // (it cannot import the registry without a cycle).
    configureLockedUi({ requestUnlock: () => exec("vault.unlock") });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    configureBridge({
      toggleTerminal: () => exec("terminal.toggle"),
      runInTerminal,
      // The host picker is Shell-rendered chrome like every dialog; the editor
      // reaches it through the bridge (blocks.ts requestHostPick).
      pickHost: setHostPick,
      // Same stance for the run confirmation: Shell renders every dialog, the
      // editor asks for one.
      confirmRun: setRunConfirm,
      // The ⌘-clicked frontmatter profile name lands on the same dialog as
      // the "Edit Note Profile…" command.
      openProfileEditor: setProfileEditing,
      // The editor's refusal notices (a prompt fence in a locked note) land
      // on the browser's notice strip like every other neutral outcome.
      notice: (message) => uiHooks.showNotice?.(message),
      // Wikilinks resolve against the note's OWN workspace list — the same
      // scoping stance as the browser and the overlays. Both stay view-side:
      // the resolved path is one Bun handed the store, and openNote is a
      // plain dispatch, so no new path shape crosses the RPC.
      wikiNotes: (docId) => {
        const folder = folderOf(docId);
        return folder ? notesOf(stateRef.current, folder) : [];
      },
      openWikiNote: (docId, target) => {
        const folder = folderOf(docId);
        if (!folder) return;
        const parsed = parseWikiTarget(target);
        if (!parsed) return;
        const note = resolveWikiTitle(parsed.title, notesOf(stateRef.current, folder));
        if (!note) return;
        // The reveal is registered before the open — the Overlay's search
        // pattern: openNote's render is what attaches the editor it lands in.
        if (parsed.heading) requestHeadingReveal(note.path, parsed.heading);
        dispatch({ type: "openNote", note });
      },
      // The # completion's vocabulary: the per-folder snapshot kept fresh
      // below. Synchronous like wikiNotes — a decoration/completion pass
      // cannot await.
      workspaceTags: (docId) => {
        const folder = folderOf(docId);
        return folder ? (tagVocab.current.get(folder) ?? []) : [];
      },
      // A clicked #tag (rendered, frontmatter, or via the Open Link command)
      // lands where every tag click lands.
      openTag: (_docId, tag) => showTag(tag),
    });
  }, [exec, runInTerminal, dispatch, showTag]);

  // The tag vocabulary the # completion reads (bridge workspaceTags above):
  // the selected workspace's directory, refetched when its note lists change
  // — the same freshness signal the wikilink redraw below rides. A ref, not
  // state: nothing renders from it, the completion reads it on demand.
  const tagVocab = useRef(new Map<string, TagInfo[]>());
  useEffect(() => {
    const folder = selected.folder;
    void listTags(folder).then(
      (t) => tagVocab.current.set(folder, t.tags),
      () => {
        // A failed scan keeps the last snapshot: a stale vocabulary beats an
        // empty popup during a transient (unmounted volume mid-session).
      },
    );
  }, [state.notes, selected.folder]);

  // A note list changed (created, renamed, deleted, refreshed): every pooled
  // editor redraws its wikilinks, so a dangling link resolves the moment its
  // note comes to exist — and un-resolves when it goes.
  useEffect(() => {
    for (const view of allEditorViews()) refreshWikilinks(view);
  }, [state.notes]);

  const onTerminalReady = useCallback(() => {
    if (pending.current) {
      sendTerminalPaste(pending.current.sessionId, pending.current.cmd, pending.current.language, pending.current.host);
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

  // Session persistence: every change to the workspace/pane/tab arrangement
  // (or which workspace is selected) schedules a debounced layout save. Keyed
  // on those two fields rather than the whole state, so a notes-folder refresh
  // does not rewrite a layout that did not change.
  useEffect(() => {
    scheduleLayoutSave(state);
  }, [state.workspaces, state.selectedId]);

  // Notes autosave on a short debounce, so the only real exposure is quitting (or
  // crashing) inside that window. Flushing when the window loses focus and on
  // pagehide narrows it to the case where you edit and quit in the same instant.
  // The layout save above debounces the same way, so it flushes on the same
  // events for the same reason.
  //
  // Re-reading the folders on the way back in is the mirror image: there is no
  // file watcher yet, so this is what notices a note you created or deleted in
  // the terminal while Ledge was in the background. EVERY workspace's folder,
  // not just the selected one — switching workspaces does not leave the window,
  // so a selected-only refresh would show weeks-stale lists after a switch. One
  // folder failing (its volume unmounted mid-session) costs that folder's
  // refresh and nothing else (refreshFolder catches per call). The trash rides
  // the same trip: it is a folder like any other, and a note deleted (or
  // restored) from a shell should not leave a stale count.
  const folders = state.workspaces.map((w) => w.folder);
  const foldersKey = folders.join("\n");
  useEffect(() => {
    const flush = () => {
      flushAll();
      flushLayout();
    };
    const refresh = () => {
      for (const folder of folders) void refreshFolder(folder, dispatch);
      // Open, unedited notes follow their files too — an agent may have
      // rewritten one while Ledge was in the background.
      void reloadOpenNotes();
    };
    window.addEventListener("blur", flush);
    window.addEventListener("pagehide", flush);
    window.addEventListener("focus", refresh);
    // The watcher's push (rpc notesChanged) is the same refresh, scoped to the
    // one root that changed and arriving WITHOUT a focus change — the agent
    // working in the note's own terminal drawer never blurs the window.
    const offChanged = onNotesChanged((root) => {
      if (folders.includes(root)) void refreshFolder(root, dispatch);
      void reloadOpenNotes();
    });
    return () => {
      window.removeEventListener("blur", flush);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("focus", refresh);
      offChanged();
    };
    // Keyed on the folder LIST (joined), not the array identity: workspaces
    // re-render often, their folder set changes rarely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, foldersKey]);

  // `ledge <title>`: an open request from the CLI. Bun already resolved the
  // title and guarded the path (bun/openRequest.ts); the view's whole share
  // is selecting the workspace that shows the note's root, then the ordinary
  // openNote (whose fresh-tab branch lands in the SELECTED workspace — hence
  // the select first; its already-open branch finds a live tab anywhere on
  // its own). A root no workspace shows is dropped with a warning rather
  // than grown a workspace: the layout self-heals per workspace
  // (architecture.md §6) and this path must not bypass that. Subscription
  // first, THEN the one-shot boot pull — the pull exists precisely because a
  // push at boot could fire before anyone listens. Workspaces are read
  // through a ref: the handler needs whatever exists at event time, not a
  // resubscribe per state change.
  const wsRef = useRef(state.workspaces);
  wsRef.current = state.workspaces;
  useEffect(() => {
    const openExternal = (open: ExternalOpenInfo) => {
      const ws = wsRef.current.find((w) => w.folder === open.root);
      if (!ws) {
        console.warn("[cli] no workspace shows", open.root, "— ignoring the open request for", open.path);
        return;
      }
      dispatch({ type: "selectWorkspace", id: ws.id });
      dispatch({ type: "openNote", note: { path: open.path, title: open.title, mtimeMs: open.mtimeMs } });
    };
    const off = onExternalOpen(openExternal);
    void takeOpenRequest().then((open) => {
      if (open) openExternal(open);
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // The right-hand slot's current face, named once because it renders in two
  // arrangements — a pane beside the editor, a drawer over it — and both must
  // show the same thing.
  const rightFace =
    rightPanel === "backlinks" ? (
      <BacklinksPanel />
    ) : rightPanel === "outline" ? (
      <OutlinePanel />
    ) : (
      <TagsPanel tag={tagShown} onBack={() => setTagShown(null)} />
    );

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
        {/* The overlay's control in the chrome (interactions.md §1a). ⌘P and
            ⇧⌘P are chords, and a touch client has none — without this, the one
            surface that carries every command would be unreachable there, and
            with it every verb whose only other home is a hotkey. One button
            for all three modes: it opens quick-open, whose own placeholder
            teaches the `>` and `#` that cross to commands and to search.
            A magnifier rather than the command's registry glyph (FileText),
            which up here would read as "new note" — the backlinks button's
            reasoning: the header picks the icon that distinguishes, and says
            so. */}
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => exec("palette.notes")}
          title={tooltip("palette.notes")}
        >
          <Search className="size-4" />
        </Button>
        <div className="flex-1" />
        {hasTerminal() && (
          <Button
            ref={termBtnRef}
            variant={termOpen ? "secondary" : "ghost"}
            size="icon"
            className="size-7"
            onClick={() => exec("terminal.toggle")}
            title={tooltip("terminal.toggle")}
          >
            <TerminalSquare className="size-4" />
          </Button>
        )}
        <Button
          variant={rightPanel === "outline" ? "secondary" : "ghost"}
          size="icon"
          className="size-7"
          onClick={() => exec("outline.toggle")}
          title={tooltip("outline.toggle")}
        >
          <TableOfContents className="size-4" />
        </Button>
        <Button
          variant={rightPanel === "backlinks" ? "secondary" : "ghost"}
          size="icon"
          className="size-7"
          onClick={() => exec("backlinks.toggle")}
          title={tooltip("backlinks.toggle")}
        >
          {/* The panel's own header icon (BacklinksPanel.tsx), not a generic
              panel glyph: three faces on this side of the header need three
              distinguishable icons. */}
          <Link2 className="size-4" />
        </Button>
        <Button
          variant={rightPanel === "tags" ? "secondary" : "ghost"}
          size="icon"
          className="size-7"
          onClick={() => exec("tags.toggle")}
          title={tooltip("tags.toggle")}
        >
          <Hash className="size-4" />
        </Button>
        {/* The built-in documentation: a hidden read-only workspace, and this
            button (plus the palette entry) is its whole doorway — it never
            gets a strip row. Lit while it is the selected workspace, since no
            row can show that. Absent when Bun reported no docs root
            (docsFolder is boot-static, like the settings snapshot). */}
        {docsFolder() !== null && (
          <Button
            variant={workspaceKind(selected.folder) === "docs" ? "secondary" : "ghost"}
            size="icon"
            className="size-7"
            onClick={() => exec("docs.toggle")}
            title={tooltip("docs.toggle")}
          >
            <CircleHelp className="size-4" />
          </Button>
        )}
      </header>

      <div ref={stackRef} className="flex min-h-0 flex-1 flex-col">
        {/* `relative` only where a drawer needs something to be absolute
            against: the editor row, so a drawer stops above the terminal
            rather than covering it — the drawer hides the note, and hiding a
            running command with it would be a second surprise. */}
        <div className={cn("flex min-h-0 flex-1", singlePane && "relative")}>
          {sidebarOpen &&
            (singlePane ? (
              <Drawer side="left" onClose={closeSidebar}>
                <Sidebar />
              </Drawer>
            ) : (
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
            ))}
          {/* Always the full width under a drawer, and flex-1 beside a pane —
              the same element either way, so switching arrangements never
              remounts the editor pool underneath it. */}
          <main className="min-h-0 min-w-0 flex-1">
            <WorkspaceView />
          </main>
          {rightPanel &&
            (singlePane ? (
              <Drawer side="right" onClose={closeRightPanel}>
                {rightFace}
              </Drawer>
            ) : (
              <>
                {/* The handle sits on the panel's far side (its left), so the
                    delta inverts — the terminal-drawer arrangement, rotated. */}
                <ResizeHandle
                  axis="x"
                  invert
                  current={rightWidth}
                  onResize={resizeRight}
                  title={`Drag to resize ${rightPanel}`}
                />
                <div style={{ width: rightWidth }} className="min-w-0 shrink-0">
                  {rightFace}
                </div>
              </>
            ))}
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
              {termHost && termHost !== LOCAL_HOST && (
                // Loudly, always: with remote shells in play, which machine
                // this prompt belongs to must never need remembering.
                <span className="rounded border border-amber-500/50 px-1.5 font-mono text-[10px] leading-4 text-amber-600 dark:text-amber-400">
                  {termHost}
                </span>
              )}
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
                  spawnHost={spawnHost.current}
                  onReady={onTerminalReady}
                  onClose={() => setTermOpen(false)}
                  onHost={setTermHost}
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

      {overlay && (
        <Overlay key={overlay.seq} initialMode={overlay.mode} initialQuery={overlay.query} onClose={() => setOverlay(null)} />
      )}
      {profileEditing && (
        <ProfileEditor name={profileEditing} onClose={() => setProfileEditing(null)} />
      )}
      {settingsEditing && <SettingsEditor onClose={() => setSettingsEditing(false)} />}
      {pickingConnection && <ConnectionPicker onClose={() => setPickingConnection(false)} />}
      {vaultDialog && (
        <VaultDialog
          mode={vaultDialog.then?.changePassphrase ? "change" : "auto"}
          onNotice={(m) => uiHooks.showNotice?.(m)}
          onClose={() => setVaultDialog(null)}
          onUnlocked={() => {
            // The follow-up: the act the passphrase interrupted. Lock runs
            // straight through (the user already chose it); remove-lock still
            // gets its exposure confirm — the unlock only proved identity.
            const then = vaultDialog.then;
            if (then?.lock) {
              void lockNoteAndRefresh(then.lock.folder, then.lock.path).then((res) => {
                if (res.error) uiHooks.showError?.(res.error);
                else if (res.notice) uiHooks.showNotice?.(res.notice);
              });
            } else if (then?.removeLock) {
              setRemoveLockConfirm(then.removeLock);
            }
          }}
        />
      )}
      {removeLockConfirm && (
        <ConfirmDialog
          title="Remove Lock"
          body={`“${removeLockConfirm.title}” will be decrypted back to plain text on disk: anything that syncs this folder (and any agent scan) can read it again.`}
          confirmLabel="Remove Lock"
          onConfirm={() => {
            const c = removeLockConfirm;
            setRemoveLockConfirm(null);
            void removeLockAndRefresh(c.folder, c.path).then((err) => {
              if (err) uiHooks.showError?.(err);
            });
          }}
          onCancel={() => setRemoveLockConfirm(null)}
        />
      )}
      {runConfirm && (
        <ConfirmDialog
          title={runConfirm.message ?? runConfirmTitle(runConfirm.lang)}
          body={runConfirmBody(runConfirm)}
          detail={runConfirm.code}
          confirmLabel="Run"
          onConfirm={() => {
            const req = runConfirm;
            setRunConfirm(null);
            req.onConfirm();
          }}
          // Cancelling runs nothing and remembers nothing: the next ⌘↩ on this
          // block asks again. A "don't ask again" would recreate exactly the
          // state the marker exists to prevent.
          onCancel={() => setRunConfirm(null)}
        />
      )}
      {hostPick && <HostPicker req={hostPick} onClose={() => setHostPick(null)} />}
    </div>
  );
}

// The run confirmation's default question, when the fence gave none. Names the
// language because that is the block's whole identity at a glance.
function runConfirmTitle(lang: string | null): string {
  return lang ? `Run this ${lang} block?` : "Run this block?";
}

// Where it will run. The last sentence is the one that matters after a
// mis-aimed ⌘↩: this dialog is the run's first step, not a report on one.
function runConfirmBody(req: RunConfirmRequest): string {
  const where = req.destination === "terminal" ? "this note's terminal" : "this note's inline shell";
  const on = req.host && req.host !== LOCAL_HOST ? ` on ${req.host}` : "";
  return `It will run in ${where}${on}. Nothing has run yet.`;
}
