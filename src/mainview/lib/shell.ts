// What the client in front of the user can do, and what the machine holding
// the notes can — two different questions, and the view needs both.
//
// Everything else in the app is a fact about the notes and belongs to the
// server. These are not. Whether a note's blocks run HERE is a decision the
// SHELL makes about itself (ios.md §8: a phone has no terminal drawer, and cut
// inline runs as well until the surfaces they need had a touch column), and
// whether a folder can be picked is a fact about the machine at the other end
// (a headless server has no dialog to open, which is true of a VPS reached from
// a Mac exactly as it is of one reached from a phone).
//
// All of them exist so that a verb which cannot work is ABSENT rather than
// present and failing (ios.md §8, interactions.md §4). A palette full of
// entries that answer with an error strip teaches the user that the palette
// lies.
//
// A configureX seam like the others (architecture.md, "State ownership"): the
// entry point sets it before bootView, the registry's `when` predicates and the
// chrome read it, and nothing writes it again. The defaults are the desktop
// app's, so a shell that says nothing keeps every verb — the failure mode of a
// forgotten call is a phone with a terminal button, not a Mac without one.

interface Shell {
  /** Whether this client offers to run a note's blocks. */
  runsBlocks: boolean;
  /** Whether this client has a terminal drawer. */
  hasTerminal: boolean;
  /** This client's own `authorized_keys` line, or "" where it has no key of
   * its own to install. */
  deviceKey: string;
  /** Whether focusing text puts a keyboard on screen, over the page. */
  softKeyboard: boolean;
}

let shell: Shell = {
  runsBlocks: true,
  hasTerminal: true,
  deviceKey: "",
  softKeyboard: false,
};

export function configureShell(next: Partial<Shell>): void {
  shell = { ...shell, ...next };
}

/**
 * Whether a block in a note can be run from this client: the inline run verb
 * and its chord, the ▶ on every runnable fence, and the profile editor, which
 * is the environment a block runs in and has nothing to edit for otherwise.
 *
 * Separate from `hasTerminal` because running a block and having a drawer are
 * separate surfaces, and a phone has the first without the second (ios.md §8):
 * an inline run is a panel under the fence, while a drawer is a second
 * arrangement, a second focus domain, and a keyboard grammar (Ctrl-`, Escape) a
 * phone has no way to type. One boolean could not say that; two can.
 */
export function runsBlocks(): boolean {
  return shell.runsBlocks;
}

/**
 * Whether this client has a terminal drawer: the chrome's button, the toggle
 * and close verbs, and "Run Block in Terminal", which is the one verb that
 * needs both answers because it takes a block out of the note and puts it in
 * the drawer.
 */
export function hasTerminal(): boolean {
  return shell.hasTerminal;
}

/** Whether a note on this client can have a shell of its own at all — either
 * surface spawns one, and Restart Note Shell is the verb that kills it. */
export function spawnsSessions(): boolean {
  return shell.runsBlocks || shell.hasTerminal;
}

/**
 * The line this client asks a server to trust, whole, or "" where the question
 * does not arise (remote.md §8, §4).
 *
 * Both clients add, edit and remove servers; what differs is which key
 * authenticates. A Mac offers a key FILE, so its form asks for a path and its
 * user installs whichever public key they already have. A phone has exactly one
 * key, minted in the Secure Enclave, which cannot be read out of it and
 * therefore has no path (ios.md §4) — so its form asks for no path and shows
 * the `authorized_keys` line instead, because installing that line on the new
 * server is the step before a new connection can work at all.
 *
 * One string rather than a pair of booleans: "which key" is the whole of the
 * difference, and a client that has one of its own is exactly the client whose
 * form should be showing it.
 */
export function deviceKeyLine(): string {
  return shell.deviceKey;
}

/**
 * Whether this client's keyboard is on screen, and therefore costs half the
 * page whenever anything takes focus.
 *
 * It decides two things. The read-only (documentation) editor stays focusable
 * on a Mac on purpose — find, ⌘C and ⌘↩ on the manual's own runnable blocks all
 * need it (editor/setup.ts). On a phone none of those three exist and the focus
 * summons a keyboard over a page nothing can type into, so there the same
 * editor is not editable at all.
 *
 * And the overlay's mode chips drop the sigil they name (commands/Overlay.tsx).
 * The same question one step along: a soft keyboard is one where punctuation is
 * not a keystroke — both of ours are two plane switches deep on an iPhone — so
 * an accelerator printed there would be advice a phone cannot take.
 */
export function softKeyboard(): boolean {
  return shell.softKeyboard;
}

// The server's half. Not part of `Shell` above because it arrives from a
// different place at a different time: the shell knows its own answers at boot,
// and these come back with `workspaceList` on the first round trip, which is
// also why they default to true — the window between the two is one paint long,
// and a verb that flickers in is better than one that flickers out.
//
// Both are the same question asked about two verbs: does the machine at the
// other end have the thing this verb needs? A headless server has neither, and
// a Mac reaches one as easily as a phone does.
interface ServerCaps {
  /** Whether that machine can open a native folder picker. */
  folderDialog: boolean;
  /** Whether that machine has a `ledge` CLI to put on its own PATH. */
  cliShim: boolean;
}

let server: ServerCaps = { folderDialog: true, cliShim: true };

/** Record what the machine holding the notes can do. From `workspaceList`, at
 * boot — field by field, so a response carrying more than these two does not
 * leave its extras here. */
export function recordServerCaps(caps: ServerCaps): void {
  server = { folderDialog: caps.folderDialog, cliShim: caps.cliShim };
}

/** Whether the machine holding the notes can ask a person to choose a folder.
 * False on any headless server: `bun/server.ts` answers workspaceAttach and
 * workspaceMove with "attaching a folder needs the app running on the machine
 * that holds the notes", and this is how the verb stops being offered first. */
export function canPickFolder(): boolean {
  return server.folderDialog;
}

/**
 * Whether the machine holding the notes can put `ledge` on its own PATH.
 *
 * The server's answer and not this client's, because the install writes a file
 * over there and the CLI it points at reads the notes over there: a `ledge`
 * installed on your Mac reads the notes your Mac holds, which are not the notes
 * on your screen. False on a server, where the shim has nothing to exec — a
 * compiled `ledge-server` is one program and the CLI is not in it
 * (bun/cliShim.ts).
 */
export function canInstallCli(): boolean {
  return server.cliShim;
}
