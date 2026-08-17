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
  FolderInput,
  FolderOpen,
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
  Play,
  Plus,
  RefreshCw,
  Replace,
  RotateCcw,
  Rows2,
  Save,
  Scale,
  Scissors,
  ScrollText,
  Search,
  Server as ServerIcon,
  Settings as SettingsIcon,
  Shapes,
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
import { notesOf, trashOf } from "@/workspace/store";
import { parseFrontmatter } from "../../shared/frontmatter";
import type { NoteMeta } from "../../shared/rpc-schema";
import { canInstallCli, canPickFolder, hasTerminal, multiWindow, runsBlocks, spawnsSessions } from "../lib/shell";
import { docsWindow } from "../lib/windows";
import { keysOf, listKeysOf, tabSelectKey, titleOf, workspaceSelectKey, type CommandId } from "./keys";
import { chipOf } from "./format";
import type { Command, CommandCtx, RegistryDeps } from "./types";

// A command whose identity (title/keys) comes from the key table; the rest is
// behavior. Keeps the table and the registry from drifting apart.
function cmd(id: CommandId, rest: Omit<Command, "id" | "title" | "keys" | "listKeys">): Command {
  return { id, title: titleOf(id), keys: keysOf(id), listKeys: listKeysOf(id), ...rest };
}

// The generated per-template entries' shared title prefix — and, verbatim,
// the query note.fromTemplate seeds the palette with: the fuzzy filter then
// shows exactly these entries (the ":" keeps the parent command's own
// "…"-titled row from matching itself back into the list).
const TEMPLATE_PREFIX = "New Note from Template: ";

// Pre-registered entry slots for the picker (commands are data built once;
// the workspace.select move, sized for a template collection rather than a
// keyboard row). A choice past the last slot simply has no entry — at that
// point the collection needs pruning more than the palette needs scrolling.
const TEMPLATE_SLOTS = 24;

// One picker row: what its entry says after the prefix, and the concrete note
// it instantiates.
interface TemplateChoice {
  label: string;
  path: string;
}

// The picker's rows, computed from LIVE state on every render/dispatch: every
// note whose frontmatter declares `template: true` (NoteMeta.template — the
// store's per-folder lists, refreshed by the watcher, are the registry; no
// settings, no restart). The selected workspace's own templates lead,
// unlabeled; other workspaces' follow in strip order, each naming its home,
// so a title shared across workspaces stays two distinguishable rows.
// Alphabetical within a workspace — mtime order would reshuffle the picker
// every time a template is edited.
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
// body is the whole how-to — the {{token}} vocabulary is written out
// LITERALLY here (createNote, not instantiateTemplate, writes it), so the
// note teaches the syntax and, once instantiated, demonstrates it. Titled
// with the app's placeholder word: the H1 is the rename UI.
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
// nobody hand-writes the frontmatter. Deliberately spare where
// STARTER_TEMPLATE is a cheatsheet: every line here lands verbatim in each
// day's note, so the body must be worth waking up to, not documentation.
// The H1 is replaced by the date at instantiation.
const DAILY_STARTER = `---
template: daily
---
# Daily Template

Continued from [[{{yesterday}}]].
`;

