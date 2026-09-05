# Panes and Tabs

A workspace's editing area is a tree of panes, and each pane holds its own tabs. This page covers splitting, moving tabs between panes, and what Ledge saves about the arrangement.

Panes put notes side by side. Each note keeps its own shell ([[Running Code]]), so two panes are two working environments rather than two views of one.

## Split a pane

⌘D splits the focused pane left and right. ⇧⌘D splits it top and bottom.

The new pane opens with a fresh Untitled note and takes focus. Either side can split again, along either axis, as many times as you like. The layout is a tree, not a fixed two-column or three-column arrangement.

In the manual's window the new pane opens empty instead, because there is no new note to make in a read-only folder. It still takes focus, so the next page you open lands in it and two pages sit side by side.

A tab's context menu carries Split Right, Split Down and Close Pane too, and those act on the tab's own pane rather than the focused one.

On a phone the tab strip has no split buttons, because two panes on a screen this narrow are two editors about 195 points wide. The commands are still in the palette and in a tab's menu, so a split you ask for by name is a split you get.

## Focus a pane

Click anywhere in a pane to focus it. The caret moves to that pane's editor, and the other panes dim.

Focus decides what most commands act on. ⌘W closes a tab in the focused pane, ⌃` opens the focused note's terminal, and a note you open from ⌘P lands there.

There is no chord for moving focus between panes. Click to change panes, and use ⌃Tab to move within one.

## Resize a split

Drag the divider between two panes.

A pane can take between 12% and 88% of the space its split divides. The ratio is saved with the layout.

## Close a pane

⇧⌘W closes the focused pane, and its space returns to the neighboring pane.

The ✕ at the end of a pane's tab strip does the same for that pane, and a tab's context menu carries Close Pane too. Both appear only once a workspace has more than one pane, so the single-pane arrangement shows nothing to close.

The last remaining pane in a workspace does not close.

Closing a pane's tabs one at a time leaves the pane standing and empty, showing a New Note button. ⇧⌘W is what removes the pane itself.

On a phone the ✕ stays, unlike the two split buttons beside it. There is no ⇧⌘W to press there, so the ✕ and the menu item are the two ways out of a split.

## Tabs in a pane

Each pane has its own tab strip.

| Key | Action |
| --- | --- |
| ⌘N | New note in the focused pane. |
| ⌘W | Close the active tab. |
| ⌃Tab and ⌃⇧Tab | Next and previous tab. ⇧⌘] and ⇧⌘[ do the same. |
| ⌃1 to ⌃9 | Jump to a tab by position. |

Hold ⌃ and each tab shows its number. The + button at the end of the strip is New Note, and a tab's context menu holds Close Tab and Close Other Tabs.

When a pane holds more tabs than fit, the strip scrolls sideways and fades at whichever edge is hiding tabs.

## Move a tab between panes

Drag a tab onto another pane's strip and drop it where you want it in the order. Dragging within one strip reorders it.

A moved tab keeps its caret, scroll position, undo history, and the output of any block still running in it. Ledge re-parents the editor rather than rebuilding it, both when a tab moves and when you switch tabs.

The destination pane takes focus, as if you had clicked the tab there. If the tab was active in the pane it left, that pane falls to the tab beside it.

## Where a note opens

A note that is already open focuses its existing tab, wherever that tab lives, including in another workspace. Ledge never opens one note twice, because two tabs on one file would be two editors saving over each other.

A note that is not open becomes a new tab in the focused pane. This is how ⌘P, search hits, wikilinks, backlinks, and `ledge <title>` from a terminal all arrive ([[Finding Things]], [[The ledge CLI]]).

## The terminal drawer follows the focused note

⌃` opens the terminal for whichever note has focus. Switching panes or tabs swaps the drawer to that note's shell.

Shells keep running while the drawer shows another note's. Coming back replays the scrollback.

There is one drawer, spanning the window below the panes, rather than one per pane.

## Layouts are saved per workspace

Each workspace keeps its own pane tree. ⌘1 through ⌘9 switch the whole arrangement, not just the note ([[Notes and Workspaces]]).

Ledge saves the layout as you change it and restores it at the next launch. Two things do not come back:

- **Tabs you never typed in.** A note has no file until its first edit, so an untouched Untitled tab has nothing to restore. Its pane returns with a fresh one.
- **Notes that moved or were deleted while Ledge was closed.** Those tabs are dropped and the rest of the layout restores around them.

## The window

Ledge reopens the windows you left open, each at the position and size you left it.

If a position no longer exists, because you unplugged the display it was on or the display got smaller, Ledge keeps the size and centers the window on the display that best matches.

New Window in the File menu opens another one. A window is on one server at a time, so a second window is how you have two servers open at once ([[Keep Notes on a Remote Server]]).

The help button in the top right opens this manual in a window of its own, so reading it costs you nothing you had open. Pressing it again brings that window forward rather than opening a second one. It is the one window Ledge does not reopen at the next launch, since it is a button away.

Two more keys for the window itself:

- ⌥⌘B hides the sidebar.
- ⌃⌘F enters full screen, also in the View menu.
