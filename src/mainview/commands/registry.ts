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
  Bold,
  Brackets,
  CircleHelp,
  CircleArrowUp,
  Braces,
  CalendarDays,
  ClipboardPaste,
  ClipboardType,
  Code,
  Columns2,
  Command as CommandIcon,
  Copy,
  ExternalLink,
  FilePlus,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Hash,
  Image,
  IndentDecrease,
  IndentIncrease,
  Italic,
  KeyRound,
  Layers,
  LayoutTemplate,
  Link,
  Lock,
  LockOpen,
  Link2,
  PanelLeft,
  Pencil,
  Pin,
  PlugZap,
  Play,
  Plus,
  RefreshCw,
  Replace,
  RotateCcw,
  RotateCw,
  Rows2,
  Save,
  Scale,
  Scissors,
  ScrollText,
  Search,
  Server as ServerIcon,
  Settings as SettingsIcon,
  Shapes,
  Star,
  SquareCheck,
  SquareX,
  TableOfContents,
  AppWindow,
  TerminalSquare,
  TextSearch,
  TextSelect,
  Trash2,
  X,
} from "lucide-react";
import { findLeaf, focusedDocId, focusedTab, leafIds } from "@/workspace/tree";
import { docIdsForPath, notesOf, trashOf } from "@/workspace/store";
import { SCRATCH_DOC } from "@/workspace/seeds";
import { parseFrontmatter } from "../../shared/frontmatter";
import type { NoteMeta } from "../../shared/rpc-schema";
import { canInstallCli, canPickFolder, hasTerminal, multiWindow, runsBlocks, spawnsSessions } from "../lib/shell";
import { docsWindow } from "../lib/windows";
import { offersCheck, updateState } from "../lib/updates";
import { activeConnection, linkState, reconnectLink } from "../lib/connections";
import { keysOf, listKeysOf, tabSelectKey, titleOf, workspaceSelectKey, type CommandId } from "./keys";
import { chipOf } from "./format";
import type { Command, CommandCtx, RegistryDeps } from "./types";

// A command whose identity (title/keys) comes from the key table; the rest is
// behavior. Keeps the table and the registry from drifting apart.
function cmd(id: CommandId, rest: Omit<Command, "id" | "title" | "keys" | "listKeys">): Command {
  return { id, title: titleOf(id), keys: keysOf(id), listKeys: listKeysOf(id), ...rest };
}

// The title prefix on every generated per-template entry. note.fromTemplate
// seeds the palette with this exact string, so the fuzzy filter shows those
// entries and nothing else. The ":" is what keeps the parent command's own
// "…"-titled row from matching itself back into the list.
const TEMPLATE_PREFIX = "New Note from Template: ";

// How many picker entries are pre-registered. Commands are plain data built
// once, the way workspace.select's nine slots are, sized for a template
// collection rather than for a keyboard row. A template past the last slot
// gets no entry, at which point the collection needs pruning more than the
// palette needs scrolling.
const TEMPLATE_SLOTS = 24;

// One picker row: what its entry says after the prefix, and the concrete note
// it instantiates.
interface TemplateChoice {
  label: string;
  path: string;
}

// The picker's rows, recomputed on every render and dispatch: every note
// whose frontmatter declares `template: true` (NoteMeta.template), read from
// the store's per-folder lists, which the watcher refreshes, so marking a note
// takes no setting and no restart. The selected workspace's templates lead
// unlabeled, then the others in strip order, each row naming its workspace, so
// one title in two workspaces stays two rows. Alphabetical within a workspace,
// since mtime order would reshuffle the picker on every template edit.
function templateChoices(ctx: CommandCtx): TemplateChoice[] {
  const out: TemplateChoice[] = [];
  const ordered = [ctx.selected, ...ctx.state.workspaces.filter((w) => w.id !== ctx.selected.id)];
  for (const ws of ordered) {
    const marked = notesOf(ctx.state, ws.folder)
      .filter((n) => n.template)
      .sort((a, b) => a.title.localeCompare(b.title));
    for (const n of marked) {
      out.push({ label: ws.id === ctx.selected.id ? n.title : `${n.title} (${ws.name})`, path: n.path });
    }
  }
  return out;
}

// What "New Template" creates: a note already carrying the marker, whose
// body is the how-to. The {{token}} vocabulary stays literal in the note
// because template.starter writes these bytes through createNote rather than
// through instantiateTemplate, so the note teaches the syntax and expands it
// when a note is made from it. The title is the app's placeholder word, since
// the H1 is the rename UI.
const STARTER_TEMPLATE = `---
template: true
---
# Untitled Template

This note is a template because its frontmatter says \`template: true\` —
that line is the whole mechanism. Mark any note the same way (or run
"Make This Note a Template" from the palette) and it appears under
New Note from Template… (⌥⌘N) immediately.

Creating a note from a template fills in these tokens:

- {{date}} — today, as YYYY-MM-DD
- {{time}} — the clock, as HH:MM
- {{title}} — the new note's title
- {{yesterday}} / {{tomorrow}} — adjacent days, handy in [[wikilinks]]

Everything else copies as written: frontmatter (cwd, env, tags) carries into
every instance, and a \`prompt\` fence arrives ready to run (⌘↩) — a
template that runs is the point. The H1 above is replaced by each new note's
own title, so leave it, or spell it \`# {{title}}\`; both work.

A template may say \`template: daily\` instead of \`true\`: that one is what
⌘J (and \`ledge today\`) instantiates as each day's note — per workspace,
each names its own (or run "New Daily Template" from the palette). Now make
this skeleton yours.
`;

// What "New Daily Template" creates: the daily role's starter, pre-marked so
// nobody hand-writes the frontmatter. The body is spare where
// STARTER_TEMPLATE is a cheatsheet, because every line here lands verbatim in
// each day's note. The H1 is replaced by the date at instantiation.
const DAILY_STARTER = `---
template: daily
---
# Daily Template

Continued from [[{{yesterday}}]].
`;

