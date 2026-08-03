// What the client in front of the user can do, and what the machine holding
// the notes can — two different questions, and the view needs both.
//
// Everything else in the app is a fact about the notes and belongs to the
// server. These two are not. Whether commands run is a decision the SHELL
// makes about itself (ios.md §8 cuts running from v1 on a phone, for its
// interaction surface rather than because it cannot work), and whether a
// folder can be picked is a fact about the machine at the other end (a
// headless server has no dialog to open, which is true of a VPS reached from a
// Mac exactly as it is of one reached from a phone).
//
// Both exist so that a verb which cannot work is ABSENT rather than present
// and failing (ios.md §8, interactions.md §4). A palette full of entries that
// answer with an error strip teaches the user that the palette lies.
//
// A configureX seam like the others (architecture.md, "State ownership"): the
// entry point sets it before bootView, the registry's `when` predicates and the
// chrome read it, and nothing writes it again. The defaults are the desktop
// app's, so a shell that says nothing keeps every verb — the failure mode of a
// forgotten call is a phone with a terminal button, not a Mac without one.

interface Shell {
  /** Whether this client offers to run blocks and open terminals. */
  runsCommands: boolean;
  /** This client's own `authorized_keys` line, or "" where it has no key of
   * its own to install. */
  deviceKey: string;
  /** Whether focusing text puts a keyboard on screen, over the page. */
  softKeyboard: boolean;
}

let shell: Shell = { runsCommands: true, deviceKey: "", softKeyboard: false };

export function configureShell(next: Partial<Shell>): void {
  shell = { ...shell, ...next };
}

/** Whether the run verbs, the terminal, and everything that only matters when
 * a command can run (the host picker, profiles) belong on this client. */
export function runsCommands(): boolean {
  return shell.runsCommands;
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
 * The one place it decides anything is the read-only (documentation) editor,
 * which stays focusable on a Mac on purpose — find, ⌘C and ⌘↩ on the manual's
 * own runnable blocks all need it (editor/setup.ts). On a phone none of those
 * three exist and the focus summons a keyboard over a page nothing can type
 * into, so there the same editor is not editable at all.
 */
export function softKeyboard(): boolean {
  return shell.softKeyboard;
}

// The server's half. Not part of `Shell` above because it arrives from a
// different place at a different time: the shell knows its own answer at boot,
// and this one comes back with `workspaceList` on the first round trip, which
// is also why it defaults to true — the window between the two is one paint
// long, and a verb that flickers in is better than one that flickers out.
let folderDialog = true;

/** Record whether the server can open a native folder picker. From
 * `workspaceList`, at boot. */
export function recordFolderDialog(can: boolean): void {
  folderDialog = can;
}

/** Whether the machine holding the notes can ask a person to choose a folder.
 * False on any headless server: `bun/server.ts` answers workspaceAttach and
 * workspaceMove with "attaching a folder needs the app running on the machine
 * that holds the notes", and this is how the verb stops being offered first. */
export function canPickFolder(): boolean {
  return folderDialog;
}
