# Notes and Workspaces

This page covers where your notes live and how to arrange them: the file a note is, the folder a workspace is, the folders you file notes into, how a workspace reaches other people, and the tabs and panes you read them in.

## A note is a Markdown file

Press ⌘N and start typing. A new note opens as `# Untitled` with the word Untitled selected, so what you type becomes the title: type `Release Checklist` and Ledge names the file `release-checklist.md`. The first line names the note, so changing that heading later renames the file to follow. If two notes want the same name, the newer one gets a numbered suffix.

Notes are plain files, so anything can work on them: git, grep, scripts, other editors, agents. Ledge watches the folder and picks up outside changes as they happen, even while a note is open.

Ledge saves as you type, a moment after you pause. ⌘S saves at once.

## A workspace is a folder

The strip at the top of the sidebar lists your workspaces. Each one is a single folder of notes, and ⌘1 through ⌘9 jump between them. There are two kinds:

- **Attached.** "Attach Folder as Workspace…" (in the command palette, in the + button's menu, or by right-clicking the empty space below the workspaces) turns a folder you already have into a workspace, usually a project you work on. Type the folder's path (`~` stands for your home folder), or press Choose Folder… to pick it. Its `.md` files become notes where they are, and each of those notes runs its blocks in the project folder with no frontmatter ([[Running Code]]).
- **Managed.** ⇧⌘N creates a workspace whose folder Ledge makes for you inside `~/.ledge`. Its notes default to your home folder, and `cwd:` frontmatter points them elsewhere ([[Frontmatter and Environments]]).

Managed workspace folders live in `~/.ledge`.

With a workspace row focused, or from its right-click menu:

- Enter switches to it.
- `r` renames it, `i` changes its icon.
- Dragging reorders the strip.
- ⌫ deletes a managed workspace, or removes an attached one from Ledge. See [[Notes and Workspaces#Deleting or removing a workspace]].

## Deleting or removing a workspace

⌫ on a workspace row, the button that appears when you point at it, or the last item in its right-click menu takes the workspace out of the strip. What happens to the folder depends on the kind of workspace:

| Workspace | The verb | What happens to the folder |
| --- | --- | --- |
| Managed | Delete Workspace | Moves to `~/.ledge/.ledge-trash`, notes and all |
| Attached | Remove from Ledge | Stays where it is, untouched |

Either way an Undo strip appears at the bottom of the sidebar for a few seconds. Undo puts the workspace back where it was in the strip, with its name, icon, panes and tabs.

A deleted workspace stays recoverable after the strip fades. The Trash section under the workspaces lists deleted workspaces, where `r` restores one and `d` deletes it permanently after a confirmation, folder and all. Deleted workspaces are purged after 30 days, on the same `trash.ttlDays` setting as deleted notes.

A removed attached folder is never in the trash, because Ledge did nothing to it. Run "Attach Folder as Workspace…" and give the folder's path to add it back.

The last workspace in the strip cannot be deleted or removed.

To move an attached workspace's folder somewhere else on disk, remove it from Ledge, move the folder in Finder, and attach it again at its new place. Everything travels with the folder: the notes, the images, and the trash. A managed folder can leave `~/.ledge` the same way: move it out in Finder (⇧⌘G opens a hidden folder), attach it at its new place, then delete the empty workspace Ledge makes in the old one's place.

## Share a workspace with others

Put the workspace in a git repository and let the others clone it ([[Tutorial: Share Notes with a Git Clone]]). A workspace is a folder, and each clone of that folder attaches as an ordinary workspace.

Everyone works in their own clone. Notes appear and change on screen when a pull lands, with nothing to refresh.

Git merges what you all wrote. If a pull rewrites a note you have open and edited, your version keeps the file and the incoming one goes to the workspace trash, with a notice in the sidebar naming it.

A clone carries the notes, their images, and their frontmatter. It does not carry your profiles, which live outside every notes folder ([[Profiles and Secrets]]). Locked notes travel as ciphertext and arrive shut ([[Note Locking]]).

Blocks run on the machine that opens the note. A note's `cwd:`, `host:`, and `profile:` lines name paths, machines, and credentials on the setup it was written for, so a block that deploys from your laptop may find none of that in anyone else's clone ([[Frontmatter and Environments]]).

Read a workspace somebody sends you before you run anything in it, as you would a script from the same person.

Giving somebody a login to your Ledge server also gives them your notes, along with everything else on the machine ([[Keep Notes on a Remote Server]]).

## Folders

Notes can sit in folders inside the workspace, and the sidebar shows them as a tree. Click a folder to open it, click again to close it. A closed folder shows how many notes are inside. With a folder's row focused, ↑ and ↓ walk the tree and Enter opens or closes it, the same as everywhere else in the sidebar.

Which folders you have open is part of the layout, so the tree comes back the way you left it at the next launch, per workspace ([[Panes and Tabs]]). A folder that is gone by then comes back closed, since there is nothing left to open.

Press `/` with a folder's row focused, or choose "Search in Folder" from its right-click menu, to look only inside it ([[Finding Things]]).

Press `r` with a folder's row focused, or choose "Rename Folder…" from its right-click menu, to rename it. The row turns into a text field: type the new name and press Enter, or press Escape to leave it alone. Every note in the folder, and in the folders inside it, comes along, and any of them you have open stay open.

The field takes a name, not a path, so a rename cannot move the folder somewhere else. Ledge refuses a name another folder here already answers to, rather than merging the two: to combine two folders, move the notes across. Locked notes are no obstacle, because a rename leaves their contents untouched.

Press `d` or ⌫ with a folder's row focused, or choose "Delete Folder…" from its right-click menu, to delete it. Ledge asks first, and says how many notes that is, because a closed folder does not show what is inside it. Every note in the folder goes to the Trash, including the ones in the folders inside it. "Undo" in the strip at the bottom of the sidebar brings them all back at once, and the Trash section can restore them one at a time later on.

Anything in the folder that is not a note stays where it is: an image you put there yourself, say, or a folder you told Ledge to ignore. The row goes either way, because Ledge only shows folders with notes in them.

There are three ways to put a note in a folder:

- **Drag its row** onto a folder. Dropping it on the Notes header at the top moves it back out to the workspace itself.
- **"Move to Folder…"**, from the note's right-click menu, from the command palette, or by pressing `m` with the row focused.
- **"New Note in Folder"**, from a folder's right-click menu, which starts a new note already in it.

"Move to Folder…" opens a list of the workspace's folders. Type to narrow it, and if what you type is not a folder yet, the last row offers to create it. A name with slashes in it, like `projects/api`, makes a folder inside a folder. Nothing is created until you pick a row, so Escape leaves no empty folder behind.

**"New Folder…"** is in the File menu, in the command palette, in the menu beside the New Note button, in the menu you get by right-clicking the empty space below the note list, and in a folder's right-click menu, where it makes a folder inside that one. It creates the folder and opens the first note in it, because Ledge shows the folders its notes are in: a folder with nothing inside has no row.

That is also why moving the last note out of a folder takes the folder's row with it. The folder itself is still on disk, and putting a note back in it brings the row back.

Moving a note keeps everything about it. The file keeps its name, the tab stays open, and its images and links still work: Ledge rewrites the note's image references to point at the same pictures from where it now sits ([[Images]]). Wikilinks need no rewriting at all, because `[[Title]]` finds a note by its heading and not by its path ([[Finding Things]]).

A locked note has to be unlocked before it can move, because those image references are inside the encrypted body ([[Note Locking]]).

Two notes in different folders may share a title. Ledge shows the folder beside the title wherever the list is flat: quick-open, full text search, backlinks, and tag results.

## Moving a note to another workspace

Choose "Move to Workspace…" from the note's right-click menu or the command palette, or drag its row onto a workspace in the strip above the list.
The note lands at the top level of that workspace, under the name it had, and any tab you have open on it goes along.
Its images go with it: Ledge copies them into the other workspace's own image folder and rewrites the note's references, so the pictures still show. The copies in the workspace you left stay there, in case another note there shows the same picture.
Wikilinks are the one thing that does not travel. `[[Title]]` finds a note in its own workspace, so notes here that linked to the moved note will stop finding it, and the strip at the bottom of the sidebar says how many that is. "Undo" there moves the note straight back.
A locked note moves with its vault open and is refused with it shut, as with moving between folders ([[Note Locking]]).
Folders do not move between workspaces; move their notes one at a time.
The two workspaces are on the same machine, since a window shows one machine's notes at a time ([[Keep Notes on a Remote Server]]). If they are on different disks, the original is put in the old workspace's Trash rather than deleted, and the copy in the new workspace is the note from then on.

## Favorites

A favorite note sits in a Favorites section at the top of the sidebar, above the tree, however deep in a folder it actually lives.

Favorite a note by pressing `f` with its row focused, by choosing "Favorite" from its right-click menu, or by clicking the star that appears on the row when you point at it. The same three ways unfavorite it, and the menu item says "Unfavorite" once the note is marked.

The note stays where it is. Its row in the tree does not move, because the tree says where a note lives and the section says which notes you keep coming back to. A favorite has a row in both places, and either row's `f`, star or menu unfavorites it.

Favorites are per workspace, and the section is not there at all until you mark something.

Marking a note writes `favorite: true` into its frontmatter ([[Frontmatter and Environments]]), so it is part of the note: it survives a rename, travels when you move the note to another folder, and comes across with the file if you sync your notes to another machine. You can type the line yourself instead, and take it out by deleting the line.

A locked note can be favorited without unlocking it, because the marker sits in the part of the file that stays readable ([[Note Locking]]).

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

## Right-click menus

Right-click anywhere in a note to get a menu of what you can do there.

Cut, Copy, Paste, Paste as Plain Text and Select All are always in it, followed by Bold, Italic, Insert Link, Link to Note, Code Block and Insert Image.
Above those sits whatever you clicked on: Open Link on a link, a `[[wikilink]]` or a `#tag`, Toggle Checkbox on a task, and both run verbs inside a runnable code block.
On a misspelled word, its suggested spellings and Learn Spelling come first ([[Notes and Workspaces#Spell checking]]).

The click moves the cursor to where you clicked, so the menu acts on that spot.
Right-clicking inside a selection keeps the selection, which is how you cut, copy or bold the text you just selected.

Every item shows its keyboard shortcut beside it, so the menu is also where you find them.

The sidebar answers a right-click too. On a row you get that row's menu, and on the empty space below a list you get the list's own: New Workspace and Attach Folder as Workspace… under the workspaces, New Note and New Folder… under the notes. Those two are the menus the small chevrons beside the New Workspace and New Note buttons drop.

## Spell checking

Ledge underlines misspelled words in a note with a red squiggle, using your Mac's spelling dictionary and its languages.

Only prose is checked. Code blocks, `inline code`, URLs, HTML, the frontmatter block, `[[wikilinks]]` and `#tags` are never underlined. The built-in documentation is not checked, and neither is a note on your phone.

Right-click a misspelled word to fix it. The dictionary's suggestions sit at the top of the menu: choose one to replace the word. "Learn Spelling" adds the word to your Mac's dictionary, which every app on the Mac shares, so it stops being underlined here and elsewhere.

Words are judged in the language of the line they are on, so a German paragraph is checked as German.

Set `editor.spellCheck` to `false` under This app in Settings (⌘,) and relaunch to turn spell checking off. The right-click menu then offers no suggestions either.

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