// The workspace ⌘J acts in, and that workspace's `template: daily` claimant.
// The workspace is daily.workspace as resolved at boot, else the selected one
// (a dep, because that mirror belongs to a setting rather than to view state).
// The role is per-workspace, so the Edit and New verbs point where ⌘J will
// look. The note lists are newest-first, so find() reproduces the newest-wins
// order Bun applies when several notes claim the role (bun/daily.ts).
function dailyTemplateTarget(ctx: CommandCtx, deps: RegistryDeps) {
  const pinned = deps.dailyRoot();
  const ws = ctx.state.workspaces.find((w) => w.folder === pinned) ?? ctx.selected;
  const claimant = notesOf(ctx.state, ws.folder).find((n) => n.template === "daily") ?? null;
  return { ws, claimant };
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

// The docId tab.keep promotes, or null: the menu's tab, else the focused
// pane's active one, and only if it is still a preview. A docId rather than a
// tab so `when` and `run` share one lookup, since keepTab is keyed by it
// (workspace/store.tsx).
function keepTarget(ctx: CommandCtx): string | null {
  const leaf = activeLeaf(ctx);
  if (!leaf) return null;
  const t = ctx.target;
  const tabId = t?.kind === "tab" ? t.tabId : leaf.activeTabId;
  const tab = leaf.tabs.find((x) => x.id === tabId);
  return tab?.preview ? tab.docId : null;
}

// The note a note-scoped command acts on: an explicit row/menu target, else
// the focused pane's active tab's note. Null for an unsaved scratch tab,
// which has no file yet to delete or copy. Null too for any target that is
// not a live note, so a trash row can never be handed to a note verb.
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

/**
 * The rejection handler a command hands to a promise: show the error.
 *
 * These calls cross to the machine the notes are on, and a rejection means
 * the call never arrived: a wire that is down (remote.md §7), a server that
 * refused, a full disk. The resolved-value paths report their own refusals.
 * Without this half, a menu item answers a click with no note and no message.
 *
 * It is not a gate. Withholding a verb while the wire is down would make the
 * palette shrink and regrow on its own, where interactions.md §8 is about
 * what this client cannot do at all. A run is the exception: it cannot report
 * its own failure, so it is gated instead (editor/blocks.ts linkDown).
 */
function failed(ctx: CommandCtx): (err: unknown) => void {
  return (err) => ctx.ui.showError?.(err instanceof Error ? err.message : String(err));
}

// The workspace a workspace-scoped command acts on: an explicit row/menu
// target, else the selected one (how the palette forms work).
function targetWorkspaceId(ctx: CommandCtx): string {
  return ctx.target?.kind === "workspace" ? ctx.target.id : ctx.selected.id;
}

export function buildCommands(deps: RegistryDeps): Command[] {
  // Whether the selected workspace is the built-in read-only documentation.
  // Every create and mutate verb gates on this: menus disable, the palette
  // hides, the dispatcher ignores. Presentation only. Bun refuses every docs
  // write regardless (bun/workspaces.ts assertWritableRoot).
  const docsSelected = (ctx: CommandCtx) => deps.workspaceKind(ctx.selected.folder) === "docs";
  // Whether the workspace a workspace-scoped verb would act on is the docs
  // one. The palette forms fall back to the selected workspace, which can be
  // it.
  const docsTargeted = (ctx: CommandCtx) => {
    const ws = ctx.state.workspaces.find((w) => w.id === targetWorkspaceId(ctx));
    return ws !== undefined && deps.workspaceKind(ws.folder) === "docs";
  };
  // The strip's workspaces: what the sidebar shows and what ⌘1…9 index. The
  // docs workspace is excluded from both (Sidebar filters the same way).
  const stripWorkspaces = (ctx: CommandCtx) =>
    ctx.state.workspaces.filter((w) => deps.workspaceKind(w.folder) !== "docs");

  const list: Command[] = [
    // --- create / navigate --------------------------------------------------
    cmd("note.new", {
      icon: FilePlus,
      when: (ctx) => !docsSelected(ctx),
      run: (ctx) =>
        ctx.dispatch({
          type: "newTab",
          paneId: ctx.target?.kind === "pane" ? ctx.target.paneId : undefined,
        }),
    }),
    // Open the built-in documentation, which is read-only end to end. The
    // header's help button is the icon surface. Hidden when Bun reported no
    // docs root (a failed boot, a harness without one), and hidden inside the
    // manual's own window. With windows the manual gets one of its own and the
    // selected workspace is left alone (remote.md §8a); with one window
    // (lib/shell.ts multiWindow) it stays a toggle, and the lit button is the
    // way back. interactions.md §1 (Documentation) states both shapes.
    cmd("docs.toggle", {
      // A question mark, not a book: in a notes app a book glyph reads as
      // "another notebook", and ? is the usual help icon.
      icon: CircleHelp,
      when: () => deps.docsFolder() !== null && !docsWindow(),
      run: (ctx) => {
        if (multiWindow()) deps.openDocsWindow("");
        else if (docsSelected(ctx)) deps.closeDocs(ctx.state, ctx.dispatch);
        else void deps.openDocs(ctx.state, ctx.dispatch).catch(failed(ctx));
      },
    }),
    // Open the bundled licenses, the manual's last page. A page rather than a
    // file the Finder reveals: the app already shows Markdown documents, and
    // the notice has to be reachable from inside the app.
    //
    // Offered in the manual's window too, unlike the verb above. There it
    // means "turn to that page", and the page is in this window.
    cmd("docs.licenses", {
      icon: Scale,
      when: () => deps.docsFolder() !== null,
      run: (ctx) => {
        // By title: the corpus renumbers pages as it grows, and the H1 is what
        // survives that (bun/docsContent.ts).
        if (multiWindow() && !docsWindow()) deps.openDocsWindow("Third-Party Licenses");
        else void deps.openDocs(ctx.state, ctx.dispatch, "Third-Party Licenses").catch(failed(ctx));
      },
    }),
    // Create or open today's YYYY-MM-DD note and land in it. The open rides
    // the external-open subscriber (the CLI-open path), so glue's dep
    // resolves to an error message to show, or to null.
    cmd("daily.open", {
      icon: CalendarDays,
      // In the docs workspace, ⌘J still works when a daily workspace is
      // pinned, because Bun acts there rather than here. Unpinned it would
      // fall back to the selected, read-only folder, so it gates instead of
      // erroring. In the manual's window it is gone either way: that window
      // holds one workspace and it is the manual, so a daily note opened here
      // would have no pane to land in (App's external-open subscriber drops
      // it).
      when: (ctx) => !docsWindow() && (!docsSelected(ctx) || deps.dailyRoot() !== null),
      run: (ctx) => {
        void deps.openDailyNote(ctx.selected.folder).then((err) => {
          if (err) ctx.ui.showError?.(err);
        }, failed(ctx));
      },
    }),
    // The palette is the template picker, pre-filtered to the generated
    // per-template entries below, so this needs no dialog of its own. Always
    // visible: with no template anywhere yet it pre-filters to New Template
    // instead, so the empty state offers a way in rather than nothing.
    cmd("note.fromTemplate", {
      icon: FilePlus,
      when: (ctx) => !docsSelected(ctx), // instantiates into the selected folder
      run: (ctx) =>
        ctx.ui.openOverlay?.("commands", {
          query: templateChoices(ctx).length > 0 ? TEMPLATE_PREFIX : titleOf("template.starter"),
        }),
    }),
    // Creates the pre-marked cheatsheet note above and opens it for editing.
    cmd("template.starter", {
      icon: LayoutTemplate,
      when: (ctx) => !docsSelected(ctx), // creates into the selected folder
      run: (ctx) => {
        void deps.createNote(ctx.selected.folder, STARTER_TEMPLATE).then((note) => {
          deps.revealTitle(note.path);
          ctx.dispatch({ type: "noteAppeared", folder: ctx.selected.folder, note });
          ctx.dispatch({ type: "openNote", note });
        }, failed(ctx));
      },
    }),
    // The template marker's two verbs on the current note. Exactly one shows
    // at a time: both `when`s parse the live frontmatter, the same read
    // profile.open does. The edit happens in the note's own editor, so it is
    // undoable and autosaved, and the watcher refresh after that save is what
    // updates the picker's rows.
    cmd("note.templateOn", {
      icon: LayoutTemplate,
      // A locked note gets no template verb: a template's body is copied into
      // every note made from it. Bun guards the mirror case, refusing to lock
      // a note that already carries the marker (bun/notes.ts lockNote).
      when: (ctx) =>
        currentTemplateFlag(ctx, deps) === false && currentNoteMeta(ctx)?.locked !== true && !docsSelected(ctx),
      run: (ctx) => {
        const docId = focusedDocId(ctx.selected);
        if (docId) deps.editor.toggleTemplate(docId);
      },
    }),
    cmd("note.templateOff", {
      icon: LayoutTemplate,
      // Truthy, not === true: a `template: daily` note is a template too.
      // This verb removes its marker, role included.
      when: (ctx) => !!currentTemplateFlag(ctx, deps),
      run: (ctx) => {
        const docId = focusedDocId(ctx.selected);
        if (docId) deps.editor.toggleTemplate(docId);
      },
    }),
    // The daily template's verb, in two faces so the title says which one
    // will happen: Edit or New (keys.ts). Both open through openNoteIn, the
    // external-open subscriber's select-then-open. The daily workspace may
    // not be the selected one, and the verb has to act where ⌘J will look.
    cmd("daily.templateEdit", {
      icon: CalendarDays,
      when: (ctx) => !!dailyTemplateTarget(ctx, deps).claimant,
      run: (ctx) => {
        const { ws, claimant } = dailyTemplateTarget(ctx, deps);
        if (claimant) deps.openNoteIn(ws.folder, claimant);
      },
    }),
    cmd("daily.templateNew", {
      icon: CalendarDays,
      // Also gated when the workspace it would create in is the docs one,
      // which happens with no daily workspace pinned and docs selected.
      // Nothing creates a note there.
      when: (ctx) => {
        const { ws, claimant } = dailyTemplateTarget(ctx, deps);
        return !claimant && deps.workspaceKind(ws.folder) !== "docs";
      },
      run: (ctx) => {
        const { ws } = dailyTemplateTarget(ctx, deps);
        void deps.createNote(ws.folder, DAILY_STARTER).then((note) => {
          deps.revealTitle(note.path);
          deps.openNoteIn(ws.folder, note);
        }, failed(ctx));
      },
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
    // The explicit half of preview-tab promotion (interactions.md §1b), on the
    // menu's tab or the focused pane's active one. `when` asks for a tab that
    // is actually a preview, so on an ordinary strip the entry is disabled
    // rather than a verb that visibly does nothing.
    cmd("tab.keep", {
      icon: Pin,
      when: (ctx) => keepTarget(ctx) !== null,
      run: (ctx) => {
        const docId = keepTarget(ctx);
        if (docId) ctx.dispatch({ type: "keepTab", docId });
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
        // Keep the target tab in view, then close the rest.
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
    // In the docs workspace the new pane opens empty. Splitting still works
    // there, so two pages can sit side by side. A seeded scratch tab would be
    // a read-only "Untitled" that can never be typed in or saved. The empty
    // pane shows the existing "No open notes" state (PaneTree.tsx), which is
    // already docs-aware, and it takes the next page opened.
    cmd("pane.splitRight", {
      icon: Columns2,
      run: (ctx) =>
        ctx.dispatch({ type: "splitPane", dir: "row", paneId: paneTarget(ctx), empty: docsSelected(ctx) }),
    }),
    cmd("pane.splitDown", {
      icon: Rows2,
      run: (ctx) =>
        ctx.dispatch({ type: "splitPane", dir: "col", paneId: paneTarget(ctx), empty: docsSelected(ctx) }),
    }),
    cmd("pane.close", {
      icon: SquareX,
      when: (ctx) => leafIds(ctx.selected.root).length > 1,
      run: (ctx) => ctx.dispatch({ type: "closePane", paneId: paneTarget(ctx) }),
    }),

    // --- workspaces ----------------------------------------------------------
    //
    // Neither verb that adds a workspace is offered in the manual's window.
    // That window has no workspace strip (remote.md §8a), so a workspace
    // created there would be selected and invisible: the manual replaced by a
    // scratch note, with no way back to either.
    cmd("workspace.new", {
      icon: Plus,
      when: () => !docsWindow(),
      // Async behind a void (deleteNoteWithUndo's pattern): Bun creates the
      // folder, then the reducer adds the workspace over it. The promise
      // resolves to an error message to show, or to null (types.ts
      // createWorkspace).
      run: (ctx) => {
        void deps.createWorkspace(ctx.state, ctx.dispatch).then((err) => {
          if (err) ctx.ui.showError?.(err);
        }, failed(ctx));
      },
    }),
    // Register an existing directory as a workspace, through the native
    // folder picker: the view never names a path. No chord, since attaching
    // a folder is not frequent enough to earn one.
    cmd("workspace.attach", {
      icon: FolderOpen,
      // Absent where the picker cannot open, rather than present and
      // answering with NO_DIALOG (bun/server.ts). A headless server has
      // nobody at it to choose a folder, and a phone is that case for good
      // (ios.md §8, lib/shell.ts canPickFolder).
      when: () => canPickFolder() && !docsWindow(),
      run: (ctx) => {
        void deps.attachWorkspace(ctx.dispatch).then((err) => {
          if (err) ctx.ui.showError?.(err);
        }, failed(ctx));
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
    // Rename, icon, and move are all withheld for the docs workspace. It has
    // no strip row to anchor them, and its name, icon, and folder belong to
    // the app rather than the user. A docs target reaches them through the
    // palette forms, which fall back to the selected workspace.
    cmd("workspace.rename", {
      icon: Pencil,
      targetKind: "workspace",
      when: (ctx) => !docsTargeted(ctx),
      run: (ctx) => ctx.ui.beginRenameWorkspace?.(targetWorkspaceId(ctx)),
    }),
    cmd("workspace.icon", {
      icon: Shapes,
      targetKind: "workspace",
      when: (ctx) => !docsTargeted(ctx),
      run: (ctx) => ctx.ui.pickWorkspaceIcon?.(targetWorkspaceId(ctx)),
    }),
    // Relocate the workspace's folder on disk: Bun renames it, so the
    // destination has to be on the same volume and everything inside travels.
    // Open tabs close, which is arrangement loss and takes no confirm
    // (interactions.md §4). A managed workspace goes straight to the native
    // destination picker; an external one stops at the in-app chooser first
    // (Sidebar's MoveWorkspaceDialog). interactions.md §3 (Move Workspace
    // Folder…) has the cloud-backup case and why the return trip to ~/.ledge
    // asks for no path.
    cmd("workspace.move", {
      icon: FolderInput,
      targetKind: "workspace",
      // Both faces end at the same native picker: the in-app chooser an
      // external workspace stops at first only offers "back to the app home"
      // beside it. So workspace.attach's condition gates this verb too.
      when: (ctx) => !docsTargeted(ctx) && canPickFolder(),
      run: (ctx) => {
        const id = targetWorkspaceId(ctx);
        const ws = ctx.state.workspaces.find((w) => w.id === id);
        if (ws && deps.workspaceKind(ws.folder) === "external") {
          ctx.ui.pickMoveDestination?.(id);
          return;
        }
        void deps.moveWorkspace(id, ctx.state, ctx.dispatch).then((err) => {
          if (err) ctx.ui.showError?.(err);
        }, failed(ctx));
      },
    }),
    cmd("workspace.close", {
      icon: Trash2,
      targetKind: "workspace",
      destructive: true,
      // Closing the docs workspace needs only some other workspace to land
      // on. Closing a real one has to leave another real one behind: the docs
      // workspace has no strip row, so it would not show the user where they
      // ended up.
      when: (ctx) =>
        docsTargeted(ctx) ? ctx.state.workspaces.length > 1 : stripWorkspaces(ctx).length > 1,
      // Closes the view and detaches the folder from the registry. No file is
      // touched: the folder stays on disk, re-attachable with everything in
      // it, so this takes no confirmation (interactions.md §4).
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
    cmd("tags.toggle", {
      icon: Hash,
      run: (ctx) => ctx.ui.toggleTags?.(),
    }),
    cmd("terminal.toggle", {
      icon: TerminalSquare,
      // hasTerminal gates the drawer, a different question from whether this
      // client runs blocks (lib/shell.ts): a phone runs blocks inline before
      // it has a drawer to put one in. Nothing refuses the PTY, since the
      // daemon at the other end would spawn it. The drawer is not built on
      // such a client, so the verbs that reach it are withheld.
      when: () => hasTerminal(),
      // The editor's CodeMirror keymap and the terminal's xterm handler both
      // bind Ctrl-` in their own domain: the editor routes back through the
      // bridge to this command, the drawer closes itself. The window layer
      // fires it from page focus only.
      domains: ["page"],
      run: (ctx) => ctx.ui.toggleTerminal?.(),
    }),
    cmd("terminal.close", {
      icon: X,
      when: () => hasTerminal(),
      palette: false, // Toggle Terminal covers it
      run: (ctx) => ctx.ui.closeTerminal?.(),
    }),
    // Opens settings.jsonc in Ledge's own editor dialog. The file is the
    // settings UI and its comments are the documentation (architecture.md
    // §6). Changes apply at the next launch.
    // --- note locking (locking.md §7) -----------------------------------
    // ⌘L relocks the vault right away: the walking-away gesture. The
    // flush-then-drop order lives in the dep (commands/glue.ts), because a
    // dirty locked buffer has to reach disk encrypted while Bun still holds
    // the key (locking.md §3).
    cmd("vault.lock", {
      icon: Lock,
      when: () => deps.vaultState() === "unlocked",
      run: () => deps.lockVaultNow(),
    }),
    // Unlock ahead of need. Opening a locked note prompts in place instead,
    // through the placeholder's own button (locking.md §7). Shown whenever a
    // passphrase would open something: a vault, or, on a machine whose vault
    // file has not arrived, any locked note that synced in.
    cmd("vault.unlock", {
      icon: LockOpen,
      when: (ctx) => deps.vaultState() === "locked" || (deps.vaultState() === "none" && anyLockedNote(ctx)),
      run: (ctx) => ctx.ui.openVaultDialog?.(),
    }),
    // Lock and Remove Lock, one face at a time, from the note's live locked
    // flag in the store's lists (the template marker's pattern). Target-scoped
    // like note.delete: the sidebar row's menu passes its note, the palette
    // passes none and targetNote falls back to the focused tab. Locking with
    // no vault runs first-time setup, and locking with a locked vault unlocks
    // first: the dialog carries the lock as a follow-up, which lands on the
    // same confirm the unlocked path opens (locking.md §7).
    cmd("note.lockOn", {
      icon: Lock,
      targetKind: "note",
      when: (ctx) => {
        const note = targetNote(ctx);
        return note !== null && !note.locked && !note.template && !docsSelected(ctx);
      },
      run: (ctx) => {
        const note = targetNote(ctx);
        if (!note) return;
        if (deps.vaultState() !== "unlocked") {
          ctx.ui.openVaultDialog?.({ lock: { path: note.path, title: note.title, folder: ctx.selected.folder } });
          return;
        }
        ctx.ui.confirmLock?.({ path: note.path, title: note.title, folder: ctx.selected.folder });
      },
    }),
    // Unlocked only (locking.md §3). The rewrap needs the master key in hand,
    // and asking for the old passphrase in the dialog would repeat what
    // unlocking already proved.
    cmd("vault.changePassphrase", {
      icon: KeyRound,
      when: () => deps.vaultState() === "unlocked",
      run: (ctx) => ctx.ui.openVaultDialog?.({ changePassphrase: true }),
    }),
    cmd("note.lockOff", {
      icon: LockOpen,
      targetKind: "note",
      when: (ctx) => targetNote(ctx)?.locked === true,
      run: (ctx) => {
        const meta = targetNote(ctx);
        if (!meta) return;
        const note = { path: meta.path, title: meta.title, folder: ctx.selected.folder };
        if (deps.vaultState() !== "unlocked") ctx.ui.openVaultDialog?.({ removeLock: note });
        else ctx.ui.confirmRemoveLock?.(note);
      },
    }),

    cmd("settings.open", {
      icon: SettingsIcon,
      run: (ctx) => ctx.ui.openSettingsEditor?.(),
    }),
    // Switch which machine the notes are on. Everything workspace-scoped is
    // scoped to a server one level up (remote.md §8), so this is the widest
    // switch in the app and the only one that closes every tab. Absent in the
    // manual's window, which is always on this Mac: the manual is this build's
    // own copy, so there is no other machine for it to be on (remote.md §8a).
    cmd("connection.switch", {
      icon: ServerIcon,
      when: () => !docsWindow(),
      run: (ctx) => ctx.ui.openConnectionPicker?.(),
    }),
    // Ask the wire to dial now rather than at its next beat (remote.md §7).
    // The app is already retrying, so this never has to be pressed: it is for
    // the person who can see their wifi came back before the beat does. Shown
    // only while the link is down, since a Reconnect that is present and inert
    // teaches nothing (interactions.md §8) and the indicator has no such state.
    cmd("connection.reconnect", {
      icon: PlugZap,
      when: () => !docsWindow() && linkState().state !== "live",
      run: (ctx) => {
        reconnectLink();
        // The only feedback a press gets. Nothing waits on the dial: the
        // answer arrives later as a link state, so without this a press
        // against a server that is still unreachable looks like a dead button.
        ctx.ui.showNotice?.(`Trying to reach ${activeConnection().name}…`);
      },
    }),
    // Open a second window. Two machines at once is what it is for: a window
    // is a client of one server, so a second server means a second window
    // (remote.md §8a). The new window opens on this Mac and is switched from
    // inside itself, so this verb takes no argument. A client that can have
    // only one window, such as a phone, does not offer it at all (lib/shell.ts
    // multiWindow).
    cmd("window.new", {
      icon: AppWindow,
      when: () => multiWindow(),
      run: () => deps.newWindow(),
    }),
    // Put `ledge` on the PATH. The outcome always surfaces, so nobody has to
    // go hunting in a bin dir: success (where it landed, whether PATH sees it)
    // in the neutral strip, failure (a foreign file holding the name) in the
    // error strip. The PATH is the notes machine's, and a compiled server has
    // no CLI to install, so canInstallCli hides the verb there (lib/shell.ts).
    cmd("cli.install", {
      icon: TerminalSquare,
      when: () => canInstallCli(),
      run: (ctx) => {
        void deps.installCli().then((r) => {
          if (r.ok) ctx.ui.showNotice?.(r.message);
          else ctx.ui.showError?.(r.message);
        }, failed(ctx));
      },
    }),
    // The answer to "it crashed, what do I send you". No notice strip on
    // success: the Finder window that opens is the confirmation (bun/log.ts
    // revealLog opens the log folder).
    cmd("log.reveal", {
      icon: ScrollText,
      run: () => deps.revealLog(),
    }),
    // The app's own update (releasing.md §7). Absent where this app does not
    // update itself, a phone or a dev build, and while an update waits to be
    // installed, when the other face below is the live one (lib/updates.ts
    // offersCheck). The outcome surfaces from the update mirror, not from here.
    cmd("update.check", {
      icon: CircleArrowUp,
      when: () => offersCheck(updateState()),
      run: () => deps.checkForUpdates(),
    }),
    // Quits and relaunches as the new version. No confirmation, the same as
    // ⌘Q: shells end and every note is already on disk (interactions.md §4).
    cmd("update.install", {
      icon: RotateCw,
      when: () => updateState().phase === "ready",
      run: (ctx) => {
        void deps.installUpdate().then((n) => {
          if (n) ctx.ui.showError?.(n.message);
        }, failed(ctx));
      },
    }),

    // --- per-note params (frontmatter) ----------------------------------------
    // Kill the current note's shells. The next run or attach respawns them
    // with the note's frontmatter params as they read now, which is how a
    // frontmatter edit takes effect (architecture.md §6a, restart-applies).
    cmd("session.restart", {
      icon: RefreshCw,
      // spawnsSessions is true when either surface exists, and both spawn the
      // shells this kills. A client with neither has no shell to restart, so
      // the verb is absent there (lib/shell.ts).
      when: (ctx) => spawnsSessions() && focusedDocId(ctx.selected) !== null,
      run: (ctx) => {
        const docId = focusedDocId(ctx.selected);
        if (docId) deps.restartSession(docId);
      },
    }),
    // Edit the profile the current note's frontmatter names, in the in-app
    // dialog (components/ProfileEditor.tsx). Hidden when the frontmatter names
    // none: there is nothing to edit, and prompting for a name here would be a
    // second way to say what the frontmatter already says.
    cmd("profile.open", {
      icon: KeyRound,
      // A profile is the environment a block runs in, so a client that does not
      // run blocks has nothing to edit one for (ios.md §8).
      when: (ctx) => runsBlocks() && currentProfile(ctx, deps) !== null,
      run: (ctx) => {
        const name = currentProfile(ctx, deps);
        if (name) ctx.ui.openProfileEditor?.(name);
      },
    }),
    // Put the caret in the note's frontmatter, creating the block when there
    // is none (editor/frontmatterEdit.ts does the editing). One command with a
    // live title, not the templateOn/Off pair of faces: it holds a chord and
    // the dispatcher ignores `when`, so two commands on ⌥⌘, would fire the
    // first. It is built literally rather than through cmd() so it can carry
    // that live title, and keys.ts still owns its identity.
    {
      id: "frontmatter.edit",
      title: (ctx) => {
        const docId = focusedDocId(ctx.selected);
        const head = docId === null ? null : deps.noteHead(docId);
        return head !== null && parseFrontmatter(head).end > 0 ? "Edit Frontmatter" : "Add Frontmatter";
      },
      keys: keysOf("frontmatter.edit"),
      icon: Braces,
      when: (ctx) => {
        const docId = focusedDocId(ctx.selected);
        // Not in the docs workspace. The Add face would insert fences the
        // read-only editor discards, so the chord would visibly do nothing.
        // The editor's transaction filter is what discards them (editor/
        // setup.ts).
        return docId !== null && deps.noteHead(docId) !== null && !docsSelected(ctx);
      },
      run: (ctx) => {
        const docId = focusedDocId(ctx.selected);
        if (docId) deps.editor.editFrontmatter(docId);
      },
    },

    // --- notes ---------------------------------------------------------------
    cmd("note.open", {
      icon: FileText,
      targetKind: "note",
      palette: false, // Go to Note… (⌘P) is the palette form
      when: (ctx) => !!targetNote(ctx),
      run: (ctx) => {
        const note = targetNote(ctx);
        // A navigation, so the tab is a preview: a walk down the browser
        // reuses one slot instead of filling the strip (interactions.md §1b).
        if (note) ctx.dispatch({ type: "openNote", note, preview: true });
      },
    }),
    cmd("note.delete", {
      icon: Trash2,
      targetKind: "note",
      destructive: true,
      palette: false, // the row form; Delete Note (⌘⌫) is the palette form
      when: (ctx) => ctx.target?.kind === "note" && !!targetNote(ctx) && !docsSelected(ctx),
      run: (ctx) => {
        const note = targetNote(ctx);
        if (note) ctx.ui.deleteNoteWithUndo?.(note);
      },
    }),
    cmd("note.deleteCurrent", {
      icon: Trash2,
      destructive: true,
      // Page focus only. In the editor, CodeMirror's Mod-Backspace
      // (delete-to-line-start) wins by the preventDefault contract
      // (interactions.md §7). On a focused note row, ⌘⌫ deletes that row's
      // note, which is what it means in either place.
      domains: ["page"],
      when: (ctx) => (ctx.target?.kind ?? "note") === "note" && !!targetNote(ctx) && !docsSelected(ctx),
      run: (ctx) => {
        const note = targetNote(ctx);
        if (note) ctx.ui.deleteNoteWithUndo?.(note);
      },
    }),
    // Enter, a click, or the menu on a Backlinks-panel row opens the linking
    // note with its link line revealed. The reveal is registered before the
    // open, as the search overlay does it (Overlay.tsx): openNote's render
    // attaches the editor the reveal lands in. The meta comes from the selected
    // workspace's list, where a backlink must live because the scan is
    // workspace-scoped (bun/notes.ts backlinksTo); a vanished note is a no-op.
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
        ctx.dispatch({ type: "openNote", note, preview: true });
      },
    }),
    // Enter or a click on an Outline-panel row puts the caret on that heading
    // in the active note's own editor. Nothing is dispatched: the note is
    // already the one on screen, so the jump is the whole verb.
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
    // Copy the heading's wikilink, ready to paste: [[Title#Heading]], or plain
    // [[Title]] when the row is the H1. The H1's text is the tab title
    // (filenames follow the H1), and [[Title#Title]] would be a roundabout
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
    // Show the notes bearing a tag, in the Tags panel's drill-in. Every tag
    // click lands here: a Tags-panel directory row, a tag row in the overlay,
    // and a rendered #tag in the editor (which arrives via the bridge). One
    // verb for the three surfaces, so they cannot diverge.
    cmd("tag.open", {
      icon: Hash,
      targetKind: "tag",
      palette: false, // acts on a specific tag
      when: (ctx) => ctx.target?.kind === "tag",
      run: (ctx) => {
        const t = ctx.target;
        if (t?.kind === "tag") ctx.ui.showTag?.(t.tag);
      },
    }),
    // Enter on a Tags-panel occurrence row opens the bearing note with the
    // tag's line revealed. This is backlink.open's body with a tag target,
    // including the reveal-before-open ordering and the vanished-note no-op.
    cmd("tag.openNote", {
      icon: FileText,
      targetKind: "tagnote",
      palette: false, // acts on a specific row
      when: (ctx) => ctx.target?.kind === "tagnote",
      run: (ctx) => {
        const t = ctx.target;
        if (t?.kind !== "tagnote") return;
        const note = notesOf(ctx.state, ctx.selected.folder).find((n) => n.path === t.path);
        if (!note) return;
        deps.revealBacklink(t.path, t.line, t.raw);
        ctx.dispatch({ type: "openNote", note, preview: true });
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

    // --- folders -------------------------------------------------------------
    // File a note in a folder. The row's menu and `m` act on the row, the
    // palette on the focused tab's note, which is Delete's target grammar
    // exactly. The destination is asked for rather than passed in, because the
    // chooser is also where a folder that does not exist yet gets created
    // (components/FolderPicker.tsx).
    // The favorite marker, toggled. One command with two titles rather than
    // the marker pairs' two commands (keys.ts says why), and the title is what
    // tells the reader which way it will go, since the star in the row already
    // says which way the note is now. Target-scoped like note.delete: the
    // sidebar row's menu passes its note, the palette passes none and
    // targetNote falls back to the focused tab. Absent in the manual, whose
    // pages take no marker (Bun refuses the write regardless).
    {
      id: "note.favorite",
      title: (ctx) => (targetNote(ctx)?.favorite ? "Unfavorite" : "Favorite"),
      listKeys: listKeysOf("note.favorite"),
      icon: Star,
      targetKind: "note",
      when: (ctx) => !!targetNote(ctx) && !docsSelected(ctx),
      run: (ctx) => {
        const note = targetNote(ctx);
        if (!note) return;
        void deps
          .favoriteNoteNow(ctx.selected.folder, note.path, !note.favorite, docIdsForPath(ctx.state, note.path))
          .then((error) => {
            if (error) ctx.ui.showError?.(error);
          }, failed(ctx));
      },
    },
    cmd("note.move", {
      icon: FolderInput,
      targetKind: "note",
      when: (ctx) => !!targetNote(ctx) && !docsSelected(ctx),
      run: (ctx) => {
        const note = targetNote(ctx);
        if (note) ctx.ui.pickFolder?.({ kind: "move", note });
      },
    }),
    // A folder row's own create verb. No dialog: the folder is the row, and
    // the only thing left to decide is the title, which is the H1. The note
    // opens Untitled with the caret on it, like every other create.
    cmd("note.newInFolder", {
      icon: FilePlus,
      targetKind: "folder",
      palette: false, // there is no "current folder" to act on
      when: (ctx) => ctx.target?.kind === "folder" && !docsSelected(ctx),
      run: (ctx) => {
        const t = ctx.target;
        if (t?.kind !== "folder") return;
        // The file is written now, unlike ⌘N's tab that may never be typed in.
        // A folder is in the browser only because a note is in it
        // (notes/folders.ts), so a deferred create would file the note into a
        // row that is not there yet. Untitled with the caret on the title, so
        // the first keystroke names it, as every create-then-open does.
        deps.expandFolder(ctx.selected.folder, t.folder);
        void deps.createNote(ctx.selected.folder, SCRATCH_DOC, t.folder).then((note) => {
          deps.revealTitle(note.path);
          // Into the list as well as into a tab. The watcher's refresh would
          // bring the row a moment later, and a row arriving after the note it
          // names is already open looks like a glitch.
          ctx.dispatch({ type: "noteAppeared", folder: ctx.selected.folder, note });
          ctx.dispatch({ type: "openNote", note });
        }, failed(ctx));
      },
    }),
    // New Folder… makes a folder and the first note in it. The browser shows
    // only the folders its notes are in (notes/folders.ts), so a folder made
    // empty would not appear at all. On a folder row it seeds the field with
    // that folder, so nesting one inside it is a name and an Enter.
    cmd("folder.new", {
      icon: FolderPlus,
      when: (ctx) => !docsSelected(ctx),
      run: (ctx) =>
        ctx.ui.pickFolder?.({
          kind: "new",
          parent: ctx.target?.kind === "folder" ? `${ctx.target.folder}/` : "",
        }),
    }),
    // Search one folder. The scope belongs to the overlay rather than to one of
    // its modes, so switching to Notes with a chip keeps it. Opens in text
    // mode, the mode a folder row cannot otherwise reach: quick-open is one
    // chord away and lists the whole workspace anyway. The app had no
    // folder-scoped text search before this verb, though `ledge search -f` and
    // the MCP tools' `folder` had answered it for agents since folders shipped.
    //
    // A selecting folder, not a placing one (architecture.md §3): it narrows
    // notes already listed, never becomes a path, and so is refused by nothing.
    cmd("folder.search", {
      icon: TextSearch,
      targetKind: "folder",
      palette: false, // acts on a specific row; there is no "current folder"
      when: (ctx) => ctx.target?.kind === "folder",
      run: (ctx) => {
        if (ctx.target?.kind === "folder") ctx.ui.openOverlay?.("search", { folder: ctx.target.folder });
      },
    }),
    // Rename a folder in a field on the row, not a dialog: the folder is the
    // row and its name is the whole question (Sidebar.tsx, components/
    // RenameField). The field takes a name and refuses a path
    // (shared/folders.ts folderLeafProblem), so Bun does one rename(2) of the
    // directory and reads no note's bytes: a folder of locked notes renames
    // with the vault shut, where Move to Folder… has to refuse a single one.
    // interactions.md §3 (Rename Folder…) has the rest, including the names
    // the field also refuses and why this row has no double-click.
    cmd("folder.rename", {
      icon: Pencil,
      targetKind: "folder",
      palette: false, // acts on a specific row; there is no "current folder"
      when: (ctx) => ctx.target?.kind === "folder" && !docsSelected(ctx),
      run: (ctx) => {
        if (ctx.target?.kind === "folder") ctx.ui.beginRenameFolder?.(ctx.target.folder);
      },
    }),
    // Deleting a folder deletes the notes in it. A folder is a row only
    // because notes are in it, so this is a verb on those notes spelled as a
    // verb on the row, the same shape the rename has (interactions.md §1,
    // folder row). Nothing is unlinked: each note goes to the trash on its own
    // and is in the Trash section afterwards, and the folder stops being listed
    // once nothing is in it, as losing its last note always does.
    //
    // Confirmed for the extent, not for irreversibility: a collapsed row does
    // not say whether `d` costs one note or forty. That is Remove Lock…'s
    // precedent (interactions.md §4), a confirm for a consequence that cannot
    // be seen rather than one that cannot be undone. So there is a dialog and
    // an Undo strip both: the dialog answers "how many", the strip answers "I
    // meant Cancel".
    cmd("folder.delete", {
      icon: Trash2,
      targetKind: "folder",
      destructive: true,
      palette: false, // acts on a specific row; there is no "current folder"
      when: (ctx) => ctx.target?.kind === "folder" && !docsSelected(ctx),
      run: (ctx) => {
        if (ctx.target?.kind === "folder") ctx.ui.confirmDeleteFolder?.(ctx.target.folder);
      },
    }),
    // Enter on a folder row: its primary action is showing what is in it
    // (interactions.md R6). The title reads the row's live expanded state, so
    // the menu item says which way it will go. One command with a live title
    // rather than a lockOn/lockOff pair, because this one holds a bare key and
    // two commands may not claim one bare key on one row kind (registry.test.ts
    // refuses it; the dispatcher would always fire the first). It is built
    // literally rather than through cmd() to carry that title, and keys.ts
    // still owns the identity. The browser owns the expansion, so run calls a
    // deps hook: nothing in the store knows a folder is open.
    {
      id: "folder.toggle",
      title: (ctx) =>
        ctx.target?.kind === "folder" && deps.folderExpanded(ctx.selected.folder, ctx.target.folder)
          ? "Collapse"
          : "Expand",
      listKeys: listKeysOf("folder.toggle"),
      icon: Folder,
      targetKind: "folder",
      palette: false, // acts on a specific row
      when: (ctx) => ctx.target?.kind === "folder",
      run: (ctx) => {
        if (ctx.target?.kind === "folder") deps.toggleFolder(ctx.selected.folder, ctx.target.folder);
      },
    },

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
    // The clipboard trio, its shifted variant, and Select All. `palette: false`
    // on all five: nobody reaches for Copy by typing its name, and a ranked list
    // for "copy" should surface Copy Path and Copy Link instead. The editor's
    // context menu is where these five live (interactions.md §11), and
    // registry.test.ts checks that they are reachable there.
    cmd("editor.cut", menuOnly(needsSelection(deps, editorCommand(deps, Scissors, (ed, docId) => ed.cut(docId))))),
    cmd("editor.copy", menuOnly(needsSelection(deps, editorCommand(deps, Copy, (ed, docId) => ed.copy(docId))))),
    // Paste is never greyed out. Whether the pasteboard holds anything takes an
    // async round trip to Bun, and `when` runs on every menu render. A paste
    // with nothing to paste inserts nothing.
    cmd("editor.paste", menuOnly(editorCommand(deps, ClipboardPaste, (ed, docId) => ed.paste(docId)))),
    cmd("editor.pastePlain", menuOnly(editorCommand(deps, ClipboardType, (ed, docId) => ed.pastePlain(docId)))),
    cmd("editor.selectAll", menuOnly(editorCommand(deps, TextSelect, (ed, docId) => ed.selectAll(docId)))),
    cmd("editor.find", editorCommand(deps, Search, (ed, docId) => ed.find(docId))),
    cmd("editor.replace", editorCommand(deps, Replace, (ed, docId) => ed.replace(docId))),
    cmd("editor.save", editorCommand(deps, Save, (ed, docId) => ed.save(docId))),
    // The two run verbs, each gated on a client-wide fact on top of
    // editorCommand's focused-doc test. A phone's palette has the first and not
    // the second (ios.md §8): an inline run draws a panel under the fence, and
    // a run in the terminal needs a drawer to put it in.
    cmd("block.runInline", onClient(runsBlocks, editorCommand(deps, Play, (ed, docId) => ed.runInline(docId)))),
    cmd(
      "block.runInTerminal",
      onClient(
        () => runsBlocks() && hasTerminal(),
        editorCommand(deps, TerminalSquare, (ed, docId) => ed.runInTerminal(docId)),
      ),
    ),
    // Follows the link under the caret. ⌘-click on the link is the accelerator
    // (editor/livePreview.ts). A caret not on a link makes this a no-op rather
    // than hiding the entry: `when` cannot see the caret cheaply, and find and
    // save keep the same always-visible contract.
    cmd("link.open", editorCommand(deps, ExternalLink, (ed, docId) => ed.openLink(docId))),
    // Toggles the checkbox on the caret's line. Clicking the rendered box is
    // the accelerator. Always visible and a no-op off target, the same contract
    // link.open has above.
    cmd("task.toggle", editorCommand(deps, SquareCheck, (ed, docId) => ed.toggleTask(docId))),
    // Markdown formatting (editor/formatting.ts): the ⌘B/⌘I/⌘K trio, bound in
    // CodeMirror like every editor-internal chord.
    cmd("format.bold", editorCommand(deps, Bold, (ed, docId) => ed.bold(docId))),
    cmd("format.italic", editorCommand(deps, Italic, (ed, docId) => ed.italic(docId))),
    cmd("format.link", editorCommand(deps, Link, (ed, docId) => ed.insertLink(docId))),
    // Four keystrokes a desktop keyboard makes and a phone's keyboard cannot:
    // Tab, ⇧Tab, `[[` and ```. They are registry commands so the accessory bar
    // can name them (ios.md §7). The bar sends a command id and nothing else,
    // the same contract the menu bar has always had.
    cmd("format.indent", editorCommand(deps, IndentIncrease, (ed, docId) => ed.indent(docId))),
    cmd("format.outdent", editorCommand(deps, IndentDecrease, (ed, docId) => ed.outdent(docId))),
    cmd("format.wikiLink", editorCommand(deps, Brackets, (ed, docId) => ed.wikiLink(docId))),
    cmd("format.codeBlock", editorCommand(deps, Code, (ed, docId) => ed.codeBlock(docId))),
    // Not gated on anything. Every client this runs on has some picture store,
    // and the seam answers null when the user cancels (lib/assets.ts).
    cmd("image.insert", editorCommand(deps, Image, (ed, docId) => ed.insertImage(docId))),
  ];

  // One palette entry per marked note, the same move workspace.select makes:
  // the palette is the picker, so ⌥⌘N needs no dialog. The slots are fixed but
  // the rows are not. Title and `when` read templateChoices(ctx) live, so
  // marking a note surfaces its entry on the next palette render, with no
  // restart and no rebuild. The new note opens as "Untitled" in the selected
  // workspace (wherever the template itself lives), and typing its H1 renames
  // it.
  for (let i = 0; i < TEMPLATE_SLOTS; i += 1) {
    list.push({
      id: `note.fromTemplate.${i}`,
      title: (ctx) => `${TEMPLATE_PREFIX}${templateChoices(ctx)[i]?.label ?? i}`,
      icon: FilePlus,
      when: (ctx) => !!templateChoices(ctx)[i],
      run: (ctx) => {
        const choice = templateChoices(ctx)[i];
        if (!choice) return;
        void deps.newNoteFromTemplate(ctx.selected.folder, choice.path).then((note) => {
          deps.revealTitle(note.path);
          ctx.dispatch({ type: "openNote", note });
        }, failed(ctx));
      },
    });
  }

  // Indexed quick-jumps, one command per slot so the dispatcher and the
  // palette stay plain data. ⌘N switches workspace and ⌃N selects a tab in the
  // focused pane, which is what the held-modifier badges advertise.
  for (let n = 1; n <= 9; n += 1) {
    // Indexed over the strip's workspaces, with the docs workspace excluded, so
    // ⌘N matches the badges on the rows the user can see. It also stays the way
    // back out of the docs workspace, whose own slot would otherwise shift every
    // number.
    list.push({
      id: `workspace.select.${n}`,
      title: (ctx) => `Switch to Workspace: ${stripWorkspaces(ctx)[n - 1]?.name ?? n}`,
      keys: [workspaceSelectKey(n)],
      when: (ctx) => !!stripWorkspaces(ctx)[n - 1],
      run: (ctx) => {
        const ws = stripWorkspaces(ctx)[n - 1];
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

// The current note's template marker: false, true, or the "daily" role. Same
// head parse as currentProfile. Null when there is no focused live doc to ask,
// which hides both marker verbs.
function currentTemplateFlag(ctx: CommandCtx, deps: RegistryDeps): boolean | "daily" | null {
  const docId = focusedDocId(ctx.selected);
  if (!docId) return null;
  const head = deps.noteHead(docId);
  return head === null ? null : parseFrontmatter(head).params.template;
}

// The focused tab's note as the store knows it, for the template-marker verb's
// lock check. The store's meta rather than the live doc's frontmatter: a held
// tab has no editor (noteHead is null there), while the watcher-refreshed lists
// carry the locked flag for every note either way. Null for a tab with no file
// yet, since an unsaved scratch note has nothing on disk to lock. The lock verbs
// resolve through targetNote instead: the same store lookup, but row-target
// aware for the sidebar menu.
function currentNoteMeta(ctx: CommandCtx): NoteMeta | null {
  const tab = focusedTab(ctx.selected);
  if (!tab?.path) return null;
  return notesOf(ctx.state, ctx.selected.folder).find((n) => n.path === tab.path) ?? null;
}

// Whether any visible workspace holds a locked note. This is what makes
// "Unlock Notes…" meaningful on a machine whose vault file has not arrived:
// vault state "none", but locked notes synced in. Bun's probe unlock handles
// the rest.
function anyLockedNote(ctx: CommandCtx): boolean {
  return ctx.state.workspaces.some((w) => notesOf(ctx.state, w.folder).some((n) => n.locked));
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

// An editor-internal command: its keys are bound inside CodeMirror, and
// `domains: []` keeps the window dispatcher out entirely. Invoking it from the
// palette refocuses the note's editor first, which deps.editor handles.
/** The same command, additionally withheld where this client says it has no
 * surface for it (lib/shell.ts). Wraps rather than replaces `when`, so the
 * editor's own focused-doc condition is not lost by the gating. */
function onClient(
  can: () => boolean,
  spec: Omit<Command, "id" | "title" | "keys">,
): Omit<Command, "id" | "title" | "keys"> {
  const already = spec.when;
  return { ...spec, when: (ctx) => can() && (already?.(ctx) ?? true) };
}

/** The same command, additionally withheld with nothing selected, which is what
 * greys out Cut and Copy. Wraps rather than replaces `when`, like onClient
 * above. */
function needsSelection(
  deps: RegistryDeps,
  spec: Omit<Command, "id" | "title" | "keys">,
): Omit<Command, "id" | "title" | "keys"> {
  const already = spec.when;
  return {
    ...spec,
    when: (ctx) => {
      const docId = focusedDocId(ctx.selected);
      return docId !== null && deps.hasSelection(docId) && (already?.(ctx) ?? true);
    },
  };
}

/** Out of the palette, into a menu. The reachability rule still holds: a
 * `palette: false` command needs a menu item, and registry.test.ts checks that
 * it has one. */
function menuOnly(spec: Omit<Command, "id" | "title" | "keys">): Omit<Command, "id" | "title" | "keys"> {
  return { ...spec, palette: false };
}

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
  // Whether the command holds a real chord: `keys`, not `listKeys`. A row
  // verb's bare key is a convenience, not a claim about frequency. The palette
  // ranks chorded commands a notch higher on a filtered query (CHORD_BOOST in
  // notes/fuzzy.ts), since a chord marks a frequent act (interactions.md §2).
  chorded: boolean;
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
      chorded: (c.keys?.length ?? 0) > 0,
      icon: c.icon,
      destructive: c.destructive,
    });
  }
  return items;
}
