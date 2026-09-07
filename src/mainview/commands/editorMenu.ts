// The note editor's context menu, as a spec (interactions.md §11).
//
// Every other menu in Ledge is JSX with its conditionals inline, which suits
// a note row's five verbs. Which verbs this one carries depends on where the
// pointer landed: on a link, on a task, inside a runnable fence, in a
// read-only page. That decision is a function so a unit test can call it.
// workspace/EditorMenu.tsx probes the editor, calls this, and renders the ids
// it gets back in order; it makes no decisions of its own.
//
// This is menu.ts's move for the menu bar, with one difference: the bar is
// one fixed list because it has no pointer and nothing to point at, and this
// is one fixed list per click.
import type { CommandId } from "./keys";

/** What the right-click landed on. The first three fields are read off the
 * editor at click time (editor/rightClick.ts) and `readOnly` comes from the
 * pane (workspace/PaneTree.tsx). Nothing is remembered between two openings
 * of the menu. */
export interface EditorClickContext {
  // The click is on a link, a [[wikilink]] or a #tag: somewhere `link.open`
  // has a destination to follow.
  onLink: boolean;
  // The click's line carries a `[ ]` or `[x]` task marker.
  onTask: boolean;
  // The click sits inside a closed, runnable fence that is not marked `norun`
  // (runnableBlockAt in editor/blocks.ts). An unterminated fence has no agreed
  // body and offers no run (interactions.md §4c).
  onRunnableBlock: boolean;
  // The note cannot be edited: the built-in manual (architecture.md §3b).
  // Every writing verb is absent rather than greyed, matching the note row's
  // menu in that workspace. A verb that can never apply to any note here is
  // noise, not discoverability.
  readOnly: boolean;
}

export type EditorMenuItem = CommandId | "---";

/**
 * Whether a right-click at `pos` should leave the selection where it is.
 *
 * The platform rule, followed by every text view: a click inside a selection
 * is about that selection, and a click anywhere else moves the caret first.
 * Otherwise Cut and Bold act where the caret happened to be rather than where
 * the menu was opened (interactions.md §11).
 */
export function keepsSelection(
  ranges: readonly { from: number; to: number; empty: boolean }[],
  pos: number,
): boolean {
  return ranges.some((r) => !r.empty && pos >= r.from && pos <= r.to);
}

// What the pointer landed on. This group goes first, so the item the click
// was about sits nearest the pointer. It is usually empty, so in ordinary
// prose the menu opens with the clipboard group.
function pointedAt(ctx: EditorClickContext): CommandId[] {
  const items: CommandId[] = [];
  if (ctx.onLink) items.push("link.open");
  if (ctx.onTask) items.push("task.toggle");
  // Read-only is no bar to running. What removes these two on the manual's
  // blocks is the `norun` mark, which clears `onRunnableBlock`
  // (runnableBlockAt; interactions.md §4e). On a client with no surface to run
  // in, `runsBlocks` and `hasTerminal` leave the two commands' `when` false
  // (interactions.md §8), and CommandMenuItem greys a disabled item.
  if (ctx.onRunnableBlock) items.push("block.runInline", "block.runInTerminal");
  return items;
}

// The clipboard. Copy and Select All survive a read-only page, so a reader
// can copy a command out of the manual.
function clipboard(ctx: EditorClickContext): CommandId[] {
  return ctx.readOnly
    ? ["editor.copy", "editor.selectAll"]
    : ["editor.cut", "editor.copy", "editor.paste", "editor.pastePlain", "editor.selectAll"];
}

// Writing verbs: the three chorded ones (⌘B, ⌘I, ⌘K), then the three a
// pointer has no other way to reach at all. Link to Note is typed as `[[`, a
// fence is typed as ```, and Insert Image… is palette-only on a Mac.
function writing(ctx: EditorClickContext): CommandId[] {
  return ctx.readOnly
    ? []
    : ["format.bold", "format.italic", "format.link", "format.wikiLink", "format.codeBlock", "image.insert"];
}

/**
 * The menu for one click: command ids with "---" dividers, in render order.
 * A group that comes back empty takes its divider with it, so the menu never
 * opens with, ends with, or doubles a separator. buildMenu holds the menu bar
 * to the same rule (menu.ts): a hidden item must not leave a visible gap.
 */
export function editorMenu(ctx: EditorClickContext): EditorMenuItem[] {
  const groups = [pointedAt(ctx), clipboard(ctx), writing(ctx)].filter((g) => g.length > 0);
  return groups.flatMap((group, i) => (i === 0 ? group : ["---" as const, ...group]));
}

/** Every id the menu can name, in any context. registry.test.ts adds these to
 * its "in a menu" set: it finds every other menu's ids by scanning JSX, and
 * this menu is data. */
export const EDITOR_MENU_COMMANDS: readonly CommandId[] = [
  ...new Set(
    [true, false].flatMap((readOnly) =>
      editorMenu({ onLink: true, onTask: true, onRunnableBlock: true, readOnly }).filter(
        (item): item is CommandId => item !== "---",
      ),
    ),
  ),
];
