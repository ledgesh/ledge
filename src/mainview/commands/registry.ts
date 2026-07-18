// Every user-facing command, defined once. Surfaces render from here: the
// window dispatcher fires by keys/domains, menus render title/icon/chip/
// destructive, the palette lists whatever `palette`/`when` allow, tooltips
// come from format.ts over the same key table (keys.ts).
//
// Effectful edges are injected: component-owned behavior goes through
// ctx.ui (see types.ts UiHooks), editor/RPC calls through RegistryDeps, so
// this module stays importable by pure unit tests.
import {
  ArrowLeft,
  ArrowRight,
  Columns2,
  Command as CommandIcon,
  Copy,
  ExternalLink,
  FilePlus,
  FileText,
  FolderOpen,
  KeyRound,
  Layers,
  Link2,
  PanelLeft,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Replace,
  RotateCcw,
  Rows2,
  Save,
  Search,
  Settings as SettingsIcon,
  Shapes,
  SquareCheck,
  SquareX,
  TableOfContents,
  TerminalSquare,
  TextSearch,
  Trash2,
  X,
} from "lucide-react";
import { findLeaf, focusedDocId, focusedTab, leafIds } from "@/workspace/tree";
import { notesOf, trashOf } from "@/workspace/store";
import { parseFrontmatter } from "../../shared/frontmatter";
import { keysOf, listKeysOf, tabSelectKey, titleOf, workspaceSelectKey, type CommandId } from "./keys";
import { chipOf } from "./format";
import type { Command, CommandCtx, RegistryDeps } from "./types";

// A command whose identity (title/keys) comes from the key table; the rest is
// behavior. Keeps the table and the registry from drifting apart.
function cmd(id: CommandId, rest: Omit<Command, "id" | "title" | "keys" | "listKeys">): Command {
  return { id, title: titleOf(id), keys: keysOf(id), listKeys: listKeysOf(id), ...rest };
}

// The pane a pane-scoped command acts on: an explicit menu target, else the
// focused pane.
function targetPaneId(ctx: CommandCtx): string {
  const t = ctx.target;
  if (t?.kind === "pane" || t?.kind === "tab") return t.paneId;
  return ctx.selected.focusedPaneId;
}

function activeLeaf(ctx: CommandCtx) {
  return findLeaf(ctx.selected.root, targetPaneId(ctx));
}

// The note a note-scoped command acts on: an explicit row/menu target, else
// the focused pane's active tab's note. Null for unsaved scratch tabs — there
// is no file yet, so there is nothing to delete or copy — and for any target
// that isn't a live note, so a trash row can never be handed to a note verb.
function targetNote(ctx: CommandCtx) {
  const t = ctx.target;
  if (t && t.kind !== "note") return null;
  const path = t?.kind === "note" ? t.path : focusedTab(ctx.selected)?.path;
  if (!path) return null;
  // The selected workspace's list: rows and tabs both belong to it, so this is
  // where any live note target must be.
  return notesOf(ctx.state, ctx.selected.folder).find((n) => n.path === path) ?? null;
}

// The trashed note a trash-row command acts on. Trash rows always carry a
// target: there is no "current" trashed note.
function targetTrashed(ctx: CommandCtx) {
  const t = ctx.target;
  if (t?.kind !== "trash") return null;
  return trashOf(ctx.state, ctx.selected.folder).find((i) => i.path === t.path) ?? null;
}

// The workspace a workspace-scoped command acts on: an explicit row/menu
// target, else the selected one (how the palette forms work).
function targetWorkspaceId(ctx: CommandCtx): string {
  return ctx.target?.kind === "workspace" ? ctx.target.id : ctx.selected.id;
}