// The workspace ⌘J acts in — daily.workspace as resolved at boot (a dep:
// that mirror is a setting's, not view state), else the selected one — and
// its current `template: daily` claimant. The role is per-workspace, so the
// Edit/New verbs must point exactly where ⌘J will look; the note lists are
// newest-first, so find() is the same newest-wins Bun applies when several
// notes claim the role.
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
  // The selected workspace is the built-in read-only documentation: every
  // create/mutate verb gates on this (menus disable, the palette hides, the
  // dispatcher ignores). Presentation only — Bun refuses every docs write
  // regardless (bun/workspaces.ts assertWritableRoot).
  const docsSelected = (ctx: CommandCtx) => deps.workspaceKind(ctx.selected.folder) === "docs";
  // The workspace a workspace-scoped verb would act on is the docs one — the
  // palette forms fall back to the selected workspace, which can be it.
  const docsTargeted = (ctx: CommandCtx) => {
    const ws = ctx.state.workspaces.find((w) => w.id === targetWorkspaceId(ctx));
    return ws !== undefined && deps.workspaceKind(ws.folder) === "docs";
  };
  // The strip's workspaces: what the sidebar shows and ⌘1…9 index — the docs
  // workspace deliberately excluded from both (Sidebar filters the same way).
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
    // The built-in documentation — read-only end to end; the header's help
    // button is the icon surface. Hidden entirely when Bun reported no docs
    // root (a failed boot, a harness without one).
    //
    // On a shell with windows the manual gets one of its own (remote.md §8a),
    // so this opens or raises that window and the workspace in front of you is
    // left where it was. Absent from the manual's own window, which is why it
    // is no longer a toggle there: the way to put a window away is its close
    // button, and the way back to your notes is the window still sitting behind
    // this one.
    //
    // On a client with one window and no way to have two (a phone, ios.md §4)
    // it stays the toggle it was: the manual takes over the window, and the
    // same button — lit, since the manual is the selected workspace — is the
    // way back, because the strip that would otherwise offer one is inside the
    // drawer the manual is covering.
    cmd("docs.toggle", {
      // A question mark, not a book: on a notes app, a book glyph reads as
      // "another notebook", while ? is the universal help affordance.
      icon: CircleHelp,
      when: () => deps.docsFolder() !== null && !docsWindow(),
      run: (ctx) => {
        if (multiWindow()) deps.openDocsWindow("");
        else if (docsSelected(ctx)) deps.closeDocs(ctx.state, ctx.dispatch);
        else void deps.openDocs(ctx.state, ctx.dispatch);
      },
    }),
    // The bundled licenses, as the manual's last page. It is a page and not a
    // file the Finder reveals because the app already knows how to show a
    // Markdown document, and because a notice reproduced somewhere the user
    // cannot reach is the same as one that did not ship.
    //
    // Offered in the manual's window too, unlike the verb above: there it means
    // "turn to that page", and the page is right here.
    cmd("docs.licenses", {
      icon: Scale,
      when: () => deps.docsFolder() !== null,
      run: (ctx) => {
        // By title: the corpus renumbers pages as it grows, and the H1 is what
        // survives that (bun/docsContent.ts).
        if (multiWindow() && !docsWindow()) deps.openDocsWindow("Third-Party Licenses");
        else void deps.openDocs(ctx.state, ctx.dispatch, "Third-Party Licenses");
      },
    }),
    // Create-or-open today's YYYY-MM-DD note and land in it. The open rides
    // the external-open subscriber (the CLI-open path), so glue's dep only
    // resolves to an error to surface — or null, done.
    cmd("daily.open", {
      icon: CalendarDays,
      // In the docs workspace, ⌘J still works when a daily workspace is
      // pinned (Bun acts there, not here); unpinned it would fall back to the
      // selected — read-only — folder, so it gates instead of erroring.
      //
      // In the manual's WINDOW it is gone either way: that window holds one
      // workspace and it is the manual, so a daily note opened here would have
      // no pane to land in (App's external-open subscriber would drop it).
      when: (ctx) => !docsWindow() && (!docsSelected(ctx) || deps.dailyRoot() !== null),
      run: (ctx) => {
        void deps.openDailyNote(ctx.selected.folder).then((err) => {
          if (err) ctx.ui.showError?.(err);
        });
      },
    }),
    // The palette IS the template picker: pre-filtered to the generated
    // per-template entries below, rather than growing a dialog of its own.
    // Always visible — with no template anywhere yet, it pre-filters to
    // New Template instead, so the empty state is the tutorial rather than
    // a missing menu item.
    cmd("note.fromTemplate", {
      icon: FilePlus,
      when: (ctx) => !docsSelected(ctx), // instantiates into the selected folder
      run: (ctx) =>
        ctx.ui.openOverlay?.(
          "commands",
          templateChoices(ctx).length > 0 ? TEMPLATE_PREFIX : titleOf("template.starter"),
        ),
    }),
    // Creates the pre-marked cheatsheet note above and opens it for editing.
    cmd("template.starter", {
      icon: LayoutTemplate,
      when: (ctx) => !docsSelected(ctx), // creates into the selected folder
      run: (ctx) => {
        void deps.createNote(ctx.selected.folder, STARTER_TEMPLATE).then(
          (note) => ctx.dispatch({ type: "openNote", note }),
          (err) => ctx.ui.showError?.(err instanceof Error ? err.message : String(err)),
        );
      },
    }),
    // The marker's verbs on the current note, exactly one visible at a time
    // (the `when`s read the live frontmatter, profile.open's move). The edit
    // happens in the note's own editor — undoable, autosaved, and the saved
    // file's watcher refresh is what updates the picker's rows.
    cmd("note.templateOn", {
      icon: LayoutTemplate,
      // The marker exclusivity's UI half (Bun refuses too): a locked note's
      // body exists to stay sealed, a template's to be stamped out.
      when: (ctx) =>
        currentTemplateFlag(ctx, deps) === false && currentNoteMeta(ctx)?.locked !== true && !docsSelected(ctx),
      run: (ctx) => {
        const docId = focusedDocId(ctx.selected);
        if (docId) deps.editor.toggleTemplate(docId);
      },
    }),
    cmd("note.templateOff", {
      icon: LayoutTemplate,
      // Truthy, not === true: a `template: daily` note is a template too,
      // and this verb is how its marker (role included) comes off.
      when: (ctx) => !!currentTemplateFlag(ctx, deps),
      run: (ctx) => {
        const docId = focusedDocId(ctx.selected);
        if (docId) deps.editor.toggleTemplate(docId);
      },
    }),
    // The daily role's verb, two faces so the title says what will happen
    // (keys.ts). Opens ride openNoteIn — the external-open subscriber's
    // select-then-open — because the daily workspace may not be the selected
    // one, and the verb must land where ⌘J will look.
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
      // Also gated when the workspace it would create INTO is the docs one
      // (no pinned daily workspace, docs selected): nothing creates there.
      when: (ctx) => {
        const { ws, claimant } = dailyTemplateTarget(ctx, deps);
        return !claimant && deps.workspaceKind(ws.folder) !== "docs";
      },
      run: (ctx) => {
        const { ws } = dailyTemplateTarget(ctx, deps);
        void deps.createNote(ws.folder, DAILY_STARTER).then(
          (note) => deps.openNoteIn(ws.folder, note),
          (err) => ctx.ui.showError?.(err instanceof Error ? err.message : String(err)),
        );
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
    // Splitting stays available in the docs workspace — two pages side by side
    // is what a second pane is FOR when reading — but the new pane opens empty
    // there: a seeded scratch tab would be a read-only "Untitled" that can
    // never be typed in or saved. The empty pane is the existing "No open
    // notes" state (docs-aware already), and it takes the next page opened.
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
    // None of the two verbs that ADD one are offered in the manual's window: it
    // shows one workspace and has no strip to put another in, so a workspace
    // created there would be invisible and selected — the manual replaced by a
    // scratch note, in a window with no way back to either (remote.md §8a).
    cmd("workspace.new", {
      icon: Plus,
      when: () => !docsWindow(),
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
      // Absent where the picker cannot open, rather than present and answering
      // with NO_DIALOG: a headless server has nobody at it to choose a folder,
      // and a phone is permanently that case (ios.md §8, lib/shell.ts).
      when: () => canPickFolder() && !docsWindow(),
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
    // The docs workspace takes none of the object-scoped workspace verbs
    // below (rename/icon/move): it has no strip row to anchor them, and its
    // name, icon, and folder are the app's, not the user's. The palette forms
    // fall back to the selected workspace, which is how a docs target arrives.
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
    // Relocate the workspace's folder on disk (Bun renames; same volume only).
    // The cloud-backup move: a managed folder under the hidden ~/.ledge, moved
    // into iCloud Drive or Dropbox, keeps every note and becomes an external
    // workspace. Open tabs close — arrangement loss, no confirm
    // (interactions.md §4). A managed folder goes straight to the native
    // destination picker; an external one stops at the in-app chooser first
    // (Sidebar's MoveWorkspaceDialog), because its natural destination — back
    // under ~/.ledge — is the one place the native dialog cannot reasonably
    // navigate to (a hidden folder).
    cmd("workspace.move", {
      icon: FolderInput,
      targetKind: "workspace",
      // Both faces end at the same native picker — the in-app chooser an
      // external workspace stops at first only offers "back to the app home"
      // beside it — so workspace.attach's condition governs this one too.
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
        });
      },
    }),
    cmd("workspace.close", {
      icon: Trash2,
      targetKind: "workspace",
      destructive: true,
      // Closing the docs workspace needs only SOMETHING else to land on;
      // closing a real one must leave another real one — the docs workspace
      // does not count as a place to strand the user (no strip row would
      // show where they are).
      when: (ctx) =>
        docsTargeted(ctx) ? ctx.state.workspaces.length > 1 : stripWorkspaces(ctx).length > 1,
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
    cmd("tags.toggle", {
      icon: Hash,
      run: (ctx) => ctx.ui.toggleTags?.(),
    }),
    cmd("terminal.toggle", {
      icon: TerminalSquare,
      // The drawer's own gate, and not the same question as running a block
      // (lib/shell.ts): a phone runs blocks inline before it has a drawer to
      // put one in. Not a refusal either way — the daemon at the other end
      // would spawn the PTY — but a surface that is not built, so the verbs
      // that reach it are not offered.
      when: () => hasTerminal(),
      // The editor's CodeMirror keymap and the terminal's xterm handler own
      // Ctrl-` in their domains and route here through exec; the window layer
      // only fires it from page focus.
      domains: ["page"],
      run: (ctx) => ctx.ui.toggleTerminal?.(),
    }),
    cmd("terminal.close", {
      icon: X,
      when: () => hasTerminal(),
      palette: false, // Toggle Terminal covers it
      run: (ctx) => ctx.ui.closeTerminal?.(),
    }),
    // Opens settings.jsonc in Ledge's own editor dialog — the file is the
    // settings UI (architecture.md "Settings"), its comments the
    // documentation; changes apply at the next launch.
    // --- note locking (locking.md §7) -----------------------------------
    // ⌘L relocks NOW — the walking-away gesture. Flush-then-drop lives in the
    // dep (glue): the view must save dirty locked buffers before Bun forgets
    // how to encrypt them.
    cmd("vault.lock", {
      icon: Lock,
      when: () => deps.vaultState() === "unlocked",
      run: () => deps.lockVaultNow(),
    }),
    // The proactive unlock. Interposed unlock (opening a locked note) rides
    // the placeholder's own button; this entry is for unlocking ahead of
    // need. Visible while there is anything a passphrase would open — a
    // vault, or (vaultless machine, synced-in locked notes) any locked note.
    cmd("vault.unlock", {
      icon: LockOpen,
      when: (ctx) => deps.vaultState() === "locked" || (deps.vaultState() === "none" && anyLockedNote(ctx)),
      run: (ctx) => ctx.ui.openVaultDialog?.(),
    }),
    // The per-note pair: exactly one face shows (the template-marker move),
    // per the note's LIVE locked flag off the store's lists. Target-scoped
    // like note.delete — the sidebar row's menu passes its note; the palette
    // passes none and targetNote falls back to the focused tab. Locking a
    // note with no vault yet runs first-time setup with the lock as
    // follow-up; with a locked vault, unlock first, same follow-up — the
    // dialog carries the intent so the user's act completes instead of
    // dead-ending.
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
          ctx.ui.openVaultDialog?.({ lock: { path: note.path, folder: ctx.selected.folder } });
          return;
        }
        void deps.lockNoteNow(ctx.selected.folder, note.path).then((res) => {
          if (res.error) ctx.ui.showError?.(res.error);
          else if (res.notice) ctx.ui.showNotice?.(res.notice);
        });
      },
    }),
    // Unlocked only: the rewrap needs the old master key in hand, and asking
    // for the old passphrase inside the dialog would duplicate what the
    // unlock flow already proves.
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
    // Which machine the notes are on. Everything workspace-scoped is scoped
    // to a server one level up (remote.md §8), so this is the widest-scope
    // switch in the app — and the only one that closes every tab.
    //
    // Not in the manual's window: the manual is this build's own, read off this
    // Mac whatever the window that opened it was looking at (remote.md §8a), so
    // there is no other machine for it to be on.
    cmd("connection.switch", {
      icon: ServerIcon,
      when: () => !docsWindow(),
      run: (ctx) => ctx.ui.openConnectionPicker?.(),
    }),
    // Two machines at once, which switching cannot give you: a window is a
    // client of one server, so a second server is a second window (remote.md
    // §8a). It opens on this Mac and is switched from inside itself, which is
    // why this takes no argument and asks nothing.
    //
    // Absent where there is no second window to open, rather than present and
    // silent: a phone shows one app (lib/shell.ts multiWindow).
    cmd("window.new", {
      icon: AppWindow,
      when: () => multiWindow(),
      run: () => deps.newWindow(),
    }),
    // Put `ledge` on the PATH. The outcome always surfaces — an install whose
    // result you have to go hunting for in a bin dir did not finish its job:
    // success (where it landed, whether PATH sees it) in the neutral strip,
    // failure (a foreign file squatting the name) in the error strip.
    //
    // The PATH is the notes machine's, so the verb belongs to a machine with a
    // CLI on it: a server has none to install (lib/shell.ts), and offering the
    // install anyway would answer a hopeful palette entry with a paragraph
    // about a path inside the server binary.
    cmd("cli.install", {
      icon: TerminalSquare,
      when: () => canInstallCli(),
      run: (ctx) => {
        void deps.installCli().then((r) => {
          if (r.ok) ctx.ui.showNotice?.(r.message);
          else ctx.ui.showError?.(r.message);
        });
      },
    }),
    // The answer to "it crashed, what do I send you". No notice strip on
    // success: a Finder window opening IS the confirmation, and a toast on
    // top of it would be the second one.
    cmd("log.reveal", {
      icon: ScrollText,
      run: () => deps.revealLog(),
    }),

    // --- per-note params (frontmatter) ----------------------------------------
    // Kill the current note's shells; the next run/attach respawns them with
    // the note's current frontmatter params — the restart-applies escape hatch.
    cmd("session.restart", {
      icon: RefreshCw,
      // Both surfaces spawn the shells this kills, so either one is reason
      // enough to offer it — and a client with neither has no shell to restart
      // and should never have been offering it (lib/shell.ts).
      when: (ctx) => spawnsSessions() && focusedDocId(ctx.selected) !== null,
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
      // A profile is the environment a block runs in, so a client that does not
      // run blocks has nothing to edit one for (ios.md §8).
      when: (ctx) => runsBlocks() && currentProfile(ctx, deps) !== null,
      run: (ctx) => {
        const name = currentProfile(ctx, deps);
        if (name) ctx.ui.openProfileEditor?.(name);
      },
    }),
    // Put the caret inside the current note's frontmatter, creating the block
    // when there is none — the front door to the per-note params (editor/
    // frontmatterEdit.ts does the editing). ONE command with a live title
    // rather than the templateOn/Off two-faces move, because this one holds a
    // chord and the dispatcher ignores `when`: two commands on ⌥⌘, would
    // always fire the first. Built literally (not via cmd()) for exactly that
    // title; keys.ts still owns the identity.
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
        // Not in the docs workspace: the Add face would insert fences the
        // read-only editor drops on the floor — a chord that visibly does
        // nothing (the editor's transaction filter is the enforcement).
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
        if (note) ctx.dispatch({ type: "openNote", note });
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
      // Page focus only: in the editor, CodeMirror's Mod-Backspace
      // (delete-to-line-start) wins by the preventDefault contract. On a
      // focused note row it acts on that row — ⌘⌫ meaning "delete the note I
      // am pointing at" is the same promise either way.
      domains: ["page"],
      when: (ctx) => (ctx.target?.kind ?? "note") === "note" && !!targetNote(ctx) && !docsSelected(ctx),
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
    // Enter on (or click of) a tag anywhere — a Tags-panel directory row, a
    // tag row in the overlay, a rendered #tag in the editor (via the bridge):
    // show the notes bearing it, in the panel's drill-in. One verb, three
    // surfaces, so they cannot diverge.
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
    // Enter on a Tags-panel occurrence row: open the bearing note with the
    // tag's line revealed — backlink.open's body with a tag target, down to
    // the reveal-before-open ordering and the vanished-note no-op.
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
        ctx.dispatch({ type: "openNote", note });
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
    // The clipboard trio, its shifted variant, and the selection they act on.
    // `palette: false` on all five: nobody reaches for Copy by typing its
    // name, and in a ranked list "copy" has to surface Copy Path and Copy
    // Link, which people do reach for. The editor's context menu is their home
    // (interactions.md §11), which is what registry.test.ts checks instead.
    cmd("editor.cut", menuOnly(needsSelection(deps, editorCommand(deps, Scissors, (ed, docId) => ed.cut(docId))))),
    cmd("editor.copy", menuOnly(needsSelection(deps, editorCommand(deps, Copy, (ed, docId) => ed.copy(docId))))),
    // Paste is never greyed: whether the pasteboard holds anything is an async
    // round trip to Bun, and `when` runs on every menu render. A paste with
    // nothing to paste inserts nothing, which is the cheaper wrong answer.
    cmd("editor.paste", menuOnly(editorCommand(deps, ClipboardPaste, (ed, docId) => ed.paste(docId)))),
    cmd("editor.pastePlain", menuOnly(editorCommand(deps, ClipboardType, (ed, docId) => ed.pastePlain(docId)))),
    cmd("editor.selectAll", menuOnly(editorCommand(deps, TextSelect, (ed, docId) => ed.selectAll(docId)))),
    cmd("editor.find", editorCommand(deps, Search, (ed, docId) => ed.find(docId))),
    cmd("editor.replace", editorCommand(deps, Replace, (ed, docId) => ed.replace(docId))),
    cmd("editor.save", editorCommand(deps, Save, (ed, docId) => ed.save(docId))),
    // The two run verbs, and the two client-wide facts they need. Each sits on
    // top of editorCommand's focused-doc test, and the client-wide half is the
    // reason a phone's palette has the first of these and not the second
    // (ios.md §8). They differ because the destination does: inline draws a
    // panel under the fence, and in-terminal needs a drawer to put it in.
    cmd("block.runInline", onClient(runsBlocks, editorCommand(deps, Play, (ed, docId) => ed.runInline(docId)))),
    cmd(
      "block.runInTerminal",
      onClient(
        () => runsBlocks() && hasTerminal(),
        editorCommand(deps, TerminalSquare, (ed, docId) => ed.runInTerminal(docId)),
      ),
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
    // Markdown formatting (editor/formatting.ts): the ⌘B/⌘I/⌘K trio, bound in
    // CodeMirror like every editor-internal chord.
    cmd("format.bold", editorCommand(deps, Bold, (ed, docId) => ed.bold(docId))),
    cmd("format.italic", editorCommand(deps, Italic, (ed, docId) => ed.italic(docId))),
    cmd("format.link", editorCommand(deps, Link, (ed, docId) => ed.insertLink(docId))),
    // The four the keyboard reaches by typing on a desktop and cannot on a
    // phone: Tab, ⇧Tab, `[[` and ```. Registry commands so the accessory bar can
    // name them (ios.md §7) — the bar sends a command id and nothing else, the
    // same contract the menu bar has always had.
    cmd("format.indent", editorCommand(deps, IndentIncrease, (ed, docId) => ed.indent(docId))),
    cmd("format.outdent", editorCommand(deps, IndentDecrease, (ed, docId) => ed.outdent(docId))),
    cmd("format.wikiLink", editorCommand(deps, Brackets, (ed, docId) => ed.wikiLink(docId))),
    cmd("format.codeBlock", editorCommand(deps, Code, (ed, docId) => ed.codeBlock(docId))),
    // Not gated on anything: every client this runs on has SOME picture store,
    // and the seam answers null where the user declined (lib/assets.ts).
    cmd("image.insert", editorCommand(deps, Image, (ed, docId) => ed.insertImage(docId))),
  ];

  // One palette entry per marked note — the workspace.select move: the
  // palette is the picker, so ⌥⌘N needs no dialog. The slots are fixed but
  // the rows are not: title and `when` read templateChoices(ctx) live, so
  // marking a note surfaces its entry on the next palette render, no restart
  // and no rebuild. The created note opens as "Untitled" in the selected
  // workspace (wherever the template itself lives), and typing its H1
  // renames it.
  for (let i = 0; i < TEMPLATE_SLOTS; i += 1) {
    list.push({
      id: `note.fromTemplate.${i}`,
      title: (ctx) => `${TEMPLATE_PREFIX}${templateChoices(ctx)[i]?.label ?? i}`,
      icon: FilePlus,
      when: (ctx) => !!templateChoices(ctx)[i],
      run: (ctx) => {
        const choice = templateChoices(ctx)[i];
        if (!choice) return;
        void deps.newNoteFromTemplate(ctx.selected.folder, choice.path).then(
          (note) => ctx.dispatch({ type: "openNote", note }),
          (err) => ctx.ui.showError?.(err instanceof Error ? err.message : String(err)),
        );
      },
    });
  }

  // Indexed quick-jumps, one command per slot so the dispatcher and the
  // palette stay plain data. ⌘N switches workspace, ⌃N selects a tab in the
  // focused pane — exactly what the held-modifier badges advertise.
  for (let n = 1; n <= 9; n += 1) {
    // Indexed over the STRIP's workspaces (docs excluded), so ⌘N matches the
    // badges on the rows the user can see — and stays the way back out of the
    // docs workspace, whose own slot would otherwise shift every number.
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

// The current note's template marker (false, true, or the "daily" role) —
// same head parse as currentProfile, null when there is no focused live doc
// to ask (which hides BOTH marker verbs).
function currentTemplateFlag(ctx: CommandCtx, deps: RegistryDeps): boolean | "daily" | null {
  const docId = focusedDocId(ctx.selected);
  if (!docId) return null;
  const head = deps.noteHead(docId);
  return head === null ? null : parseFrontmatter(head).params.template;
}

// The focused tab's note as the STORE knows it — the template-marker verb's
// lock check. The store's meta, not the live doc's frontmatter, deliberately:
// a held tab has no editor (noteHead is null there), while the
// watcher-refreshed lists carry the locked flag for every note either way.
// Null for a tab with no file yet: an unsaved scratch note has nothing on
// disk to lock. (The lock verbs themselves resolve through targetNote — the
// same store lookup, but row-target aware for the sidebar menu.)
function currentNoteMeta(ctx: CommandCtx): NoteMeta | null {
  const tab = focusedTab(ctx.selected);
  if (!tab?.path) return null;
  return notesOf(ctx.state, ctx.selected.folder).find((n) => n.path === tab.path) ?? null;
}

// Whether ANY visible workspace holds a locked note — what makes "Unlock
// Notes…" meaningful on a machine whose vault file has not arrived (state
// "none" but synced-in locked notes; Bun's probe unlock handles the rest).
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

// An editor-internal command: its keys are bound inside CodeMirror (domains:
// [] keeps the window dispatcher out entirely); invoking it from the palette
// refocuses the note's editor first, which deps.editor handles.
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

/** The same command, additionally withheld with nothing selected — what greys
 * Cut and Copy. Wraps rather than replaces `when`, like onClient above. */
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

/** Out of the palette, into a menu. The reachability rule still holds — a
 * `palette: false` command needs a menu item, which registry.test.ts checks. */
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
  // Whether the command holds a real chord (`keys`, not `listKeys` — a row
  // verb's bare key is a convenience, not a frequency claim). The palette
  // ranks chorded commands a notch higher on a filtered query (CHORD_BOOST):
  // a chord marks the act reached for most, per the §2 allocation policy.
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
