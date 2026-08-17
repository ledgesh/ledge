// The note editor's context menu, as a spec (interactions.md §11).
//
// Every other menu in Ledge is JSX with its conditionals inline, which is
// fine for a note row's five verbs. This one is decided by where the pointer
// landed — on a link, on a task, inside a runnable fence, in a read-only page
// — so which verbs it carries is a function, and a function belongs in a file
// a unit test can call. The component (workspace/EditorMenu.tsx) probes the
// editor, calls this, and renders CommandMenuItems in the order it gets back;
// it makes no decisions of its own.
//
// This is the menu.ts move (the menu bar's spec is data too), with one
// difference: the menu BAR is a fixed list because it has no pointer and
// nothing to point at, and this one is a fixed list per click.
import type { CommandId } from "./keys";

/** What the right-click landed on. Everything here is read off the editor at
 * click time (editor/rightClick.ts); nothing is remembered between two
 * openings of the menu. */
export interface EditorClickContext {
  // The click is on a link, a [[wikilink]] or a #tag — somewhere `link.open`
  // has a destination to follow.
  onLink: boolean;
  // Its line carries a `[ ]` / `[x]` task marker.
  onTask: boolean;
  // It sits inside a CLOSED fence whose language is runnable (§4c: an
  // unterminated fence has no agreed body and offers no run).
  onRunnableBlock: boolean;
  // The note cannot be edited: the built-in manual (architecture.md §3b).
  // Every writing verb is ABSENT rather than greyed, which is what the note
  // row's menu already does there — a verb that can never apply to any note
  // in this workspace is noise, not discoverability.
  readOnly: boolean;
}

export type EditorMenuItem = CommandId | "---";

/**
 * Whether a right-click at `pos` should leave the selection where it is.
 *
 * The platform rule, and the one every text view follows: a click INSIDE a
 * selection is about that selection, and a click anywhere else moves the caret
 * first. Without it, Cut and Bold act wherever the caret happened to be — not
 * where the menu was opened, which is the only place the user is looking. It
 * lives with the spec rather than with the DOM that applies it
 * (editor/rightClick.ts) so its edges are a unit test rather than a memory.
 */
export function keepsSelection(
  ranges: readonly { from: number; to: number; empty: boolean }[],
  pos: number,
): boolean {
  return ranges.some((r) => !r.empty && pos >= r.from && pos <= r.to);
}

// What the pointer is ON, first, because it is what the click was about and
// it lands nearest the pointer. Usually empty, which is why the clipboard
// group reads as the top of the menu in ordinary prose.
function pointedAt(ctx: EditorClickContext): CommandId[] {
  const items: CommandId[] = [];
  if (ctx.onLink) items.push("link.open");
  if (ctx.onTask) items.push("task.toggle");
  // Read-only is no bar to running: the manual's own shell demos are live
  // (interactions.md §3, Documentation). The two verbs' `when` still withdraws
  // them on a client with no surface to run in (§8), which is what greys them.
  if (ctx.onRunnableBlock) items.push("block.runInline", "block.runInTerminal");
  return items;
}

// The clipboard. Copy and Select All survive a read-only page — reading the
// manual and copying a command out of it is the point of it.
function clipboard(ctx: EditorClickContext): CommandId[] {
  return ctx.readOnly
    ? ["editor.copy", "editor.selectAll"]
    : ["editor.cut", "editor.copy", "editor.paste", "editor.pastePlain", "editor.selectAll"];
}

// Writing verbs: the three chorded ones (⌘B, ⌘I, ⌘K), then the three a
// pointer has no other way to reach at all — "Link to Note" is typed as `[[`,
// a fence is typed as ```, and Insert Image… is palette-only on a Mac.
function writing(ctx: EditorClickContext): CommandId[] {
  return ctx.readOnly
    ? []
    : ["format.bold", "format.italic", "format.link", "format.wikiLink", "format.codeBlock", "image.insert"];
}

/**
 * The menu for one click: command ids with "---" dividers, in render order.
 * A group that comes back empty takes its divider with it, so the menu never
 * opens with, ends with, or doubles a separator (buildMenu's rule, and the
 * same reason: a hidden item must not leave a visible gap).
 */
export function editorMenu(ctx: EditorClickContext): EditorMenuItem[] {
  const groups = [pointedAt(ctx), clipboard(ctx), writing(ctx)].filter((g) => g.length > 0);
  return groups.flatMap((group, i) => (i === 0 ? group : ["---" as const, ...group]));
}

/** Every id the menu can name, in any context — what registry.test.ts counts
 * as "in a menu" for this one, since it is data rather than the JSX that test
 * reads everywhere else. */
export const EDITOR_MENU_COMMANDS: readonly CommandId[] = [
  ...new Set(
    [true, false].flatMap((readOnly) =>
      editorMenu({ onLink: true, onTask: true, onRunnableBlock: true, readOnly }).filter(
        (item): item is CommandId => item !== "---",
      ),
    ),
  ),
];