export function buildCommands(deps: RegistryDeps): Command[] {
  const list: Command[] = [
    // --- create / navigate --------------------------------------------------
    cmd("note.new", {
      icon: FilePlus,
      run: (ctx) =>
        ctx.dispatch({
          type: "newTab",
          paneId: ctx.target?.kind === "pane" ? ctx.target.paneId : undefined,
        }),
    }),
    cmd("palette.notes", {
      icon: FileText,
      run: (ctx) => ctx.ui.openOverlay?.("notes"),
    }),
    cmd("palette.commands", {
      icon: CommandIcon,
      palette: false, // opening the palette from the palette is a no-op
      run: (ctx) => ctx.ui.openOverlay?.("commands"),
    }),
    cmd("palette.search", {
      icon: TextSearch,
      run: (ctx) => ctx.ui.openOverlay?.("search"),
    }),

    // --- tabs ----------------------------------------------------------------
    cmd("tab.close", {
      icon: X,
      when: (ctx) => ctx.target?.kind === "tab" || !!activeLeaf(ctx)?.activeTabId,
      run: (ctx) => {
        if (ctx.target?.kind === "tab") {
          ctx.dispatch({ type: "closeTab", paneId: ctx.target.paneId, tabId: ctx.target.tabId });
          return;
        }
        const leaf = activeLeaf(ctx);
        if (leaf?.activeTabId)
          ctx.dispatch({ type: "closeTab", paneId: leaf.id, tabId: leaf.activeTabId });
      },
    }),
    cmd("tab.closeOthers", {
      palette: false, // acts on a right-clicked tab
      when: (ctx) => ctx.target?.kind === "tab" && (activeLeaf(ctx)?.tabs.length ?? 0) > 1,
      run: (ctx) => {
        if (ctx.target?.kind !== "tab") return;
        const { paneId, tabId } = ctx.target;
        const leaf = findLeaf(ctx.selected.root, paneId);
        if (!leaf) return;
        // Keep the target tab in view, then fold the rest.
        ctx.dispatch({ type: "selectTab", paneId, tabId });
        for (const t of leaf.tabs) {
          if (t.id !== tabId) ctx.dispatch({ type: "closeTab", paneId, tabId: t.id });
        }
      },
    }),
    cmd("tab.next", {
      icon: ArrowRight,
      domains: ["page", "editor"], // the shell owns Ctrl in the terminal
      when: (ctx) => (activeLeaf(ctx)?.tabs.length ?? 0) > 1,
      run: (ctx) => cycleTab(ctx, 1),
    }),
    cmd("tab.prev", {
      icon: ArrowLeft,
      domains: ["page", "editor"],
      when: (ctx) => (activeLeaf(ctx)?.tabs.length ?? 0) > 1,
      run: (ctx) => cycleTab(ctx, -1),
    }),

    // --- panes ---------------------------------------------------------------
    cmd("pane.splitRight", {
      icon: Columns2,
      run: (ctx) => ctx.dispatch({ type: "splitPane", dir: "row", paneId: paneTarget(ctx) }),
    }),
    cmd("pane.splitDown", {
      icon: Rows2,
      run: (ctx) => ctx.dispatch({ type: "splitPane", dir: "col", paneId: paneTarget(ctx) }),
    }),
    cmd("pane.close", {
      icon: SquareX,
      when: (ctx) => leafIds(ctx.selected.root).length > 1,
      run: (ctx) => ctx.dispatch({ type: "closePane", paneId: paneTarget(ctx) }),
    }),

    // --- workspaces ----------------------------------------------------------
    cmd("workspace.new", {
      icon: Plus,
      // Async behind a void (deleteNoteWithUndo's pattern): Bun creates the
      // folder, then the reducer adds the workspace over it.
      run: (ctx) => {
        void deps.createWorkspace(ctx.state, ctx.dispatch).then((err) => {
          if (err) ctx.ui.showError?.(err);
        });
      },
    }),
    // Register an existing directory as a workspace, via the NATIVE folder
    // picker (the view never names a path). Palette-only: not frequent enough
    // to spend a chord on.
    cmd("workspace.attach", {
      icon: FolderOpen,
      run: (ctx) => {
        void deps.attachWorkspace(ctx.dispatch).then((err) => {
          if (err) ctx.ui.showError?.(err);
        });
      },
    }),
    // Enter on a focused workspace row. Not in the palette: the generated
    // "Switch to Workspace: …" entries are the palette's form of this.
    cmd("workspace.open", {
      icon: Layers,
      targetKind: "workspace",
      palette: false,
      when: (ctx) => ctx.target?.kind === "workspace",
      run: (ctx) => {
        if (ctx.target?.kind === "workspace")
          ctx.dispatch({ type: "selectWorkspace", id: ctx.target.id });
      },
    }),
    cmd("workspace.rename", {
      icon: Pencil,
      targetKind: "workspace",
      run: (ctx) => ctx.ui.beginRenameWorkspace?.(targetWorkspaceId(ctx)),
    }),
    cmd("workspace.icon", {
      icon: Shapes,
      targetKind: "workspace",
      run: (ctx) => ctx.ui.pickWorkspaceIcon?.(targetWorkspaceId(ctx)),
    }),
    cmd("workspace.close", {
      icon: Trash2,
      targetKind: "workspace",
      destructive: true,
      when: (ctx) => ctx.state.workspaces.length > 1,
      // Closes the view AND detaches the folder from the registry — but never
      // touches the files: the folder stays on disk, re-attachable with
      // everything in it (hence still no confirmation; interactions.md §4).
      run: (ctx) => deps.closeWorkspace(targetWorkspaceId(ctx), ctx.state, ctx.dispatch),
    }),

    // --- chrome --------------------------------------------------------------
    cmd("sidebar.toggle", {
      icon: PanelLeft,
      run: (ctx) => ctx.ui.toggleSidebar?.(),
    }),
    cmd("backlinks.toggle", {
      // Link2, not a panel glyph: the palette/menu icon matches the panel's
      // own header (BacklinksPanel.tsx) and the header toggle.
      icon: Link2,
      run: (ctx) => ctx.ui.toggleBacklinks?.(),
    }),
    cmd("outline.toggle", {
      icon: TableOfContents,
      run: (ctx) => ctx.ui.toggleOutline?.(),
    }),
    cmd("terminal.toggle", {
      icon: TerminalSquare,
      // The editor's CodeMirror keymap and the terminal's xterm handler own
      // Ctrl-` in their domains and route here through exec; the window layer
      // only fires it from page focus.
      domains: ["page"],
      run: (ctx) => ctx.ui.toggleTerminal?.(),
    }),
    cmd("terminal.close", {
      icon: X,
      palette: false, // Toggle Terminal covers it
      run: (ctx) => ctx.ui.closeTerminal?.(),
    }),
    // Opens settings.json in the OS editor — the file is the settings UI
    // (docs/architecture.md "Settings"); changes apply at the next launch.
    cmd("settings.open", {
      icon: SettingsIcon,
      run: () => deps.openSettings(),
    }),
    // Put `ledge` on the PATH. The outcome always surfaces — an install whose
    // result you have to go hunting for in a bin dir did not finish its job:
    // success (where it landed, whether PATH sees it) in the neutral strip,
    // failure (a foreign file squatting the name) in the error strip.
    cmd("cli.install", {
      icon: TerminalSquare,
      run: (ctx) => {
        void deps.installCli().then((r) => {
          if (r.ok) ctx.ui.showNotice?.(r.message);
          else ctx.ui.showError?.(r.message);
        });
      },
    }),

    // --- per-note params (frontmatter) ----------------------------------------
    // Kill the current note's shells; the next run/attach respawns them with
    // the note's current frontmatter params — the restart-applies escape hatch.
    cmd("session.restart", {
      icon: RefreshCw,
      when: (ctx) => focusedDocId(ctx.selected) !== null,
      run: (ctx) => {
        const docId = focusedDocId(ctx.selected);
        if (docId) deps.restartSession(docId);
      },
    }),
    // Edit the profile the current note's frontmatter names, in the in-app
    // dialog (components/ProfileEditor.tsx). Hidden when it names none: with
    // no name there is nothing to edit, and prompting for one here would
    // invent a second way to say what the frontmatter already says.
    cmd("profile.open", {
      icon: KeyRound,
      when: (ctx) => currentProfile(ctx, deps) !== null,
      run: (ctx) => {
        const name = currentProfile(ctx, deps);
        if (name) ctx.ui.openProfileEditor?.(name);
      },
    }),

    // --- notes ---------------------------------------------------------------
    cmd("note.open", {
      icon: FileText,
      targetKind: "note",
      palette: false, // Go to Note… (⌘P) is the palette form
      when: (ctx) => !!targetNote(ctx),
      run: (ctx) => {
        const note = targetNote(ctx);
        if (note) ctx.dispatch({ type: "openNote", note });
      },
    }),
    cmd("note.delete", {
      icon: Trash2,
      targetKind: "note",
      destructive: true,
      palette: false, // the row form; Delete Note (⌘⌫) is the palette form
      when: (ctx) => ctx.target?.kind === "note" && !!targetNote(ctx),
      run: (ctx) => {
        const note = targetNote(ctx);
        if (note) ctx.ui.deleteNoteWithUndo?.(note);
      },
    }),
    cmd("note.deleteCurrent", {
      icon: Trash2,
      destructive: true,
      // Page focus only: in the editor, CodeMirror's Mod-Backspace
      // (delete-to-line-start) wins by the preventDefault contract. On a
      // focused note row it acts on that row — ⌘⌫ meaning "delete the note I
      // am pointing at" is the same promise either way.
      domains: ["page"],
      when: (ctx) => (ctx.target?.kind ?? "note") === "note" && !!targetNote(ctx),
      run: (ctx) => {
        const note = targetNote(ctx);
        if (note) ctx.ui.deleteNoteWithUndo?.(note);
      },
    }),
    // Enter on (or click of, or the menu on) a Backlinks-panel row: open the
    // linking note with its link line revealed. The reveal is registered
    // BEFORE the open — the search overlay's pattern (Overlay.tsx): openNote's
    // render is what attaches the editor the reveal lands in. The meta comes
    // from the selected workspace's list, where a backlink must live — the
    // scan is workspace-scoped; a hit whose note vanished since is a no-op.
    cmd("backlink.open", {
      icon: FileText,
      targetKind: "backlink",
      palette: false, // acts on a specific row
      when: (ctx) => ctx.target?.kind === "backlink",
      run: (ctx) => {
        const t = ctx.target;
        if (t?.kind !== "backlink") return;
        const note = notesOf(ctx.state, ctx.selected.folder).find((n) => n.path === t.path);
        if (!note) return;
        deps.revealBacklink(t.path, t.line, t.raw);
        ctx.dispatch({ type: "openNote", note });
      },
    }),
    // Enter on (or click of) an Outline-panel row: put the caret on that
    // heading in the active note's own editor. No dispatch at all — the note
    // is already the shown one; the jump is the whole verb.
    cmd("outline.jump", {
      icon: TableOfContents,
      targetKind: "heading",
      palette: false, // acts on a specific row
      when: (ctx) => ctx.target?.kind === "heading",
      run: (ctx) => {
        const t = ctx.target;
        if (t?.kind === "heading") deps.jumpToHeading(t.docId, t.line, t.text);
      },
    }),
    // The heading's wikilink, ready to paste: [[Title#Heading]] — or plain
    // [[Title]] when the row IS the H1, whose text is the tab title
    // (filenames follow the H1), because [[Title#Title]] would be a strange
    // spelling of the note itself.
    cmd("outline.copyLink", {
      icon: Copy,
      targetKind: "heading",
      palette: false, // acts on a specific row
      when: (ctx) => ctx.target?.kind === "heading",
      run: (ctx) => {
        const t = ctx.target;
        if (t?.kind !== "heading") return;
        const title = focusedTab(ctx.selected)?.title;
        if (!title) return;
        deps.copyText(t.text === title ? `[[${title}]]` : `[[${title}#${t.text}]]`);
      },
    }),
    cmd("note.copyPath", {
      icon: Copy,
      targetKind: "note",
      palette: false, // acts on a specific row, not "the current note"
      when: (ctx) => ctx.target?.kind === "note",
      run: (ctx) => {
        if (ctx.target?.kind === "note") deps.copyText(ctx.target.path);
      },
    }),

    // --- trash ---------------------------------------------------------------
    cmd("note.restore", {
      icon: RotateCcw,
      targetKind: "trash",
      palette: false, // acts on a specific trashed note
      when: (ctx) => !!targetTrashed(ctx),
      run: (ctx) => {
        const item = targetTrashed(ctx);
        if (item) ctx.ui.restoreTrashed?.(item.path);
      },
    }),
    cmd("trash.delete", {
      icon: Trash2,
      targetKind: "trash",
      destructive: true,
      palette: false, // acts on a specific trashed note
      when: (ctx) => !!targetTrashed(ctx),
      run: (ctx) => {
        const item = targetTrashed(ctx);
        if (item) ctx.ui.confirmDeleteTrashed?.(item);
      },
    }),
    cmd("trash.empty", {
      icon: Trash2,
      destructive: true,
      when: (ctx) => trashOf(ctx.state, ctx.selected.folder).length > 0,
      run: (ctx) => ctx.ui.confirmEmptyTrash?.(),
    }),

    // --- editor-internal (keys owned by CodeMirror; palette refocuses) -------
    cmd("editor.find", editorCommand(deps, Search, (ed, docId) => ed.find(docId))),
    cmd("editor.replace", editorCommand(deps, Replace, (ed, docId) => ed.replace(docId))),
    cmd("editor.save", editorCommand(deps, Save, (ed, docId) => ed.save(docId))),
    cmd("block.runInline", editorCommand(deps, Play, (ed, docId) => ed.runInline(docId))),
    cmd(
      "block.runInTerminal",
      editorCommand(deps, TerminalSquare, (ed, docId) => ed.runInTerminal(docId)),
    ),
    // Follows the link under the caret; ⌘-click on the link is the
    // accelerator (editor/livePreview.ts). A caret not on a link makes this a
    // no-op rather than hiding the entry — `when` cannot see the caret
    // cheaply, and find/save keep the same always-visible contract.
    cmd("link.open", editorCommand(deps, ExternalLink, (ed, docId) => ed.openLink(docId))),
    // Toggles the checkbox on the caret's line; clicking the rendered box is
    // the accelerator. Same always-visible, no-op-off-target contract as
    // link.open above.
    cmd("task.toggle", editorCommand(deps, SquareCheck, (ed, docId) => ed.toggleTask(docId))),
  ];

  // Indexed quick-jumps, one command per slot so the dispatcher and the
  // palette stay plain data. ⌘N switches workspace, ⌃N selects a tab in the
  // focused pane — exactly what the held-modifier badges advertise.
  for (let n = 1; n <= 9; n += 1) {
    list.push({
      id: `workspace.select.${n}`,
      title: (ctx) => `Switch to Workspace: ${ctx.state.workspaces[n - 1]?.name ?? n}`,
      keys: [workspaceSelectKey(n)],
      when: (ctx) => !!ctx.state.workspaces[n - 1],
      run: (ctx) => {
        const ws = ctx.state.workspaces[n - 1];
        if (ws) ctx.dispatch({ type: "selectWorkspace", id: ws.id });
      },
    });
    list.push({
      id: `tab.select.${n}`,
      title: `Go to Tab ${n}`,
      keys: [tabSelectKey(n)],
      domains: ["page", "editor"],
      palette: false,
      when: (ctx) => !!focusedLeafTabs(ctx)[n - 1],
      run: (ctx) => {
        const leaf = findLeaf(ctx.selected.root, ctx.selected.focusedPaneId);
        const tab = leaf?.tabs[n - 1];
        if (leaf && tab) ctx.dispatch({ type: "selectTab", paneId: leaf.id, tabId: tab.id });
      },
    });
  }

  return list;
}

