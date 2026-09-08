# Tutorial: Share Notes with a Git Clone

Put a workspace in a git repository and keep a clone each, so you and the people you work with read and write the same notes.

This uses [[Notes and Workspaces]], [[Running Code]], and the git setup in [[Tutorial: Keep Notes Synced]].

You publish the workspace in steps 1 to 4. Everyone else clones it in step 5, and from step 6 on every side does the same things.

## 1. Put the workspace where git can reach it

An attached workspace is already a folder you chose, and a project workspace is usually a repository already. Either one is ready, so skip to step 2.

A managed workspace lives inside `~/.ledge`, the app's own home. Run "Move Workspace Folder…" from the command palette or the workspace's row menu, and pick a parent folder such as `~/Projects`.

Reopen the tabs you were working in. They close during the move.

## 2. Look at what you are about to publish

Everything in the folder reaches whoever clones it. Walk the workspace once before the first commit:

- **Locked notes** travel as ciphertext and stay shut, so they cost nothing to publish ([[Note Locking]]).
- **Profiles** are outside the folder already, so no credential in one can reach the repository ([[Profiles and Secrets]]).
- **`env:` lines** sit in a note's frontmatter in the open and publish as written. A value that should not travel belongs in a profile ([[Frontmatter and Environments]]).
- **The trash** stays out of git on its own. Ledge puts a `.gitignore` inside `.ledge-trash/` that covers the whole folder.

## 3. Make the repository

In the workspace folder:

```sh norun
git init
git add -A
git commit -m "notes"
```

A note in an attached workspace runs its blocks in the folder itself, so keep those lines in a note in the workspace ([[Running Code]]).

A workspace Ledge created arrives with a `.gitignore` for `.DS_Store` and the temp file a save leaves behind. A folder you made yourself has neither line, so add them:

```
.*.md.tmp-*
.DS_Store
```

## 4. Push it somewhere everyone reaches

Make an empty repository on GitHub, a self-hosted forge, or any machine everyone has ssh to:

```sh norun
git remote add origin git@github.com:you/notes.git
git push -u origin main
```

Make it private unless the notes are meant to be public. Whoever can read the repository can read the notes.

## 5. Clone it everywhere else

Everyone else clones the repository to a folder of their own:

```sh norun
git clone git@github.com:you/notes.git ~/Projects/notes
```

Then "Attach Folder as Workspace…" in their own Ledge, pointed at the clone.

It becomes an ordinary attached workspace, with its own row in the strip and its own number in ⌘1 through ⌘9. The notes, the images, and the folders you filed them in are all there.

## 6. Exchange changes

Each side pushes what it wrote and pulls what the others did:

```sh norun
git pull --rebase
git add -A
git commit -m "notes"
git push
```

Keep those four lines in a note in the workspace and the exchange is one ⌘↩.

Ledge follows the folder while you work. Notes appear, change, and disappear in the sidebar as a pull lands, with nothing to refresh and nothing to close first.

## 7. Settle a note two people changed

Notes are separate files, so work on different notes merges cleanly and never reaches this step.

One note changed in two clones is a git conflict like any other. The pull leaves the conflict markers in the file and Ledge shows them in the note. Edit them out, save, then commit.

A pull that arrives while you have that note open and edited is settled by Ledge first. Your version keeps the file, and the incoming one goes to the workspace trash with a notice in the sidebar naming it. Restoring it from the trash puts that copy beside the live note, so you can merge the two yourself.

## 8. Read a pull before you run it

A block runs on the machine that presses Run. Read what arrived before you run it, the way you would read a script from the same person.

Expect some of it not to fit. A note's `cwd:`, `host:`, and `profile:` lines name paths, machines, and credentials on the setup it was written for, so a block that deploys from your laptop may find none of that in anyone else's clone ([[Frontmatter and Environments]]).

## Where to go next

- **Automate the exchange.** The four lines in step 6 run from cron through the CLI, so a clone keeps itself current ([[The ledge CLI]]).
- **Keep your own notes out of it.** A shared workspace is one workspace. Notes that are yours alone belong in another, and the strip switches between them ([[Notes and Workspaces]]).
- **Share a machine instead of a folder.** One live copy instead of a clone each is a server. It comes with one account shared by everyone on it ([[Keep Notes on a Remote Server]]).
- **Send a secret another way.** Profiles never enter a notes folder, so everyone keeps their own copy of the credentials a shared note names ([[Profiles and Secrets]]).
