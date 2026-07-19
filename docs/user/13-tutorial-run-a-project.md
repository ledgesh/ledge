# Tutorial: Run a Project from a Note

This tutorial turns a real project folder into a workspace with one living note that builds, tests, and runs the project. It pulls together [[Notes and Workspaces]], [[Running Code]], and [[Frontmatter and Environments]] into one workflow.

## Attach the project

Run "Attach Folder as Workspace…" from the command palette (⇧⌘P) and pick your project's folder. Two things happen at once: every `.md` file already in the project (the README, the docs folder) becomes a note, and every note's shells now start in the project folder by default, no frontmatter needed.

Vendor and build directories (`node_modules` and friends) are ignored automatically. If the listing still shows markdown you do not want as notes, drop a `.ledgeignore` file in the folder root with one pattern per line, gitignore-style.

## Make a playbook note

Create a note (⇧⌘N) in the new workspace and give it the commands you actually run, as fenced blocks:

````
# Playbook

## Setup
```sh
npm install
```

## Test
```sh
npx vitest run
```
````

Now the project's routine is documentation and buttons at the same time: ⌘↩ runs a block inline where you can read the output next to the prose, ⇧⌘↩ sends it to the terminal drawer when you want to keep interacting. Because the inline shell is persistent, an exported variable or an activated virtualenv in the Setup block is still there when the Test block runs.

## Give it an environment

If the project keeps configuration in a dotenv file, one frontmatter line (⌥⌘,) folds it into every shell the note spawns:

```
---
envFile: .env
---
```

Real secrets go one step further: `profile: myproject` keeps them in a file outside the notes entirely, so the project folder (and anything syncing it) never carries credentials. See [[Profiles and Secrets]].

## Grow into it

Some directions this scales, each one line of frontmatter or one new block away:

- A deploy note with `host: deploy@prod` runs its blocks on the server instead of your machine ([[Remote Hosts]]).
- A `prompt` fence like "Read the test output above and suggest a fix" puts an agent inside the loop ([[Agents and Ledge]]).
- Wikilinks tie the playbook to design notes and incident notes, and backlinks (⌥⌘L) tie them back ([[Finding Things]]).

The habit this tutorial is really about: when you catch yourself typing the same commands in a terminal twice, put them in the note where their context lives, and run them from there.