// The profile the current note's frontmatter names, or null (no focused note,
// no editor for it yet, or no profile line). Parsed from the doc's head on
// demand: `when` runs per menu/palette render and must stay cheap.
function currentProfile(ctx: CommandCtx, deps: RegistryDeps): string | null {
  const docId = focusedDocId(ctx.selected);
  if (!docId) return null;
  const head = deps.noteHead(docId);
  return head === null ? null : parseFrontmatter(head).params.profile;
}

function paneTarget(ctx: CommandCtx): string | undefined {
  const t = ctx.target;
  return t?.kind === "pane" || t?.kind === "tab" ? t.paneId : undefined;
}

function focusedLeafTabs(ctx: CommandCtx) {
  return findLeaf(ctx.selected.root, ctx.selected.focusedPaneId)?.tabs ?? [];
}

function cycleTab(ctx: CommandCtx, dir: 1 | -1): void {
  const leaf = activeLeaf(ctx);
  if (!leaf || leaf.tabs.length < 2) return;
  const i = leaf.tabs.findIndex((t) => t.id === leaf.activeTabId);
  const next = leaf.tabs[(i + dir + leaf.tabs.length) % leaf.tabs.length];
  if (next) ctx.dispatch({ type: "selectTab", paneId: leaf.id, tabId: next.id });
}

