import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CircleHelp, Hash, Link2, PanelLeft, Search, TableOfContents, TerminalSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSinglePane } from "@/lib/viewport";
import { hasTerminal } from "@/lib/shell";
import { docsWindow, onDocsShow } from "@/lib/windows";
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
import { configureStoreUi, flushAll, folderOf, paramsOf } from "@/notes/store";
import { parseWikiTarget, resolveWikiTitle } from "@/editor/wikilinks";
import { refreshWikilinks } from "@/editor/livePreview";
import { refreshFolder } from "@/workspace/actions";
import { subscribeExpansion } from "@/notes/expansion";
import { docsFolder, workspaceKind } from "@/workspace/channel";
import { allDocIds, docsLanding, notesOf, useWorkspace, WorkspaceProvider, type AppState } from "@/workspace/store";
import { flushLayout, scheduleLayoutSave } from "@/workspace/persist";
import { findTabBy, focusedDocId, tabPaths } from "@/workspace/tree";
import { allEditorViews, configureLockedUi, releaseEditor, reloadOpenNotes, requestHeadingReveal } from "@/workspace/editorPool";
import { VaultDialog } from "@/components/VaultDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { lockNoteAndRefresh, removeLockAndRefresh } from "@/vault/channel";
import type { VaultFollowUp } from "@/commands/types";
import { listTags, onExternalOpen, onNotesChanged, onNotesRelink, takeOpenRequest, type ExternalOpenInfo } from "@/notes/channel";
import type { TagInfo } from "../shared/tags";
import { CommandProvider, useCommands } from "@/commands/CommandProvider";
import { ProfileEditor } from "@/components/ProfileEditor";
import { SettingsEditor } from "@/components/SettingsEditor";
import { ConnectionPicker } from "@/components/ConnectionPicker";
import { configureUi, uiHooks } from "@/commands/glue";
import { tooltip } from "@/commands/format";
import { Overlay, type OverlayMode } from "@/commands/Overlay";

// `initial` is built in boot.tsx from the notes already on disk, so the very
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

// Sidebar width bounds, in pixels. The terminal's maximum is measured against
// the live content height instead, so the editor cannot be squeezed away.
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 460;
const TERM_MIN = 140;
const EDITOR_MIN = 160; // space the editor row keeps when the terminal grows

