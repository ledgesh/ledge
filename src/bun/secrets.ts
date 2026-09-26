// Where a server's password lives on this machine, and how ssh gets it out
// (remote.md §4).
//
// Everything here goes through the platform's command-line keychain client
// rather than through a library. On a Mac that is `/usr/bin/security`, and
// the item's ACL then names that binary and not Ledge. Re-signing the app
// therefore cannot lock it out of its own secrets, the failure locking.md §3
// warns about for items created with `SecItemAdd`. On Linux it is
// `secret-tool`, libsecret's client for the desktop's keyring (GNOME Keyring,
// KWallet): a keyring speaks D-Bus, and this process has no binding for it.
// On Windows it is Credential Manager, written through advapi32
// (bun/wincred.ts), since Windows ships no client that reads an item back. The
// cost everywhere is that any process running as this user reads the item,
// the same reach the mode 600 key file `keyPath` already names.
//
// The plaintext does not pass through this process on the way to ssh. The
// helper script below reads the keychain itself under `SSH_ASKPASS`, and its
// stdout goes straight to ssh. `storePassword` and `swapPassword` are the two
// calls here that read a password back.
import { existsSync } from "node:fs";
import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLIENT_HOME, ensureClientHome } from "./clientHome";
import { askpassJs, deleteCredential, writeCredential } from "./wincred";

const WINDOWS = process.platform === "win32";

// Fixed, not PATH-resolved, for the reason connections.ts fixes ssh's tools:
// these are spawned without a shell. `security` is part of macOS, and xxd, the
// hex decoder the helper runs, has shipped with macOS as long as vim has.
export const SECURITY_PATH = "/usr/bin/security";
export const XXD_PATH = "/usr/bin/xxd";

// libsecret's client. Distributions package it apart from the library
// (libsecret-tools on Debian and Ubuntu, libsecret on Fedora), so a desktop
// can have a keyring and no way for a script to reach it. `storePassword`
// says so when the binary is missing, rather than failing as a refusal.
export const SECRET_TOOL_PATH = "/usr/bin/secret-tool";

/** The keychain service every stored server password is filed under. One
 * service, one item per connection id, so `security delete-generic-password`
 * takes exactly the same two arguments as the write. On Linux the same two
 * strings are the item's `service` and `account` attributes. */
export const KEYCHAIN_SERVICE = "sh.ledge.app.server";

/** The helper ssh runs when it wants a password, written into the client home
 * before a password connection is dialled (`ensureAskpass`). On Windows it is a
 * .cmd that runs askpass.js with this app's bun.exe. */
export const ASKPASS_PATH = join(CLIENT_HOME, WINDOWS ? "askpass.cmd" : "askpass.sh");
export const ASKPASS_JS_PATH = join(CLIENT_HOME, "askpass.js");

/** The Credential Manager target a connection's password is filed under: the
 * keychain service, a slash, the connection id. */
export const CREDENTIAL_PREFIX = `${KEYCHAIN_SERVICE}/`;

/** Tells the helper which connection is being dialled. The value is a
 * connection id and not a secret, so it is safe in the environment of the ssh
 * process it is passed to. */
export const ASKPASS_ACCOUNT_ENV = "LEDGE_ASKPASS_ACCOUNT";

// --- pure core (unit-tested in secrets.test.ts) ------------------------------

/**
 * A password as the hex of its UTF-8 bytes, which is the form the Mac stores.
 *
 * Not obfuscation: hex makes one decoding rule right for every password.
 * `security find-generic-password -w` prints a value as text when its bytes
 * are printable ASCII and as hex when they are not, with nothing in the output
 * saying which happened, so the password "ä" and the password "c3a4" both come
 * back as `c3a4`. Storing hex keeps the read always hex, and always decoded.
 * `secret-tool lookup` prints the bytes it was given, so Linux stores the
 * password itself.
 */
