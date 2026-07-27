# Notes and Workspaces

This page covers where your notes live and how to arrange them: the file a note is, the folder a workspace is, and the tabs and panes you read them in.

## A note is a Markdown file

Press ⌘N and start typing. The first line names the note: type `# Release Checklist` and Ledge names the file `release-checklist.md`. Change the heading and the file is renamed to follow. If two notes want the same name, the newer one gets a numbered suffix.

Notes are plain files, so anything can work on them: git, grep, scripts, other editors, agents. Ledge watches the folder and picks up outside changes as they happen, even while a note is open.

## A workspace is a folder

The strip at the top of the sidebar lists your workspaces. Each one is a single folder of notes, and ⌘1 through ⌘9 jump between them. There are two kinds:

- **Attached.** "Attach Folder as Workspace…" (in the command palette, or the + button's menu) turns a folder you already have into a workspace, usually a project you work on. Its `.md` files become notes where they are, and each of those notes runs its blocks in the project folder with no frontmatter ([[Running Code]]).
- **Managed.** ⇧⌘N creates a workspace whose folder Ledge makes for you inside `~/.ledge`. Its notes default to your home folder, and `cwd:` frontmatter points them elsewhere ([[Frontmatter and Environments]]).

Managed workspace folders live here:

```sh
ls ~/.ledge
```

With a workspace row focused, or from its right-click menu:

- Enter switches to it.
- `r` renames it, `i` changes its icon.
- Dragging reorders the strip.
- "Move Workspace Folder…" relocates the folder on disk.
- ⌫ closes it, which only detaches it. No files are touched, and attaching the same folder later brings everything back.

## Deleting a note

`d` or ⌫ on a note's row, or ⌘⌫ from the editor, moves the note to the workspace's trash and shows an Undo strip for a few seconds.

Nothing is lost when the strip fades. The Trash section at the bottom of the sidebar holds the note, where `r` restores it and `d` deletes it permanently after a confirmation. Trashed notes are purged after 30 days, set by `trash.ttlDays`.

## Tabs and panes

Notes open in tabs.

- ⌘W closes a tab, ⌃Tab cycles, ⌃1 through ⌃9 jump directly.
- ⌘D splits the view right, ⇧⌘D splits it down, so two notes sit side by side.
- ⌥⌘B hides the sidebar.
