// Seed text for a note with no file yet (workspace/tree.ts `seed`). The
// welcome note fills the first tab when there is nothing else to open
// (workspace/store.tsx initialState). That is a first launch on a Mac, or a
// first connection to a server with no notes. Every other new tab opens on the
// near-empty scratch note. A tab whose note is on disk loads the file.
export const WELCOME_TITLE = "Welcome to Ledge";

// The welcome note's text. Every fence is in a runnable language and carries
// no `norun`, so a new user can press Run here. In the manual every
// runnable-language fence is marked instead (interactions.md §4e). writing.md
// §10 has the reason, and the docs/user/ prose mechanics this note follows.
// seeds.test.ts checks both. Built from lines so the ``` fences do not
// collide with JS backticks. The note is unsaved like any other new note.
// Close it without typing and the folder stays empty.
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
  "`python`, `node`, `ts`, and others are runnable out of the box, each run a fresh process. TypeScript runs on Bun, which Ledge already has:",
  "",
  "```ts",
  "const now = new Date();",
  "console.log(`hello from TypeScript, it is ${now.toLocaleTimeString()}`);",
  "```",
  "",
  "## Where to next",
  "",
  "- The first line of a note names its file. Type in this one and it saves as `welcome-to-ledge.md`.",
  "- ⌘P opens a note by title, and ⌥⌘P searches every note.",
  "- The manual is behind the help button in the header, or \"Documentation\" in the command palette (⇧⌘P). Getting Started is its first page.",
  "",
].join("\n");

// The H1 and nothing else. Typing over the heading is how a note is renamed:
// the first line names the file (notes/store.ts syncTitle), and there is no
// rename command for notes. Nothing else is seeded, so a new note opens as a
// blank page with no sample block to delete first.
export const SCRATCH_DOC = ["# Untitled", "", ""].join("\n");

export function seedDoc(seed: "demo" | "scratch"): string {
  return seed === "demo" ? WELCOME_DOC : SCRATCH_DOC;
}
