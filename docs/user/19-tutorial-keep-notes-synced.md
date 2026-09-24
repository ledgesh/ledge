# Tutorial: Keep Notes Synced

Ledge notes are plain files in ordinary folders, so syncing them is just syncing a folder: iCloud Drive, Dropbox, git, Syncthing, or whatever you already use.

This page covers the two common setups, and how to move notes that are not in the right place yet.

## What a workspace folder holds

Everything a workspace is lives in its folder:

- The notes, as `.md` files.
- Pasted images, in `.ledge-assets/`.
- Deleted notes, in `.ledge-trash/`.
- A `.gitignore`, in a workspace Ledge created.

Sync the folder and you have synced the workspace. There is no database on the side.

Two things are not in the folder. Profiles live outside every notes folder, so syncing notes never ships credentials ([[Profiles and Secrets]]). And locked notes sync as ciphertext: a locked note is self-contained, so on another machine it unlocks with the passphrase alone ([[Note Locking]]).

Sync workspace folders, not `~/.ledge` itself. The app home holds machine-local state alongside the managed workspace folders.

## Setup one: a synced drive

1. Create a folder inside iCloud Drive, Dropbox, or any synced location.
2. Run "Attach Folder as Workspace…" and give its path, or press Choose Folder… to pick it.
3. On a second computer, attach the same folder there.

Notes you write are files in the synced folder, and the service carries them.

Ledge watches the folder and follows external changes live, so a note edited elsewhere updates on screen when the sync lands, even if you have it open.

If a synced change arrives while you are editing the same note, your version wins the file and the other version is kept in the workspace trash. Ledge names that note in a notice in the sidebar when it happens, so a conflict costs a visit to the trash rather than a lost edit. When the service makes its own conflict copy, that copy appears as another note, which you can diff and merge by hand.

## Setup two: git

A workspace folder can be a git repository, and an attached project workspace usually already is. For a notes-only repo: create a folder, run `git init` in it, and attach it.

Deleted notes stay out of git on their own. Ledge puts a `.gitignore` inside `.ledge-trash/` that covers the whole folder, so `git add -A` never reaches it. That happens the same way in a workspace Ledge created and in a repository you already had, and your own `.gitignore` is never edited.

The trash empties thirty days after a delete. Git keeps what it was given, so a trashed note that reached a commit is still in the log once Ledge has purged it.

An ignore rule does not untrack what a repository already committed. If your workspace committed its trash before, untrack it once:

```
git rm -r --cached .ledge-trash
```

That removes the trash from future commits and leaves the files on disk. The earlier commits still hold what they held; rewriting them is a `git filter-repo` job and is only worth it for something that should never have left the machine.

Images are committed. `.ledge-assets/` holds the pictures the notes reference, so it is tracked like any other content.

A workspace you create in Ledge arrives with a `.gitignore` for the rest: macOS's `.DS_Store`, and the temp file a save leaves behind if the app is killed mid-write. A folder you made yourself has no such file, so add those two lines if you want them:

```
.*.md.tmp-*
.DS_Store
```

Then let the workspace sync itself, with a note in it:

````
# Sync

```sh
git add -A && git commit -m "notes $(date +%F)" || true
git pull --rebase && git push
```
````

A note in an attached workspace runs its shells in the folder itself, so that block commits and pushes the workspace it lives in, with one ⌘↩ ([[Running Code]]). Run it when it matters, or from cron via the CLI to automate it.

You get history for every note, diffs, branches, and hosting anywhere. Plain Markdown makes the diffs readable.

A repository is also how a workspace reaches other people, with a clone each ([[Tutorial: Share Notes with a Git Clone]]).

## Move notes you already have

Both setups start with a folder in the right place. Notes in a managed workspace live inside `~/.ledge`, which a sync service will not carry, so the workspace has to move out first.

1. Close the workspace (⌫ on its row). Closing only detaches the folder; no note is touched.
2. Move the folder out of `~/.ledge` into the synced location. The folder is hidden: Finder's Go to Folder… takes the path, and so does Ctrl+L in GNOME Files.
3. Run "Attach Folder as Workspace…" and give its new path.
4. Attach the same folder on your other computer.

The whole folder travels: notes, images, and trash together, with references intact. The workspace continues at its new home as an ordinary attached folder.

## What syncing does not carry

Syncing workspace folders syncs all of your notes. It does not touch Ledge's own state in `~/.ledge`: your settings, the list of which folders are workspaces, and your window layout. Those are machine-local, since a list of folder paths means little on another computer.

So setting up a new computer is a short manual step: install Ledge, attach your synced folders, and redo any settings you care about. If your `settings.jsonc` is heavily customized, keep a copy alongside your notes.

There is nothing else to migrate. Notes are files, so there is no export and no import. Locked notes carry what they need to be decrypted, so on the new machine the passphrase alone opens them, with no vault file to move ([[Note Locking]]).

## Which setup to pick

A synced drive is continuous and needs no ceremony. Git is deliberate and gives you history.

They combine: a synced drive for the always-on workspaces, a git repo for the ones that deserve a log. Either way, files and mtimes are the whole interface, which is why any tool that syncs files can sync your notes.
