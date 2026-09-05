// Seed text for a note with no file yet (workspace/tree.ts `seed`).
//
// The very first tab shows the welcome note: a fresh start with nothing to
// open (workspace/store.tsx initialState), which is what a first launch on a
// Mac, and a first connection to a server with no notes yet, both are. It is
// the one place a new user can press Run, because the manual's own blocks
// are marked `norun` (interactions.md §4e): a manual page's shell could be on
// either machine, while this note's shell is the same one every other note
// in the workspace gets. So its examples are the manual's, live. Every other
// new tab opens as a near-empty scratch note. A tab whose note is already on
// disk ignores these and loads the file instead.
//
// The welcome note is unsaved like any other new note, so a first launch you
// do not type in still leaves the folder empty. Built from lines so the ```
// fences do not collide with JS backticks. docs/user/ mechanics apply
// (writing.md: one line per paragraph, no em dashes), and every fence is in a
// runnable language with no `norun` (seeds.test.ts holds it there): the point
// of the note is that it runs.
export const WELCOME_TITLE = "Welcome to Ledge";

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

// Just the H1: the rename UI and the note's identity, nothing else. A new
// note is the user's blank page, with no sample block to delete first.
export const SCRATCH_DOC = ["# Untitled", "", ""].join("\n");

export function seedDoc(seed: "demo" | "scratch"): string {
  return seed === "demo" ? WELCOME_DOC : SCRATCH_DOC;
}