// A side panel that covers the editor instead of taking width from it: the
// arrangement below PANES_MIN_WIDTH (lib/viewport.ts, ios.md §9). Giving the
// sidebar its usual 224 points on a phone leaves the editor 165, the
// arrangement phase 2 shipped and called bad. This panel is 280 wide instead,
// leaving 110 points of editor under the scrim. There is no resize handle,
// since a handle is a drag target for a pointer and a touch client has none.
// The 85% is for the narrow end: a 320-point phone would otherwise get a
// drawer with almost no editor beside it.
function Drawer({
  side,
  onClose,
  children,
}: {
  side: "left" | "right";
  onClose: () => void;
  children: ReactNode;
}) {
  // The drawer registers as a modal layer (interactions.md §6): Escape closes
  // it, and the topmost-only rule sorts out a row menu opened inside it.
  // Being a layer also suppresses the window's command chords. A touch client
  // has no chords to lose, and a narrowed window is covered by the drawer
  // anyway.
  useEffect(() => pushLayer("overlay", onClose), [onClose]);
  return (
    <>
      {/* onClick, not onPointerDown: WebKit sends a click after every touch,
          so closing on the down would hand that click to whatever the drawer
          was covering (the bug phase 2 found under the row menus). The target
          check is ConfirmDialog's: a drag that starts inside the drawer and
          releases out here must not dismiss it. */}
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
  // The sidebar starts open where it is a pane and shut where it is a drawer.
  // A phone that booted behind a scrim would show its chrome instead of the
  // note the last session left focused (ios.md §9).
  const [sidebarOpen, setSidebarOpen] = useState(!singlePane);
  // The right-hand panel: one slot with three faces (Backlinks, Outline,
  // Tags). The toggles are radio-with-off, so opening one closes the others.
  // It starts closed, and its width is bounded like the sidebar's. That width
  // belongs to the slot rather than to a face, so swapping faces does not
  // reflow the editor.
  const [rightPanel, setRightPanel] = useState<"backlinks" | "outline" | "tags" | null>(null);
  const [rightWidth, setRightWidth] = useState(260);
  // The tag the Tags face is drilled into, or null for the directory. Shell
  // holds it because clicks elsewhere route into it (ui.showTag): a rendered
  // #tag in the editor and a tag row in the overlay both land here. It
  // survives face swaps and toggles, so reopening the panel returns to the
  // tag rather than to the directory.
  const [tagShown, setTagShown] = useState<string | null>(null);

  // The side panels are panes on a desktop and drawers on a phone, where two
  // drawers never stack: opening one closes the other (ios.md §9). The toggles
  // read these refs rather than the state itself, because configureUi below
  // binds once at mount, and a captured `singlePane` would still hold the boot
  // value after the first rotation.
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
  // Stable identities: each is a <Drawer>'s onClose, and the effect that
  // pushes the drawer's layer depends on it. A fresh function per render would
  // unregister and re-register the Escape handler on every keystroke in the
  // note behind it.
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const closeRightPanel = useCallback(() => setRightPanel(null), []);

  // Opens the Tags face drilled into one tag. Shared by the ui hook (panel and
  // overlay rows, via tag.open) and by the editor bridge (clicked #tags).
  const showTag = useCallback(
    (tag: string) => {
      setTagShown(tag);
      openRightPanel("tags");
    },
    [openRightPanel],
  );
  // `seq` increments on every open and keys the <Overlay>, remounting it even
  // when one is already up. <Overlay> reads initialQuery and initialMode into
  // state at mount, so a command that re-opens the palette from inside it
  // (note.fromTemplate, palette.notes) would otherwise leave the old input on
  // screen. A ref, because a counter derived from `overlay` would repeat the
  // seq: the palette row's Enter sets that state to null before the re-open.
  const overlaySeq = useRef(0);
  // The overlay's mode plus the seed for its input (note.fromTemplate opens
  // the palette pre-filtered; every other opener seeds "").
  const [overlay, setOverlay] = useState<{ mode: OverlayMode; query: string; folder: string; seq: number } | null>(null);
  // The profile the editor dialog is open on, or null. Shell owns it like the
  // rest of the chrome: the command reaches it through the ui hook below.
  const [profileEditing, setProfileEditing] = useState<string | null>(null);
  // The ⌘, settings editor dialog (settings.jsonc in an in-app CodeMirror).
  const [settingsEditing, setSettingsEditing] = useState(false);
  const [pickingConnection, setPickingConnection] = useState(false);
  // The vault passphrase dialog, carrying the act that was waiting on it
  // (lock this note, remove that lock). App runs the follow-up once the
  // passphrase is accepted, rather than stopping at the prompt
  // (locking.md §7). null means closed.
  const [vaultDialog, setVaultDialog] = useState<{ then?: VaultFollowUp } | null>(null);
  // The Remove Lock confirmation's subject, or null. Removing a lock is
  // confirmed because the note's body becomes readable to sync and agent
  // scans, not because anything is destroyed.
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
  // Crossing into the drawer arrangement closes whatever was open, so a window
  // dragged narrow does not land with its editor behind a scrim. This runs on
  // the way in only. Crossing back out reopens nothing, and the header toggles
  // are how a panel comes back.
  useEffect(() => {
    if (!singlePane) return;
    setSidebarOpen(false);
    setRightPanel(null);
  }, [singlePane]);

  // Picking a note out of the sidebar drawer closes it. Watching the focused
  // doc covers every route into a note: a row in the browser, a tab, a
  // workspace, a wikilink, the palette. Picking the note that is already
  // focused changes no id here, so the drawer stays up.
  const focusedDoc = focusedDocId(selected);
  useEffect(() => {
    if (singlePane) setSidebarOpen(false);
  }, [singlePane, focusedDoc, selected.id]);

  const resizeTerm = useCallback((h: number) => {
    const avail = stackRef.current?.clientHeight ?? window.innerHeight;
    setTermHeight(Math.max(TERM_MIN, Math.min(h, avail - EDITOR_MIN)));
  }, []);
  // The note whose terminal the drawer shows: the focused pane's active tab.
  // Its docId is the sessionId for that note's per-note terminal shell.
  const activeDocId = focusedDocId(selected);
  // A "run in terminal" fired while the drawer is closed (or for a note other
  // than the one shown) queues its command here. It flushes once that note's
  // terminal has mounted, so its output is not dropped.
  const pending = useRef<{ sessionId: string; cmd: string; language: string | null; host: string | null } | null>(
    null,
  );
  // The open host-picker request, if any (multi-host note about to run/spawn).
  const [hostPick, setHostPick] = useState<HostPickRequest | null>(null);
  // The open run confirmation, if any: a block marked `confirm` on its fence
  // (or in a `confirm: true` note) that has not been answered yet. Nothing has
  // executed while this is up; the dialog is the run's first step
  // (interactions.md §4b).
  const [runConfirm, setRunConfirm] = useState<RunConfirmRequest | null>(null);
  // The machine the drawer's shell is on (attach response), for the badge.
  const [termHost, setTermHost] = useState<string | null>(null);
  // The host picked for the next drawer spawn. A ref, not state: the mount
  // that follows setTermOpen consumes it. The doc-change effect below clears
  // it, so a tab switch spawns on the new note's own frontmatter default
  // rather than on a stale pick.
  const spawnHost = useRef<string | null>(null);
  useEffect(() => {
    spawnHost.current = null;
    setTermHost(null); // the badge names one note's shell, not the next one's
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
        // Bun wraps this as a bracketed paste and gates it on the shell being
        // ready, so it is safe to fire the instant a lazily-spawned shell
        // starts.
        if (termOpen && sessionId === activeDocId) {
          sendTerminalPaste(sessionId, code, language, host);
          return;
        }
        // The block can live in an unfocused pane: its buttons sit in the
        // overlay layer parented to <body>, so clicking one never reaches the
        // pane's focus-on-mousedown handler. The drawer shows the focused
        // pane's note, so selecting the block's own tab first keeps the drawer
        // from opening on some other note and pasting into a hidden shell.
        if (sessionId !== activeDocId) {
          const hit = findTabBy(selected.root, (t) => t.docId === sessionId);
          if (hit) dispatch({ type: "selectTab", paneId: hit.paneId, tabId: hit.tabId });
        }
        pending.current = { sessionId, cmd: code, language, host };
        spawnHost.current = host;
        setTermOpen(true);
      };
      // The confirmation, when the block asked for one, sits between the
      // settled machine and the paste (interactions.md §4b). It comes after
      // the picker, so the question can name the machine. `named` is the host
      // the dialog may claim. Past a live shell it is null, because that shell
      // runs wherever it already is. The dialog then says "this note's
      // terminal" rather than guessing the list's first entry.
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
      // Only a spawn needs the picker. A live drawer shell has one host, and
      // the paste can only go there (the badge names it). Restart Note Shell
      // is what moves the shell to another machine.
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

  // Shell owns the chrome state (terminal drawer, sidebar, overlay) and
  // registers the ui hooks the command registry reaches them through. One
  // implementation serves the header button, the editor keymap, the window
  // hotkey and the palette (interactions.md §1). boot.tsx registers the
  // inline-run handler separately: configureBridge merges, it does not replace.

  // configureUi is registered once, so its terminal toggle cannot read the
  // current note and drawer state from a closure. These refs carry them.
  const termOpenRef = useRef(termOpen);
  termOpenRef.current = termOpen;
  const activeDocRef = useRef(activeDocId);
  activeDocRef.current = activeDocId;
  // The wikilink handlers below resolve against the store's current note
  // lists. The bridge registration is a stable closure, so a ref carries them.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    configureUi({
      toggleTerminal: () => {
        if (termOpenRef.current) {
          setTermOpen(false);
          return;
        }
        // Opening the drawer on a multi-host note whose shell is not alive
        // spawns one, so the machine is chosen first. Single-host and local
        // notes open without asking, spawning on their frontmatter's own
        // answer. A live shell reopens wherever it already is.
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
      openOverlay: (mode, opts) => {
        overlaySeq.current += 1;
        setOverlay({ mode, query: opts?.query ?? "", folder: opts?.folder ?? "", seq: overlaySeq.current });
      },
      openProfileEditor: setProfileEditing,
      openSettingsEditor: () => setSettingsEditing(true),
      openConnectionPicker: () => setPickingConnection(true),
      openVaultDialog: (then) => setVaultDialog({ then }),
      confirmRemoveLock: setRemoveLockConfirm,
    });
    // The locked placeholder's Unlock button runs the same `vault.unlock` the
    // palette runs. The pool reaches it through its own configureX seam,
    // because importing the registry there would be a cycle.
    configureLockedUi({ requestUnlock: () => exec("vault.unlock") });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    configureBridge({
      toggleTerminal: () => exec("terminal.toggle"),
      runInTerminal,
      // Shell renders the host picker, as it does every dialog. The editor
      // asks for one through the bridge (blocks.ts requestHostPick).
      pickHost: setHostPick,
      // The run confirmation is the same: Shell renders it, the editor asks
      // for it.
      confirmRun: setRunConfirm,
      // The ⌘-clicked frontmatter profile name lands on the same dialog as
      // the "Edit Note Profile…" command.
      openProfileEditor: setProfileEditing,
      // The editor's refusal notices (a prompt fence in a locked note) land
      // on the browser's notice strip like every other neutral outcome.
      notice: (message) => uiHooks.showNotice?.(message),
      // Wikilinks resolve against the note's own workspace list, scoped the
      // way the browser and the overlays scope theirs. Both handlers stay
      // view-side: the resolved path is one Bun handed the store, and openNote
      // is a plain dispatch, so no new path shape crosses the RPC.
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
        // Register the reveal before the open, as the Overlay's search does.
        // openNote's render is what attaches the editor the reveal lands in.
        if (parsed.heading) requestHeadingReveal(note.path, parsed.heading);
        dispatch({ type: "openNote", note });
      },
      // The `#` completion's vocabulary: the per-folder snapshot kept fresh
      // below. Synchronous like wikiNotes, because a decoration or completion
      // pass cannot await.
      workspaceTags: (docId) => {
        const folder = folderOf(docId);
        return folder ? (tagVocab.current.get(folder) ?? []) : [];
      },
      // A clicked #tag (rendered, frontmatter, or through the Open Link
      // command) opens the Tags panel drilled into it, like every tag click.
      openTag: (_docId, tag) => showTag(tag),
    });
    // The autosave outcome a user has to be told about: a save that displaced
    // another writer's version of the note into the trash. Same strip and the
    // same neutral tone as the bridge's notices above.
    configureStoreUi({ notice: (message) => uiHooks.showNotice?.(message) });
  }, [exec, runInTerminal, dispatch, showTag]);

  // The tag vocabulary the `#` completion reads (bridge workspaceTags above):
  // the selected workspace's directory, refetched when its note lists change.
  // The wikilink redraw below rides the same signal. A ref, not state:
  // nothing renders from it, and the completion reads it on demand.
  const tagVocab = useRef(new Map<string, TagInfo[]>());
  useEffect(() => {
    const folder = selected.folder;
    void listTags(folder).then(
      (t) => tagVocab.current.set(folder, t.tags),
      () => {
        // A failed scan keeps the last snapshot. A stale vocabulary is better
        // than an empty popup while a volume is unmounted mid-session.
      },
    );
  }, [state.notes, selected.folder]);

  // A note list changed (created, renamed, deleted, refreshed), so every
  // pooled editor redraws its wikilinks. A dangling link resolves as soon as
  // its note exists, and stops resolving when that note goes.
  useEffect(() => {
    for (const view of allEditorViews()) refreshWikilinks(view);
  }, [state.notes]);

  const onTerminalReady = useCallback(() => {
    if (pending.current) {
      sendTerminalPaste(pending.current.sessionId, pending.current.cmd, pending.current.language, pending.current.host);
      pending.current = null;
    }
  }, []);

  // Close the drawer when the shown note's terminal shell exits (the user
  // typed `exit`). Bun has already torn that shell down, so reopening the
  // drawer spawns a fresh one.
  useEffect(
    () => onTerminalExit((sid) => { if (sid === activeDocId) setTermOpen(false); }),
    [activeDocId],
  );

  // Tear down a pooled editor and its per-note shells once the tab (or pane,
  // or workspace) is gone. One reconciliation point covers every close path:
  // diff the live docId set against the previous one and release whatever
  // dropped out.
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

  // Session persistence: a change to the workspace, pane or tab arrangement,
  // or to which workspace is selected, schedules a debounced layout save.
  // Keyed on those two state fields, not the whole state, so a notes-folder
  // refresh does not rewrite an unchanged layout. serializeLayout reads only
  // those two fields, so the closure below cannot be stale. Which folders are
  // open is saved with them, by subscription rather than by dep, since it
  // lives outside the reducer (notes/expansion.ts, architecture.md §6).
  useEffect(() => {
    scheduleLayoutSave(state);
    return subscribeExpansion(() => scheduleLayoutSave(state));
  }, [state.workspaces, state.selectedId]);

  // Notes autosave on a short debounce, so the exposure is quitting (or
  // crashing) inside that window. Flushing when the window loses focus and on
  // pagehide narrows it to editing and quitting in the same instant. The
  // layout save above debounces the same way and flushes on the same events.
  const folders = state.workspaces.map((w) => w.folder);
  const foldersKey = folders.join("\n");
  useEffect(() => {
    const flush = () => {
      flushAll();
      flushLayout();
    };
    // Coming back into the window re-reads the folders, so a note created or
    // deleted outside Ledge shows up. Every workspace's folder, not just the
    // selected one: switching workspaces does not leave the window, so a
    // selected-only refresh would show weeks-stale lists after a switch.
    // refreshFolder catches per call, so one folder failing (its volume
    // unmounted mid-session) costs that folder's refresh and nothing else. The
    // trash rides the same trip, because a note deleted or restored from a
    // shell should not leave a stale count.
    const refresh = () => {
      for (const folder of folders) void refreshFolder(folder, dispatch);
      // Open, unedited notes follow their files too: an agent may have
      // rewritten one while Ledge was in the background.
      void reloadOpenNotes();
    };
    window.addEventListener("blur", flush);
    window.addEventListener("pagehide", flush);
    window.addEventListener("focus", refresh);
    // The watcher's push (rpc notesChanged) is the same refresh, scoped to
    // the one root that changed and arriving with no focus change. An agent
    // working in the note's own terminal drawer never blurs the window.
    const offChanged = onNotesChanged((root) => {
      if (folders.includes(root)) void refreshFolder(root, dispatch);
      void reloadOpenNotes();
    });
    // A wire coming back leaves the same staleness as a window coming
    // forward, and every root needs the answer at once: the pushes that would
    // have named which roots moved were dropped while it was down
    // (notes/channel.ts onNotesRelink), so nothing here knows. Focus is no
    // substitute, since watching the bar say "reconnecting…" never leaves the
    // window and a phone has no such event to wait for (ios.md §5). Concurrent
    // like the focus refresh, so the whole sweep is one round trip (remote.md
    // §12) however many folders and tabs are open.
    const offRelink = onNotesRelink(refresh);
    return () => {
      window.removeEventListener("blur", flush);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("focus", refresh);
      offChanged();
      offRelink();
    };
    // Keyed on the joined folder list, not the array identity: workspaces
    // re-render often and their folder set changes rarely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, foldersKey]);

  // `ledge <title>`: an open request from the CLI. A root no workspace shows
  // is dropped with a warning rather than grown a workspace, since the layout
  // self-heals per workspace (architecture.md §6) and this path must not
  // bypass that. Workspaces come from a ref, so the handler below sees what
  // exists at event time without resubscribing on every state change.
  const wsRef = useRef(state.workspaces);
  wsRef.current = state.workspaces;
  useEffect(() => {
    // Bun resolved the title and guarded the path (bun/openRequest.ts), so the
    // view's whole share is selecting the workspace that shows the note's root
    // and then dispatching the ordinary openNote. The select comes first
    // because openNote's fresh-tab branch lands in the selected workspace; its
    // already-open branch finds a live tab anywhere on its own.
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
    // The one-shot boot pull exists because a push at boot can fire before
    // anyone is listening. The subscription above goes in first, so a push
    // arriving between the two is not lost either.
    void takeOpenRequest().then((open) => {
      if (open) openExternal(open);
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch]);

  // The manual, asked for while its window was already open (remote.md §8a).
  // The shell has raised the window; turning to the page is this end's half.
  // Same shape as the open request above, with a title rather than a path,
  // because a page is named by its H1 and its file is numbered
  // (bun/docsContent.ts). Only the manual's window ever hears it.
  const notesRef = useRef(state.notes);
  notesRef.current = state.notes;
  useEffect(
    () =>
      onDocsShow((page) => {
        // A page the request names is always opened, so Help > Third-Party
        // Licenses shows the licences wherever the manual was left. The bare
        // ask (the help button again) opens a page only when nothing is open
        // at all: raising the window was the ask, and losing the reader's
        // place would be worse. A raised window showing an empty pane looks
        // like a dead button (workspace/actions.ts keeps that rule in-window).
        const ws = wsRef.current[0];
        if (!ws || (!page && tabPaths(ws.root).length > 0)) return;
        const note = docsLanding(notesRef.current[ws.folder] ?? [], page);
        if (note) dispatch({ type: "openNote", note });
      }),
    [dispatch],
  );

  // Suppress the WebView's native context menu app-wide. In this dev WKWebView
  // it carries only debug items (Reload, Inspect Element), which a notes app
  // has no use for. Ledge's own right-click menus (the workspace strip, for
  // one) call preventDefault in their handlers and render their own menu, so
  // this listener does not interfere with them.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  // Hotkeys live in the command registry (commands/keys.ts). CommandProvider
  // installs the one window-level keydown dispatcher, so no key handler sits
  // here.

  // The right-hand slot's current face, computed once because both
  // arrangements render it: a pane beside the editor, and a drawer over it.
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
      {/* 48 points on touch, and the buttons below are 44 (interactions.md
          §1a). This row is the densest group of adjacent alternatives in the
          app: seven buttons, no two of which do the same kind of thing. At
          38.5 points with 25-point targets, a miss on the magnifier opened the
          tree and a miss on Tags swapped the whole workspace for the manual.
          Seven 44s, six 7-point gaps and the padding come to 371 of a phone's
          390, and the touch client has six of them (no terminal drawer,
          lib/shell.ts). */}
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3 touch:h-[48px]">
        <Button
          variant={sidebarOpen ? "secondary" : "ghost"}
          size="icon"
          className="size-7 touch:size-[44px]"
          onClick={() => exec("sidebar.toggle")}
          title={tooltip("sidebar.toggle")}
        >
          <PanelLeft className="size-4" />
        </Button>
        {/* The overlay's control in the chrome (interactions.md §1a). A touch
            client has no ⌘P or ⇧⌘P, so without this button the overlay is
            unreachable there, and so is every verb whose only other home is a
            hotkey. One button for all three modes: it opens quick-open, and
            the overlay's own chips cross to commands and to search
            (commands/Overlay.tsx). A magnifier rather than the registry's
            FileText glyph, which up here would read as "new note": the header
            picks the icon that distinguishes, as the backlinks button does. */}
        <Button
          variant="ghost"
          size="icon"
          className="size-7 touch:size-[44px]"
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
            className="size-7 touch:size-[44px]"
            onClick={() => exec("terminal.toggle")}
            title={tooltip("terminal.toggle")}
          >
            <TerminalSquare className="size-4" />
          </Button>
        )}
        <Button
          variant={rightPanel === "outline" ? "secondary" : "ghost"}
          size="icon"
          className="size-7 touch:size-[44px]"
          onClick={() => exec("outline.toggle")}
          title={tooltip("outline.toggle")}
        >
          <TableOfContents className="size-4" />
        </Button>
        <Button
          variant={rightPanel === "backlinks" ? "secondary" : "ghost"}
          size="icon"
          className="size-7 touch:size-[44px]"
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
          className="size-7 touch:size-[44px]"
          onClick={() => exec("tags.toggle")}
          title={tooltip("tags.toggle")}
        >
          <Hash className="size-4" />
        </Button>
        {/* The built-in documentation's doorway, along with the palette entry.
            On a Mac it opens or raises the manual's own window (remote.md §8a)
            and is never lit: the manual is not a workspace in this window to be
            selected. On a client with one window it is a toggle instead, and
            the hidden read-only workspace takes this window over. It is lit
            while that workspace is selected, since no strip row can show it.
            Absent in the manual's own window, and when Bun reported no docs
            root: docsFolder answers from the boot workspaceList, so it does not
            change within a session (workspace/channel.ts). */}
        {docsFolder() !== null && !docsWindow() && (
          <Button
            variant={workspaceKind(selected.folder) === "docs" ? "secondary" : "ghost"}
            size="icon"
            className="size-7 touch:size-[44px]"
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
            rather than covering it. A drawer already hides the note, and it
            must not hide a running command as well. */}
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
          {/* Full width under a drawer, flex-1 beside a pane, and the same
              element either way. Switching arrangements never remounts the
              editor pool underneath it. */}
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
                    drag delta inverts, as it does for the terminal drawer. */}
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
                // The host badge, shown whenever the shell is not local. With
                // remote shells in play, which machine this prompt belongs to
                // has to be on screen rather than remembered.
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
        <Overlay
          key={overlay.seq}
          initialMode={overlay.mode}
          initialQuery={overlay.query}
          initialFolder={overlay.folder}
          onClose={() => setOverlay(null)}
        />
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
            // The follow-up act the passphrase interrupted. Lock runs straight
            // through, since the user already chose it. Remove-lock still gets
            // its exposure confirm, because the unlock only proved identity.
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
          // Cancelling runs nothing and remembers nothing. The next ⌘↩ on this
          // block asks again: there is no "don't ask again".
          onCancel={() => setRunConfirm(null)}
        />
      )}
      {hostPick && <HostPicker req={hostPick} onClose={() => setHostPick(null)} />}
    </div>
  );
}

// The run confirmation's default question, used when the fence gave none. It
// names the language, which is what identifies the block at a glance.
function runConfirmTitle(lang: string | null): string {
  return lang ? `Run this ${lang} block?` : "Run this block?";
}

// The confirmation body: where the block will run. It ends with "Nothing has
// run yet", which is what a reader needs after a mis-aimed ⌘↩, since the
// dialog comes before the run rather than after it.
function runConfirmBody(req: RunConfirmRequest): string {
  const where = req.destination === "terminal" ? "this note's terminal" : "this note's inline shell";
  const on = req.host && req.host !== LOCAL_HOST ? ` on ${req.host}` : "";
  return `It will run in ${where}${on}. Nothing has run yet.`;
}
