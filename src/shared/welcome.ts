// The welcome note: the server writes it as a file on a machine's first launch
// (bun/server.ts), so it is there on every launch after until it is deleted,
// and a phone's first connection to a fresh server opens it too. The view
// keeps an unsaved copy for a folder with no notes (workspace/seeds.ts).
export const WELCOME_TITLE = "Welcome to Ledge";

// The welcome note's text. Every fence is in a runnable language and carries
// no `norun`, so a new user can press Run here. In the manual every
// runnable-language fence is marked instead (interactions.md §4e). writing.md
// §10 has the reason, and the docs/user/ prose mechanics this note follows.
// workspace/seeds.test.ts checks both. Built from lines so the ``` fences do
// not collide with JS backticks.
export const WELCOME_DOC = [
  `# ${WELCOME_TITLE}`,
  "",
  "Ledge runs code and commands straight from your Markdown. This note is yours: edit it, or start a new one with ⌘N.",
  "",
  "## Run a block",
  "",
  "⌘↩ inside the block below, or the Run button on it (a tap, on a phone), runs it.",
  "",
  "```sh",
  "curl -s https://api.github.com/zen",
  "```",
  "",
  "One line of output streams into a panel beneath the block, and Dismiss puts the panel away.",
  "",
  "## The shell persists between blocks",
  "",
  "Each note keeps one shell for inline runs, so a `cd` or an exported variable carries into the next block. Run these two in order:",
  "",
  "```sh",
  "cd /tmp",
  "export FLAVOR=nautical",
  "```",
  "",
  "```sh",
  "pwd",
  'echo "this shell is feeling $FLAVOR"',
  "```",
  "",
  "⇧⌘↩ sends a block to the note's terminal drawer instead, a separate shell you can keep typing in. ⌃` opens the drawer.",
  "",
  "## Other languages",
  "",
  "`python`, `node`, `ts`, and others are runnable out of the box, each run a fresh process, and TypeScript runs on Bun, which Ledge already has:",
  "",
  "```ts",
  "const now = new Date();",
  "console.log(`hello from TypeScript, it is ${now.toLocaleTimeString()}`);",
  "```",
  "",
  "## Where to next",
  "",
  "- The first line of a note names its file, so this one is `welcome-to-ledge.md`. Delete it from the sidebar once you are done with it.",
  "- ⌘P opens a note by title, and ⌥⌘P searches every note.",
  "- The manual is behind the help button in the header, or \"Documentation\" in the command palette (⇧⌘P). Getting Started is its first page.",
  "",
].join("\n");
