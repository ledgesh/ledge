# Notes and Workspaces

Everything in Ledge is an ordinary file in an ordinary folder. This page covers where those files live and how to arrange them.

## A note is a Markdown file

Press ⌘N and start typing. The first line is the note's name: type `# Release Checklist` and Ledge names the file `release-checklist.md`. Change the heading and the file is renamed to follow. If two notes want the same name, the newer one gets a numbered suffix.

Because notes are plain files, anything can work on them: git, grep, scripts, other editors, agents. Ledge watches the folder and picks up outside changes as they happen, even while a note is open.

## A workspace is a folder

The strip at the top of the sidebar lists your workspaces. Each one is a single folder of notes, and ⌘1 through ⌘9 jump between them. There are two kinds:

- ⇧⌘N creates a managed workspace: Ledge makes a folder for it inside `~/.ledge`.
- "Attach Folder as Workspace…" (in the command palette, or the + button's menu) turns a folder you already have into a workspace. Its `.md` files become notes, right where they are.

Peek behind the curtain (managed workspace folders live here):

```sh
ls ~/.ledge
```

With a workspace row focused (or from its right-click menu): Enter switches to it, `r` renames it, `i` changes its icon, and dragging reorders the strip. "Move Workspace Folder…" relocates the folder itself on disk.

Closing a workspace (⌫ on its row) only detaches it: no files are touched, and attaching the same folder later brings everything back exactly as it was.

## Deleting is gentle

Deleting a note (`d` or ⌫ on its row, ⌘⌫ from the editor) moves it to the workspace's trash and offers an Undo strip for a few seconds. Nothing is lost when the strip fades: the Trash section at the bottom of the sidebar holds the note, where `r` restores it and `d` deletes it permanently after a confirmation. Trashed notes are purged for good after 30 days (the `trash.ttlDays` setting).

## Tabs and panes

Notes open in tabs: ⌘W closes one, ⌃Tab cycles, ⌃1 through ⌃9 jump directly. ⌘D splits the view right and ⇧⌘D splits it down, so two notes sit side by side. ⌥⌘B tucks the sidebar away when you want the whole window for writing.
