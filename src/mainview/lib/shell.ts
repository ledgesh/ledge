// What the client in front of the user can do, and what the machine holding
// the notes can do. Two different questions, and the view needs both.
// Everything else in the app is a fact about the notes and belongs to the
// server. These are not.
//
// Whether a note's blocks run here is the shell's answer about itself. A phone
// has no terminal drawer, and v1 cut inline runs as well until the surfaces
// they need had a touch column (ios.md §8). Whether a folder can be picked is
// a fact about the machine at the other end. A headless server has no dialog
// to open, which is true of a VPS reached from a Mac exactly as it is of one
// reached from a phone.
//
// Four of the flags here withhold a verb that cannot work on this client, so
// it is absent rather than present and failing: `runsBlocks`, `hasTerminal`,
// `canPickFolder` and `canInstallCli` (interactions.md §8). `softKeyboard`
// changes an editor rather than a verb, and `deviceKey` says which key
// authenticates (ios.md §8).
//
// A configureX seam like the others (architecture.md §5). The entry point sets
// it before bootView, the registry's `when` predicates and the chrome read it,
// and nothing writes it again. The defaults are the desktop app's, so a shell
// that says nothing keeps every verb. A forgotten call gives a phone with a
// terminal button, not a Mac without one.

interface Shell {
  /** Whether this client offers to run a note's blocks. */
  runsBlocks: boolean;
  /** Whether this client has a terminal drawer. */
  hasTerminal: boolean;
  /** This client's own `authorized_keys` line, or "" where it has no key of
   * its own to install. */
  deviceKey: string;
  /** Hand a string to the device's own share sheet, or null on a client with
   * no such sheet to open. */
  shareSheet: ((text: string) => void) | null;
  /** Whether focusing text puts a keyboard on screen, over the page. */
  softKeyboard: boolean;
  /** Whether this client can open a second window. */
  multiWindow: boolean;
}

let shell: Shell = {
  runsBlocks: true,
  hasTerminal: true,
  deviceKey: "",
  shareSheet: null,
  softKeyboard: false,
  multiWindow: true,
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
 * separate surfaces, and a phone has the first without the second (ios.md §8).
 * An inline run is a panel under the fence. A drawer is a second arrangement, a
 * second focus domain, and a keyboard grammar (Ctrl-`, Escape) a phone has no
 * way to type.
 */
export function runsBlocks(): boolean {
  return shell.runsBlocks;
}

/**
 * Whether this client has a terminal drawer: the chrome's button, the toggle
 * and close verbs, and "Run Block in Terminal". That last verb needs both
 * answers, because it takes a block out of the note and puts it in the drawer.
 */
export function hasTerminal(): boolean {
  return shell.hasTerminal;
}

/** Whether a note on this client can have a shell of its own at all. Either
 * surface spawns one, and Restart Note Shell is the verb that kills it. */
export function spawnsSessions(): boolean {
  return shell.runsBlocks || shell.hasTerminal;
}

/**
 * The whole `authorized_keys` line this client asks a server to trust, or ""
 * where the question does not arise (remote.md §8, §4).
 *
 * Both clients add, edit and remove servers, and what differs is which key
 * authenticates. A Mac offers a key file, so its form asks for a path and its
 * user installs whichever public key they already have. A phone has exactly
 * one key, minted in the Secure Enclave, and it never leaves there, so there
 * is no file for a path to name (ios.md §4). Its form asks for no path and
 * shows this line instead. Installing the line on the new server is the step
 * before a new connection can work.
 *
 * One string rather than a pair of booleans, because "which key" is the whole
 * of the difference. A client with a key of its own is the client whose form
 * shows it.
 */
export function deviceKeyLine(): string {
  return shell.deviceKey;
}

/**
 * The device's share sheet, or null where there is none (ios.md §4).
 *
 * It exists for one string: the device key line above. A Mac copies that line
 * between two windows on one screen. A phone's clipboard ends at the phone,
 * and the server is another machine. The sheet is how a phone hands a string
 * to another machine, by AirDrop, a message or a note to self. The alternative
 * it replaces is retyping base64.
 *
 * A callback rather than a boolean, because the only client with a sheet
 * reaches it across the bridge and nothing else in the view can (ios.tsx). A
 * client that says nothing has none, so the button is absent on a Mac rather
 * than present and failing (interactions.md §8).
 */
export function shareSheet(): ((text: string) => void) | null {
  return shell.shareSheet;
}

/**
 * Whether this client's keyboard is on screen, and so costs half the page
 * whenever anything takes focus.
 *
 * It decides two things. The read-only documentation editor stays focusable on
 * a Mac, where find, ⌘C and ⌘↩ on the manual's own runnable blocks all need the
 * focus (editor/setup.ts). A phone has none of those three chords, and the
 * focus raises a keyboard over a page that drops every edit, so there the same
 * editor is not editable at all.
 *
 * The overlay's mode chips also drop the sigil they name
 * (commands/Overlay.tsx). Punctuation is not one keystroke on a soft keyboard.
 * Both sigils are two plane switches deep on an iPhone, so a printed
 * accelerator would be advice a phone cannot take.
 */
export function softKeyboard(): boolean {
  return shell.softKeyboard;
}

/**
 * Whether New Window has anything to open (remote.md §8a).
 *
 * A window on the Mac is a client, with its own connection, its own client id
 * and its own row in presence. The verb exists because two machines at once
 * means two windows. A phone shows one app and has one window, so there the
 * verb is absent rather than present and silent.
 *
 * Asked rather than probed. `windowNew` answers false on a shell with no second
 * window to give, but a `when` predicate cannot await, and calling it would
 * mean opening a window to learn whether one can be opened.
 */
export function multiWindow(): boolean {
  return shell.multiWindow;
}

// The server's half. Not part of `Shell` above because it arrives from a
// different place at a different time: the shell knows its own answers at boot,
// and these come back with `workspaceList` on the first round trip. They
// default to true, so the desktop's verbs are present during the one paint
// before `workspaceList` answers.
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

/** Record what the machine holding the notes can do, from `workspaceList` at
 * boot. Copied field by field, so a response carrying more than these two
 * leaves no extras here. */
export function recordServerCaps(caps: ServerCaps): void {
  server = { folderDialog: caps.folderDialog, cliShim: caps.cliShim };
}

/** Whether the machine holding the notes can ask a person to choose a folder.
 * False on any headless server, where `bun/server.ts` answers workspaceAttach
 * and workspaceMove with "attaching a folder needs the app running on the
 * machine that holds the notes". This flag hides the verb, so nobody reaches
 * that refusal. */
export function canPickFolder(): boolean {
  return server.folderDialog;
}

/**
 * Whether the machine holding the notes can put `ledge` on its own PATH.
 *
 * The server's answer and not this client's, because the install writes a file
 * over there and the CLI it points at reads the notes over there
 * (interactions.md §8). A `ledge` installed on the Mac in front of the user
 * reads that Mac's notes, not the notes on screen. False on a server, where a
 * compiled `ledge-server` has no CLI beside it to exec (bun/cliShim.ts).
 */
export function canInstallCli(): boolean {
  return server.cliShim;
}