export function toHex(text: string): string {
  return Array.from(new TextEncoder().encode(text))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The inverse of `toHex`. `readPassword` decodes with it, and the round-trip
 * test in secrets.test.ts holds the pair. The helper script decodes with
 * `xxd -r -p` instead. */
export function fromHex(hex: string): string {
  const bytes = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

/**
 * The `SSH_ASKPASS` helper, as text, for `platform` (this one by default).
 *
 * ssh runs the script with the prompt as its argument and reads the first line
 * of its stdout as the password. The script ignores the prompt: a password is
 * the only thing this connection is asked for, and parsing the English would
 * break at an OpenSSH wording change. The script reads the keychain itself, so
 * the secret never sits in Bun's memory or on a pipe (remote.md §4). A missing
 * item exits non-zero and prints nothing, which ssh reports as a failed
 * authentication rather than sending an empty password.
 *
 * The Mac script decodes the stored hex. The Linux one execs `secret-tool
 * lookup`, which prints the stored bytes with no newline after them and exits
 * 1 with nothing printed when there is no item.
 */
export function askpassScript(platform: string = process.platform): string {
  const head = `#!/bin/sh
# Ledge's SSH_ASKPASS helper. Generated by src/bun/secrets.ts; edits are lost
# at the next launch. What it is for: docs/contributor/remote.md §4.
set -u
[ -n "\${${ASKPASS_ACCOUNT_ENV}:-}" ] || exit 1
`;
  if (platform !== "darwin") {
    return `${head}exec ${SECRET_TOOL_PATH} lookup service ${KEYCHAIN_SERVICE} account "\$${ASKPASS_ACCOUNT_ENV}"
`;
  }
  return `${head}hex=$(${SECURITY_PATH} find-generic-password -s ${KEYCHAIN_SERVICE} -a "\$${ASKPASS_ACCOUNT_ENV}" -w 2>/dev/null) || exit 1
[ -n "\$hex" ] || exit 1
printf '%s' "\$hex" | ${XXD_PATH} -r -p
`;
}

/**
 * The Windows helper ssh runs: one line of cmd that runs askpass.js
 * (wincred.ts `askpassJs`) with `bun`. The prompt ssh passes is ignored, as on
 * the other platforms. cmd expands `%` even inside quotes, so it is doubled.
 */
export function askpassCmd(bun: string, js: string): string {
  const q = (path: string) => `"${path.replaceAll("%", "%%")}"`;
  return `@${q(bun)} ${q(js)}\r\n`;
}

// What Keychain Access, or Seahorse, shows for these items. The label names
// the row, and the comment tells anyone who opens it why the value is hex.
const LABEL = "Ledge server password";
const COMMENT = "Stored by Ledge for one server connection, as the hex of the password's UTF-8 bytes.";

/**
 * The whole `add-generic-password` command, as the one line `security -i`
 * reads off its stdin.
 *
 * Interactive mode is used because the prompting form of `-w` hangs whenever
 * the process has a controlling terminal (remote.md §4). `security` prompts on
 * `/dev/tty` and never reads the pipe, so the write never returns. The dialog
 * upstream stops and the prompt lands in whatever terminal launched the app,
 * which is the only visible symptom. Only a process with no controlling
 * terminal falls back to stdin: that is every `.app` launched from Finder, so
 * the prompting form worked in the shipped app and hung under `bun run start`.
 * It also passed every probe, since a probe driven over ssh has no tty either.
 * The inline value leaves no prompt to route and no secret in any argv: `ps`
 * shows `security -i` and nothing more.
 */
export function storeCommand(id: string, hex: string): string {
  // -U so an existing item is updated rather than refused.
  return `add-generic-password -U -s ${quoted(KEYCHAIN_SERVICE)} -a ${quoted(id)} -l ${quoted(LABEL)} -j ${quoted(COMMENT)} -w ${quoted(hex)}`;
}

/**
 * One value as one token of that line.
 *
 * `security`'s interactive parser takes double quotes and backslash escapes,
 * measured rather than assumed. Nothing passed in today needs the escaping.
 * The service and the label are constants here, an id is a UUID, and the value
 * is hex. The quoting lives here anyway rather than in each caller. A newline
 * is not handled: none of those four values can contain one, the command is a
 * single line, and `security` has no escape that would keep it one.
 */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// --- the keychain, and the file ----------------------------------------------

/**
 * Store one connection's password, replacing whatever was there.
 *
 * On a Mac the command goes in on stdin rather than in the argv. `security`'s
 * own usage text calls the argument form insecure, and an argv is the wrong
 * place for a secret even when the kernel keeps other users out of it (the
 * rule remote.md §10 applies to profiles). The whole command goes down the
 * pipe rather than the value alone, for the reason `storeCommand` gives. On
 * Linux `secret-tool store` reads the value from its stdin by design.
 *
 * The write is read back before this reports success. `security` exits 0 for
 * failures it merely prints, and a keychain it could not open is one. Its exit
 * code is not evidence on its own, and a password that was never written would
 * reach the user as a server rejecting a credential they can see is right.
 */
export async function storePassword(id: string, password: string): Promise<{ ok: boolean; error: string }> {
  if (keychain() === SECRET_TOOL && !existsSync(SECRET_TOOL_PATH)) return { ok: false, error: NO_SECRET_TOOL };
  try {
    if (!(await keychain().write(id, password))) return { ok: false, error: KEYCHAIN_REFUSED };
  } catch (err) {
    return { ok: false, error: `Could not reach the keychain (${reason(err)}).` };
  }
  const stored = await readPassword(id);
  if (stored !== password) return { ok: false, error: KEYCHAIN_REFUSED };
  return { ok: true, error: "" };
}

/** Whether a password is stored for this connection, without reading it. No
 * `-w`, so `security` prints the item's attributes and never its data. Asking
 * whether one exists must not be a way to obtain one. */
export async function hasPassword(id: string): Promise<boolean> {
  try {
    return await keychain().has(id);
  } catch {
    return false;
  }
}

/**
 * Drop a connection's password, if it has one.
 *
 * Silent about a missing item, because every caller is removing or re-keying a
 * connection and "there was nothing to delete" is a success for both.
 */
export async function forgetPassword(id: string): Promise<void> {
  try {
    await keychain().forget(id);
  } catch {
    // A keychain that cannot be reached costs a stale item, not the removal of
    // the connection the caller is in the middle of.
  }
}

/**
 * Replace what is stored for a connection, and hand back the way to put the
 * old value back.
 *
 * `next` is a password to store, or null to leave nothing stored. The caller
 * dials between the two. The dial is what proves a password works, so the new
 * one has to be in the keychain before ssh runs. A dial that fails needs the
 * previous state back exactly.
 *
 * This is the only place in the app that reads a stored password into memory
 * for anything but checking a write, and `restore` is the reason (remote.md
 * §4). Without the old value there is no undo, and an edit that mistyped a
 * password would destroy the working one while reporting the failure. The
 * plaintext is the user's own secret, in the user's own process, held for as
 * long as one ssh takes to fail.
 */
export async function swapPassword(
  id: string,
  next: string | null,
): Promise<{ error: string; restore: () => Promise<void> }> {
  const before = (await hasPassword(id)) ? await readPassword(id) : null;
  const restore = async (): Promise<void> => {
    if (before === null) await forgetPassword(id);
    else await storePassword(id, before);
  };
  if (next === null) {
    await forgetPassword(id);
    return { error: "", restore };
  }
  const stored = await storePassword(id, next);
  // Nothing was replaced when the write failed, so there is nothing to undo. A
  // restore that rewrote the old value would be a second write to a keychain
  // that just refused one.
  if (!stored.ok) return { error: stored.error, restore: async () => {} };
  return { error: "", restore };
}

/**
 * Write the helper into the client home and return its path.
 *
 * The caller runs this before every password dial (index.ts), so a script left
 * by an older version is replaced rather than trusted. Mode 0700 keeps it
 * executable by this user alone. The write goes through a temp file and a
 * rename, like every other write in the app home, so ssh never finds a
 * half-written script.
 */
export async function ensureAskpass(): Promise<string> {
  await ensureClientHome();
  // Windows writes the program before the .cmd that runs it. The bun.exe named
  // is this process's, whose path changes when the app is updated or moved.
  if (WINDOWS) await writeAtomically(ASKPASS_JS_PATH, askpassJs(CREDENTIAL_PREFIX, ASKPASS_ACCOUNT_ENV));
  await writeAtomically(ASKPASS_PATH, WINDOWS ? askpassCmd(process.execPath, ASKPASS_JS_PATH) : askpassScript());
  return ASKPASS_PATH;
}

async function writeAtomically(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, text, "utf8");
    await chmod(tmp, 0o700);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// --- inside -------------------------------------------------------------------

const KEYCHAIN_REFUSED = "The keychain would not store that password.";
const NO_SECRET_TOOL = "Storing a password needs secret-tool. Install libsecret-tools and try again.";

/** The only read of a stored password here. `storePassword` checks its own
 * write with it, and `swapPassword` takes the old value to restore. */
async function readPassword(id: string): Promise<string | null> {
  try {
    return await keychain().read(id);
  } catch {
    return null;
  }
}

// The four operations, in the platform's keychain client. Each throws when
// the client cannot be spawned, and the callers above turn that into their
// own answer.
interface Keychain {
  /** False when the client ran and refused. */
  write(id: string, password: string): Promise<boolean>;
  read(id: string): Promise<string | null>;
  has(id: string): Promise<boolean>;
  forget(id: string): Promise<void>;
}

function keychain(): Keychain {
  return process.platform === "darwin" ? SECURITY : WINDOWS ? CREDENTIAL_MANAGER : SECRET_TOOL;
}

const SECURITY: Keychain = {
  write: async (id, password) => {
    const write = Bun.spawn([SECURITY_PATH, "-i"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    write.stdin.write(`${storeCommand(id, toHex(password))}\n`);
    await write.stdin.end();
    return (await write.exited) === 0;
  },
  read: async (id) => {
    const p = Bun.spawn([SECURITY_PATH, "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id, "-w"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) return null;
    return fromHex(out.trim());
  },
  has: async (id) => {
    const p = Bun.spawn([SECURITY_PATH, "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await p.exited) === 0;
  },
  forget: async (id) => {
    const p = Bun.spawn([SECURITY_PATH, "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await p.exited;
  },
};

// The item's attributes, the same pair for every verb. `secret-tool` finds an
// item by attributes and nothing else, so these two are its whole identity.
const ATTRS = ["service", KEYCHAIN_SERVICE, "account"];

// `secret-tool` has no verb that says whether an item exists without printing
// it, so `has` is a lookup with its stdout dropped. The secret reaches a pipe
// this process never reads, which is what `security`'s attribute-only query
// avoids on the Mac; a keyring's D-Bus API has no cheaper answer either.
const SECRET_TOOL: Keychain = {
  write: async (id, password) => {
    const p = Bun.spawn([SECRET_TOOL_PATH, "store", `--label=${LABEL}`, ...ATTRS, id], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    p.stdin.write(password);
    await p.stdin.end();
    return (await p.exited) === 0;
  },
  read: async (id) => {
    const p = Bun.spawn([SECRET_TOOL_PATH, "lookup", ...ATTRS, id], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) return null;
    return out;
  },
  has: async (id) => {
    const p = Bun.spawn([SECRET_TOOL_PATH, "lookup", ...ATTRS, id], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  },
  forget: async (id) => {
    const p = Bun.spawn([SECRET_TOOL_PATH, "clear", ...ATTRS, id], { stdout: "ignore", stderr: "ignore" });
    await p.exited;
  },
};

// Reads go through askpass.js, the program ssh runs, so there is one reader of
// the stored form and not two. `has` is a read with the secret dropped, as it
// is for `secret-tool`.
const CREDENTIAL_MANAGER: Keychain = {
  write: async (id, password) => writeCredential(CREDENTIAL_PREFIX + id, id, "Stored by Ledge for one server connection.", password),
  read: async (id) => {
    await ensureAskpass();
    const p = Bun.spawn([process.execPath, ASKPASS_JS_PATH], {
      env: { ...process.env, [ASKPASS_ACCOUNT_ENV]: id },
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) return null;
    return out;
  },
  has: async (id) => (await CREDENTIAL_MANAGER.read(id)) !== null,
  forget: async (id) => deleteCredential(CREDENTIAL_PREFIX + id),
};

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
