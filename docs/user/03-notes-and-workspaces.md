# Notes and Workspaces

This page covers where your notes live and how to arrange them: the file a note is, the folder a workspace is, the folders you file notes into, and the tabs and panes you read them in.

## A note is a Markdown file

Press ⌘N and start typing. A new note opens as `# Untitled` with the word Untitled selected, so what you type becomes the title: type `Release Checklist` and Ledge names the file `release-checklist.md`. The first line names the note, so changing that heading later renames the file to follow. If two notes want the same name, the newer one gets a numbered suffix.

Notes are plain files, so anything can work on them: git, grep, scripts, other editors, agents. Ledge watches the folder and picks up outside changes as they happen, even while a note is open.

Ledge saves as you type, a moment after you pause. ⌘S saves at once.

## A workspace is a folder

The strip at the top of the sidebar lists your workspaces. Each one is a single folder of notes, and ⌘1 through ⌘9 jump between them. There are two kinds:

- **Attached.** "Attach Folder as Workspace…" (in the command palette, or the + button's menu) turns a folder you already have into a workspace, usually a project you work on. Its `.md` files become notes where they are, and each of those notes runs its blocks in the project folder with no frontmatter ([[Running Code]]).
- **Managed.** ⇧⌘N creates a workspace whose folder Ledge makes for you inside `~/.ledge`. Its notes default to your home folder, and `cwd:` frontmatter points them elsewhere ([[Frontmatter and Environments]]).

Managed workspace folders live in `~/.ledge`.

With a workspace row focused, or from its right-click menu:

- Enter switches to it.
- `r` renames it, `i` changes its icon.
- Dragging reorders the strip.
- "Move Workspace Folder…" relocates the folder on disk.
- ⌫ closes it, which only detaches it. No files are touched, and attaching the same folder later brings everything back.

## Folders

Notes can sit in folders inside the workspace, and the sidebar shows them as a tree. Click a folder to open it, click again to close it. A closed folder shows how many notes are inside. With a folder's row focused, ↑ and ↓ walk the tree and Enter opens or closes it, the same as everywhere else in the sidebar.

There are three ways to put a note in a folder:

- **Drag its row** onto a folder. Dropping it on the Notes header at the top moves it back out to the workspace itself.
- **"Move to Folder…"**, from the note's right-click menu, from the command palette, or by pressing `m` with the row focused.
- **"New Note in Folder"**, from a folder's right-click menu, which starts a new note already in it.

"Move to Folder…" opens a list of the workspace's folders. Type to narrow it, and if what you type is not a folder yet, the last row offers to create it. A name with slashes in it, like `projects/api`, makes a folder inside a folder. Nothing is created until you pick a row, so Escape leaves no empty folder behind.

**"New Folder…"** is in the File menu, in the command palette, in the menu beside the New Note button, and in a folder's right-click menu, where it makes a folder inside that one. It creates the folder and opens the first note in it, because Ledge shows the folders its notes are in: a folder with nothing inside has no row.

That is also why moving the last note out of a folder takes the folder's row with it. The folder itself is still on disk, and putting a note back in it brings the row back.

Moving a note keeps everything about it. The file keeps its name, the tab stays open, and its images and links still work: Ledge rewrites the note's image references to point at the same pictures from where it now sits ([[Images]]). Wikilinks need no rewriting at all, because `[[Title]]` finds a note by its heading and not by its path ([[Finding Things]]).

A locked note has to be unlocked before it can move, because those image references are inside the encrypted body ([[Note Locking]]).

Two notes in different folders may share a title. Ledge shows the folder beside the title wherever the list is flat: quick-open, full text search, backlinks, and tag results.

## Which files become notes

Every `.md` file in the workspace folder and its subfolders is a note, with two kinds of exception.

Dot-prefixed files and folders are skipped, which keeps `.git` and Ledge's own `.ledge-assets` and `.ledge-trash` out of the list. So are the usual vendor and build directories, at any depth: `node_modules`, `bower_components`, `vendor`, `dist`, `build`, `out`, `target`, `coverage`, `__pycache__`, `Pods`, and `DerivedData`.

A `.ledgeignore` file in the workspace folder adds your own, one pattern per line, in a small subset of gitignore's grammar:

| Line | Skips |
| --- | --- |
| `drafts` | Any file or folder named `drafts`, at any depth. |
| `drafts/` | Only a folder of that name. |
| `docs/archive` | That path, counted from the workspace folder. |
| `*.wip.md` | Names matching the glob. `*` and `?` stay within one path segment. |
| `!build` | Nothing. It brings `build` back, and the last matching line wins. |
| `# text` | Nothing. A comment. |

Ignoring only hides. An ignored note is absent from the sidebar and from search, and a note you had open when it became ignored still saves.

## Live preview

Ledge hides Markdown syntax away from the cursor. `**bold**` shows as bold and the asterisks come back when you move the cursor into it, a link shows its label, a checkbox is clickable, and tables and images render in place. Text in backticks is drawn on a tinted chip, so it still reads as code once the backticks themselves are hidden.

Set `editor.livePreview` to `false` under This app in Settings (⌘,) and relaunch to see every character all the time. Tables and images stay as text in that mode too. Use it when you are editing syntax precisely and want the text on screen to match the text on disk.

Everything else is unaffected: ⌘B, the `[[` picker, and fence completion work the same either way.

## Right-clicking in a note

Right-click anywhere in a note to get a menu of what you can do there.

Cut, Copy, Paste, Paste as Plain Text and Select All are always in it, followed by Bold, Italic, Insert Link, Link to Note, Code Block and Insert Image.
Above those sits whatever you clicked on: Open Link on a link, a `[[wikilink]]` or a `#tag`, Toggle Checkbox on a task, and both run verbs inside a runnable code block.

The click moves the cursor to where you clicked, so the menu acts on that spot.
Right-clicking inside a selection keeps the selection, which is how you cut, copy or bold the text you just selected.

Every item shows its keyboard shortcut beside it, so the menu is also where you find them.

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

Nothing is lost when the strip fades. The Trash section at the bottom of the sidebar holds the note, where `r` restores it and `d` deletes it permanently after a confirmation. "Empty Trash…" in the command palette does that for every note in it. Trashed notes are purged after 30 days, set by `trash.ttlDays`.

The trash mirrors your folders, so restoring a note puts it back in the folder it was deleted from, creating that folder again if it has gone.

## Tabs and panes

Notes open in tabs, and ⌘D splits the view so two notes sit side by side. Each workspace keeps its own arrangement.

See [[Panes and Tabs]] for splitting, moving tabs between panes, and what Ledge restores at launch.
