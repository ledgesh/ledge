# Getting Started

Ledge is a Markdown notes app where the code blocks actually run. Every note is a plain `.md` file on disk, every workspace is a folder you can point other tools at, and every note gets its own shell.

This page lives in the built-in Documentation workspace, which is read-only: you can select, copy, and run everything here, but writing happens in your own notes. To get back to them, click a workspace in the sidebar or press ⌘1.

## Run your first block

Put the cursor in the block below and press ⌘↩, or hover the block and click its Run button. The output streams into a panel right beneath it.

```sh
curl -s https://api.github.com/zen
```

That was a real shell. Any fenced block whose language is runnable (`sh`, `python`, `node`, and friends, configurable in Settings) gets the same treatment, and ⇧⌘↩ sends a block to the note's terminal drawer instead. The full story is in [[Running Code]].

## The shell sticks around

Each note keeps one persistent shell for inline runs, so state carries from block to block. Run these two in order:

```sh
cd /tmp
export FLAVOR=nautical
```

```sh
pwd
echo "this shell is feeling $FLAVOR"
```

Every note has a full terminal too: press ⌃` to open the drawer. It is a separate shell from the inline one, and it belongs to this note alone.

## Notes are files

A note's first line names it: type `# Shipping Notes` and the file becomes `shipping-notes.md`. Link between notes with `[[Title]]` (typing `[[` pops the picker), tag them with inline `#hashtags` or a frontmatter `tags:` line, and find everything again:

- ⌘P opens a note by title
- ⌥⌘P searches full text across the workspace
- ⌥⌘L shows backlinks, ⌥⌘O the outline, ⌥⌘T the tags

Because notes are ordinary files, git, agents, and shell tools work on them directly. Ledge watches the folder and follows along, even mid-edit. [[Notes and Workspaces]] covers the files side in full, and [[Finding Things]] the search, links, and tags.

## Point a note at a project

A note can declare where its shells live. Press ⌥⌘, to add frontmatter:

```
---
cwd: ~/Projects/my-app
env:
  NODE_ENV: development
---
```

Every shell this note spawns now starts in that directory with that environment. Two more lines are worth knowing: `profile: name` layers in secrets kept outside the notes folder, and `host: staging` runs the note's blocks over ssh on another machine.

Better still, attach a project folder as a workspace (run "Attach Folder as Workspace…" from the command palette, ⇧⌘P). Its `.md` files become the workspace's notes, and their shells start in the project automatically.

## A few more things worth trying

- ⌘J opens today's daily note. Mark any note `template: true` in its frontmatter and ⌥⌘N stamps new notes from it.
- Agents plug in over MCP: a CLI launched inside a note's terminal can read and write your notes, and a `prompt` code fence pipes its text straight to `claude -p` with ⌘↩.
- "Install Shell Command (ledge)" puts `ledge` on your PATH, so `ledge <title>` opens a note from any terminal and `ledge today` lands in the daily note.
- "Lock This Note…" encrypts a note's body on disk: sync services, search, and agents see nothing until you unlock.
