# Getting Started

Ledge is the notebook for developers and DevOps. It runs code and commands straight from your Markdown.

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

## Point a note at a project

A note can declare where its shells live. Press ⌥⌘, to add frontmatter:

```
---
cwd: ~/Projects/my-app
env:
  NODE_ENV: development
---
```

Every shell this note spawns now starts in that directory with that environment, which is what turns a note into a control panel for one project: the blocks run where the code is. [[Frontmatter and Environments]] covers the block in full. Two more lines are worth knowing: `profile: name` layers in secrets kept outside the notes folder ([[Profiles and Secrets]]), and `host: staging` runs the note's blocks over ssh on another machine ([[Remote Hosts]]).

Better still, attach a project folder as a workspace (run "Attach Folder as Workspace…" from the command palette, ⇧⌘P). Its `.md` files become the workspace's notes, and their shells start in the project automatically, no frontmatter needed.

## Write, link, and find

A note's first line names it: type `# Shipping Notes` and the file becomes `shipping-notes.md`. Link between notes with `[[Title]]` (typing `[[` pops the picker), tag them with inline `#hashtags` or a frontmatter `tags:` line, and find everything again:

- ⌘P opens a note by title
- ⌥⌘P searches full text across the workspace
- ⌥⌘L shows backlinks, ⌥⌘O the outline, ⌥⌘T the tags

Notes are ordinary `.md` files in ordinary folders, so git, agents, and shell tools work on them directly, and Ledge follows outside changes even mid-edit. [[Notes and Workspaces]] covers where the files live, and [[Finding Things]] the search, links, and tags.

## A few more things worth trying

- ⌘J opens today's daily note. Mark any note `template: true` in its frontmatter and ⌥⌘N stamps new notes from it. [[Daily Notes and Templates]] has both stories.
- Agents plug in over MCP: a CLI launched inside a note's terminal can read and write your notes, and a `prompt` code fence pipes its text straight to `claude -p` with ⌘↩ ([[Agents and Ledge]]).
- "Install Shell Command (ledge)" puts `ledge` on your PATH, so `ledge <title>` opens a note from any terminal and `ledge today` lands in the daily note ([[The ledge CLI]]).
- "Lock This Note…" encrypts a note's body on disk: sync services, search, and agents see nothing until you unlock ([[Note Locking]]).

The reference pages above go deep on each feature, and the manual ends with four tutorials that put them together into working routines: [[Tutorial: Run a Project from a Note]], [[Tutorial: A Daily Workflow]], [[Tutorial: Pair with an Agent]], and [[Tutorial: Keep Notes Synced]].
