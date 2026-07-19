# Tutorial: Keep Notes Synced

Ledge notes are plain files in ordinary folders, so syncing or backing them up is just syncing a folder: iCloud Drive, Dropbox, git, Syncthing, whatever you already trust. This tutorial covers the two common setups and the few facts worth knowing first.

## What a workspace folder holds

Everything a workspace is lives in its folder: the notes as `.md` files, pasted images in `.ledge-assets/`, and deleted notes resting in `.ledge-trash/` (see [[Notes and Workspaces]]). Sync the folder and you have synced the workspace; there is no database on the side.

What is deliberately not in there: profiles. Secrets live outside every notes folder precisely so that syncing notes never ships credentials ([[Profiles and Secrets]]). And locked notes sync as ciphertext: a locked note is self-contained, so on another machine it unlocks with the passphrase alone ([[Note Locking]]).

Sync workspace folders, not `~/.ledge` itself: the app home holds machine-local state alongside the managed workspace folders, and the last two sections below cover what that means for notes already living there.

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

## Moving notes you already have

Both setups above start with a folder in the right place. If your notes are in a managed workspace (one Ledge created for you, living inside `~/.ledge`), they are not in the right place yet: a sync service only carries its own directory, so the workspace has to move out first.

Run "Move Workspace Folder…" from the command palette (or from the workspace's own row menu in the sidebar) and pick the destination's parent folder: your iCloud Drive folder, say. The whole folder relocates, notes, images, and trash together, references intact, and the workspace carries on at its new home as an ordinary attached folder. Its open tabs close on the way, so reopen what you were working on. Attach the same folder on your other Mac and you are done.

One limit worth knowing: the move is a rename, so it cannot cross to a different volume. If you pick a destination on another disk, Ledge says so instead of copying; move the folder in Finder yourself, then run "Attach Folder as Workspace…" to pick it up again.

## What syncing does not carry

Syncing workspace folders syncs your notes, all of them, completely. What it does not touch is Ledge's own state in `~/.ledge`: your settings, the list of which folders are workspaces, and your window layout. Those are machine-local by design (a list of folder paths means little on another Mac), but it does mean "I sync my notes" is not the same as "I can restore Ledge".

Setting up on a new Mac is therefore a short manual step rather than an automatic one: install Ledge, attach your synced folders, and redo any settings you care about. If your `settings.jsonc` is heavily customized, keeping a copy alongside your notes is a reasonable habit.

The good news is what needs no ceremony at all. Notes are files, so there is no export, no import, and nothing to migrate. And locked notes travel fine: each one carries what it needs to be decrypted, so on the new machine the passphrase alone opens them, no vault file to move ([[Note Locking]]).

## Which to pick

A synced drive is zero-ceremony and continuous; git is deliberate and has history. They compose too: a synced drive for the always-on workspaces, a git repo for the ones that deserve a log. Either way, the mtimes-and-files contract is the whole interface, which is exactly why any tool that syncs files can sync your notes.
