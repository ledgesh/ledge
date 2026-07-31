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

## Live preview

Ledge hides Markdown syntax away from the cursor. `**bold**` shows as bold and the asterisks come back when you move the cursor into it, a link shows its label, a checkbox is clickable, and tables and images render in place.

Set `editor.livePreview` to `false` in Settings (⌘,) and relaunch to see every character all the time. Tables and images stay as text in that mode too. Use it when you are editing syntax precisely and want the text on screen to match the text on disk.

Everything else is unaffected: ⌘B, the `[[` picker, and fence completion work the same either way.

## Pasting formatted text

⌘V converts formatted text to Markdown. Copy a section of a web page, an email, a Slack thread, or a Google Doc, and the structure survives the paste:

| Copied | Pasted |
| --- | --- |
| Heading | `## Heading` |
| Bold, italic, strikethrough | `**bold**`, `*italic*`, `~~struck~~` |
| Bulleted and numbered lists | `- item`, `1. item`, nested and indented |
| Checkboxes | `- [x] done` |
| Link | `[label](https://example.com)` |
| Table | A GFM pipe table, alignment included |
| Code block | A fence, labelled with the language when the page named one |
| Quote | `> quoted` |
| Image on the web | `![alt](https://example.com/x.png)` |

⇧⌘V pastes the text as it is, with no conversion. Use it when you want the words and none of the markup.

Ledge converts only what carries formatting. Copying from a terminal, an editor, or the browser's developer tools puts styled but unstructured HTML on the pasteboard, and pasting that gives you your lines exactly as they were. A paste inside a fenced block, a code span, or a frontmatter block is never converted: the text there has to be exact.

An image on the pasteboard is embedded as a file instead. See [[Images]].

## Deleting a note

`d` or ⌫ on a note's row, or ⌘⌫ from the editor, moves the note to the workspace's trash and shows an Undo strip for a few seconds.

Nothing is lost when the strip fades. The Trash section at the bottom of the sidebar holds the note, where `r` restores it and `d` deletes it permanently after a confirmation. Trashed notes are purged after 30 days, set by `trash.ttlDays`.

## Tabs and panes

Notes open in tabs, and ⌘D splits the view so two notes sit side by side. Each workspace keeps its own arrangement.

See [[Panes and Tabs]] for splitting, moving tabs between panes, and what Ledge restores at launch.