// An editor-internal command: its keys are bound inside CodeMirror (domains:
// [] keeps the window dispatcher out entirely); invoking it from the palette
// refocuses the note's editor first, which deps.editor handles.
function editorCommand(
  deps: RegistryDeps,
  icon: Command["icon"],
  invoke: (ed: RegistryDeps["editor"], docId: string) => void,
): Omit<Command, "id" | "title" | "keys"> {
  return {
    icon,
    domains: [],
    when: (ctx) => focusedDocId(ctx.selected) !== null,
    run: (ctx) => {
      const docId = focusedDocId(ctx.selected);
      if (docId) invoke(deps.editor, docId);
    },
  };
}

// What the palette shows for the current context: visible commands with their
// resolved titles and formatted key chips, in registry order.
export interface PaletteItem {
  id: string;
  title: string;
  chip: string | null;
  icon?: Command["icon"];
  destructive?: boolean;
}

export function paletteItems(commands: readonly Command[], ctx: CommandCtx): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const c of commands) {
    if (c.palette === false) continue;
    if (c.when && !c.when(ctx)) continue;
    items.push({
      id: c.id,
      title: typeof c.title === "function" ? c.title(ctx) : c.title,
      chip: chipOf(c.keys, c.listKeys),
      icon: c.icon,
      destructive: c.destructive,
    });
  }
  return items;
}
