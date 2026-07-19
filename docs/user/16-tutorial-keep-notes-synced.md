# Tutorial: Keep Notes Synced

Ledge notes are plain files in ordinary folders, so syncing or backing them up is just syncing a folder: iCloud Drive, Dropbox, git, Syncthing, whatever you already trust. This tutorial covers the two common setups and the few facts worth knowing first.

## What a workspace folder holds

Everything a workspace is lives in its folder: the notes as `.md` files, pasted images in `.ledge-assets/`, and deleted notes resting in `.ledge-trash/` (see [[Notes and Workspaces]]). Sync the folder and you have synced the workspace; there is no database on the side.

What is deliberately not in there: profiles. Secrets live outside every notes folder precisely so that syncing notes never ships credentials ([[Profiles and Secrets]]). And locked notes sync as ciphertext: a locked note is self-contained, so on another machine it unlocks with the passphrase alone ([[Note Locking]]).

One folder to leave out of sync plans: `~/.ledge` itself. It holds machine-local state (the workspace registry, window layout) alongside any managed workspace folders, so sync individual workspace folders, not the app home wholesale.

## Setup one: a synced drive

Create a folder inside iCloud Drive (or Dropbox, or any synced location), then run "Attach Folder as Workspace…" and pick it. Done: notes you write are files in the synced folder, and the service carries them. On a second Mac, attach the same folder there.

Ledge watches the folder and follows external changes live, so a note edited elsewhere updates on screen when the sync lands, even if you have it open. If a synced change arrives in the middle of your own edit of the same note, your version wins the file and the other version is preserved in the workspace trash, so a conflict costs a visit to the trash, never a lost edit. When the service itself makes a conflict copy (its own duplicate-file behavior), that copy shows up as just another note, easy to diff and merge by hand.

## Setup two: git

A workspace folder can be a git repository; an attached project workspace usually already is. For a notes-only repo: create a folder, `git init` in it, attach it. Worth a `.gitignore` line: `.ledge-trash/` (your deletions do not need to be everyone's history; do commit `.ledge-assets/`, the images belong to the notes).

Then let the workspace sync itself, with a note in it:

````
# Sync

```sh
git add -A && git commit -m "notes $(date +%F)" || true
git pull --rebase && git push
```
````

Because a note in an attached workspace runs its shells in the folder itself, that block commits and pushes the very workspace it lives in, one ⌘↩ ([[Running Code]]). Run it when it matters, or from cron via the CLI if you want it automatic.

Git buys what git always buys: history for every note, diffs, branches, and hosting anywhere. The plain-markdown format means the diffs are actually readable.

## Which to pick

A synced drive is zero-ceremony and continuous; git is deliberate and has history. They compose too: a synced drive for the always-on workspaces, a git repo for the ones that deserve a log. Either way, the mtimes-and-files contract is the whole interface, which is exactly why any tool that syncs files can sync your notes.
