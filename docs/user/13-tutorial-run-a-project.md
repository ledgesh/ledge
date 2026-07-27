# Tutorial: Run a Project from a Note

Turn a project folder into a workspace with one note that builds, tests, and runs the project.

This uses [[Notes and Workspaces]], [[Running Code]], and [[Frontmatter and Environments]].

## 1. Attach the project

Run "Attach Folder as Workspace…" from the command palette (⇧⌘P) and pick your project's folder. Two things happen:

- Every `.md` file already in the project, such as the README and the docs folder, becomes a note.
- Every note's shells start in the project folder, with no frontmatter needed.

Vendor and build directories such as `node_modules` are ignored. If the listing still shows Markdown you do not want as notes, add a `.ledgeignore` file in the folder root with one gitignore-style pattern per line.

## 2. Write a playbook note

Create a note with ⇧⌘N and give it the commands you actually run, as fenced blocks:

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

## 3. Give it an environment

If the project keeps configuration in a dotenv file, add one frontmatter line with ⌥⌘,:

```
---
envFile: .env
---
```

For real secrets, use `profile: myproject` instead. The values live in a file outside the notes, so the project folder and anything syncing it never carry credentials. See [[Profiles and Secrets]].

## Where to go next

Each of these is one line of frontmatter or one new block away:

- A deploy note with `host: deploy@prod` runs its blocks on the server instead of your machine ([[Remote Hosts]]).
- A `prompt` fence such as "Read the test output above and suggest a fix" puts an agent in the loop ([[Agents and Ledge]]).
- Wikilinks tie the playbook to design and incident notes, and backlinks (⌥⌘L) tie them back ([[Finding Things]]).

The habit worth building: when you catch yourself typing the same commands twice, put them in the note where their context lives and run them from there.
