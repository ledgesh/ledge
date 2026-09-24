# Getting Started

Ledge is the notebook for developers and DevOps. It runs code and commands straight from your Markdown.

The manual is read-only and its code blocks do not run. The note called Welcome to Ledge is where the same examples do run. Ledge creates it the first time it starts on a machine, whether that is your own computer or a new server, and it stays in the Scratch workspace until you delete it.

## Your first note

A note with a shell block in it:

```sh norun
curl -s https://api.github.com/zen
```

⌘↩ inside the block, or the Run button on it (a tap, on a phone), runs it. One line of output streams into a panel beneath the block.

That is a real shell, and it is the whole idea: any fenced block whose language is runnable gets a Run button. `sh`, `python`, `node`, and others are runnable out of the box, and the list is a setting. ⇧⌘↩ sends a block to the note's terminal drawer instead. See [[Running Code]].

## The shell persists between blocks

Each note keeps one shell for inline runs, so state carries from block to block. A note with these two blocks, run in order:

```sh norun
cd /tmp
export FLAVOR=nautical
```

```sh norun
pwd
echo "this shell is feeling $FLAVOR"
```

prints `/tmp` and `this shell is feeling nautical` under the second one. The `cd` and the `export` happened in the same shell the second block ran in.

Every note also has a full terminal: ⌃` opens the drawer. It is a separate shell from the inline one, and it belongs to that note alone.

## Point a note at a project

A note can declare where its shells start. Press ⌥⌘, to add frontmatter:

```
---
cwd: ~/Projects/my-app
env:
  NODE_ENV: development
---
```

Every shell the note spawns now starts in that directory with that environment. The blocks run where the code is. Two more lines are worth knowing:

- `profile: name` layers in secrets kept outside the notes folder ([[Profiles and Secrets]]).
- `host: staging` runs the note's blocks over ssh on that machine, while the note stays here ([[Run Code on Remote Hosts]]). Keeping the note itself on another machine is a different feature, a server connection ([[Keep Notes on a Remote Server]]).

[[Frontmatter and Environments]] covers the block in full.

To skip frontmatter entirely, attach a project folder as a workspace: run "Attach Folder as Workspace…" from the command palette (⇧⌘P) and give the folder's path, or press Choose Folder… to pick it. Its `.md` files become the workspace's notes, and their shells start in the project folder automatically.

## Write, link, and find

A note's first line names it: type `# Shipping Notes` and the file becomes `shipping-notes.md`. Link between notes with `[[Title]]` (typing `[[` opens a picker), and tag them with inline `#hashtags` or a frontmatter `tags:` line.

- ⌘P opens a note by title.
- ⌥⌘P searches full text across the workspace.
- ⌥⌘L shows backlinks, ⌥⌘O the outline, ⌥⌘T the tags.

Notes are ordinary `.md` files in ordinary folders, so git, agents, and shell tools work on them directly. Ledge follows outside changes even mid-edit. See [[Notes and Workspaces]] for where the files live, and [[Finding Things]] for search, links, and tags.

## What else Ledge does

- **Panes.** ⌘D splits the view right and ⇧⌘D splits it down, so several notes, each with its own shell, sit on screen at once. See [[Panes and Tabs]].
- **Daily notes and templates.** ⌘J opens today's note. Mark any note `template: true` in its frontmatter and ⌥⌘N stamps new notes from it. See [[Daily Notes and Templates]].
- **Agents.** A CLI launched inside a note's terminal can read and write your notes over MCP, and a `prompt` code fence pipes its text to `claude -p` with ⌘↩. See [[Agents and Ledge]].
- **Locking.** "Lock This Note…" encrypts a note's body on disk. Sync services, search, and agents see nothing until you unlock. See [[Note Locking]].
- **The CLI.** "Install Shell Command (ledge)" puts `ledge` on your PATH, so `ledge <title>` opens a note from any terminal and `ledge today` lands in the daily note. See [[The ledge CLI]].
- **Remote hosts.** A `host:` line sends a note's blocks over ssh to another machine while the note stays here. See [[Run Code on Remote Hosts]].
- **Remote servers.** Keep your notes on a server and use this app as the window onto it: the server holds the notes and runs the shells, over ssh. See [[Keep Notes on a Remote Server]].
- **Your phone.** The same app on an iPhone or iPad, reading and running the notes on that server. See [[Ledge on Your Phone]].
- **Appearance.** Ledge follows the system's light or dark setting. To pin one instead, set `appearance.theme` to `"light"` or `"dark"` under This app in Settings (⌘,) and relaunch.
- **Fonts.** `editor.fontSize` sizes note text and `terminal.fontSize` sizes the terminal, both under This app in Settings (⌘,). Relaunch to apply.

## Ledge on Linux

The Linux app is the same app. The keys in this manual are the keys of the desktop you are reading it on: a Mac reads Command chords, and Linux reads the same chords with Ctrl and Alt.

| On Linux | What differs |
| --- | --- |
| Tabs | Alt+1 to Alt+9 jumps to a tab, because Ctrl+1 to Ctrl+9 is the workspace jump. |
| The terminal drawer | Every plain Ctrl chord goes to the shell, so Ctrl+C still interrupts a program. Ctrl+Shift+C copies, Ctrl+Shift+V pastes, and Ctrl+Shift+P still opens the palette from the terminal. |
| Menus | There is no menu bar. Every menu item this manual names is in the command palette (Ctrl+Shift+P), and Quit Ledge is Ctrl+Q. |
| Two chords GNOME keeps | Ubuntu's desktop takes Ctrl+Alt+T and Ctrl+Alt+L before any app sees them, so Toggle Tags and Toggle Backlinks run from the palette there. |
| Passwords | Kept in the desktop's keyring through `secret-tool`, which the `libsecret-tools` package provides ([[Keep Notes on a Remote Server]]). |
| Spelling | Enchant's dictionaries, the ones WebKitGTK underlines with, through the `enchant-2` command ([[Notes and Workspaces]]). |
| Files | The app lives under `~/.local/share/sh.ledge.app`. Notes, settings, and the log stay under `~/.ledge`, as on a Mac. |

## Updating Ledge

Ledge checks for a newer version when it starts and once a day after that, and downloads one in the background when it finds one.

When the download finishes, a notice says so and Restart to Install Update appears in the Ledge menu (in the command palette, on Linux). Choosing it quits Ledge and reopens the new version. Notes are already saved. A block that is still running keeps running on the old server, and the new version waits for it to finish before it swaps the server for its own, so the output arrives in the new window.

Ledge > Check for Updates… (Check for Updates… in the palette, on Linux) checks now and tells you the result.

To check only when you ask, set `updates.automatic` to `false` under This app in Settings (⌘,) and relaunch. Ledge then makes no request at launch or during the day, and Check for Updates… still checks and downloads.

The check is a request to `ledge.sh` for the newest version's details. It carries nothing from your notes or settings.

## When something goes wrong

Ledge writes a log of each session, and Help > Reveal Log in Finder (Reveal Log in File Manager, on Linux) opens the folder it is in.

Two files sit there.
`ledge.log` is the session running now.
`ledge.previous.log` is the one before it, which is the file you want after a crash: relaunching Ledge starts a new log, and this is where the old one went.

Both are plain text. Attach them to a bug report.

The manual ends with six tutorials that combine these into working routines: [[Tutorial: Run a Project from a Note]], [[Tutorial: A Daily Workflow]], [[Tutorial: Pair with an Agent]], [[Tutorial: Keep Notes Synced]], [[Tutorial: Set Up a Ledge Server]], and [[Tutorial: Back Up Your Notes to S3]].
