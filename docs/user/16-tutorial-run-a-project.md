# Tutorial: Run a Project from a Note

Write one note that builds, tests, and runs a project, and keep it with the rest of your notes.

This uses [[Running Code]], [[Frontmatter and Environments]], and [[Notes and Workspaces]].

## 1. Write a playbook note

Create a note with ⌘N and give it the commands you actually run, as fenced blocks:

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

The project's routine is now documentation and buttons at once. ⌘↩ runs a block inline, with the output next to the prose. ⇧⌘↩ sends it to the terminal drawer when you want to keep interacting.

The inline shell persists, so an exported variable or an activated virtualenv from the Setup block is still there when the Test block runs.

## 2. Point it at the project

So far those blocks run from your home folder, the default for notes in a managed workspace. One frontmatter line, added with ⌥⌘,, starts them in the project instead:

```
---
cwd: ~/Projects/my-app
---
```

`cwd` sets the working directory for every shell the note spawns, the inline one and the terminal drawer both. The note itself stays where it is, in your notes workspace or a synced folder. Only the shells move.

## 3. Give it an environment

If the project keeps configuration in a dotenv file, add a second line:

```
---
cwd: ~/Projects/my-app
envFile: .env
---
```

`envFile` resolves against the note's `cwd`, so this picks up the project's own `.env`. For real secrets, use `profile: myproject` instead. The values live in a file outside the notes, so your notes folder and anything syncing it never carry credentials. See [[Profiles and Secrets]].

## When the project should be the workspace

A project that deserves many notes rather than one can become a workspace itself. Run "Attach Folder as Workspace…" from the command palette (⇧⌘P) and pick the project's folder. Every `.md` file already in it, such as the README and the docs folder, becomes a note, and every note's shells start in the project folder with no `cwd` needed.

Vendor and build directories such as `node_modules` are ignored. If the listing still shows Markdown you do not want as notes, add a `.ledgeignore` file in the folder root with one gitignore-style pattern per line. See [[Notes and Workspaces]].

## Where to go next

Each of these is one line of frontmatter or one new block away:

- A deploy note with `host: deploy@prod` runs its blocks on the server instead of your machine ([[Run Code on Remote Hosts]]).
- A `prompt` fence such as "Read the test output above and suggest a fix" puts an agent in the loop ([[Agents and Ledge]]).
- Wikilinks tie the playbook to design and incident notes, and backlinks (⌥⌘L) tie them back ([[Finding Things]]).

The habit worth building: when you catch yourself typing the same commands twice, put them in the note where their context lives and run them from there.
