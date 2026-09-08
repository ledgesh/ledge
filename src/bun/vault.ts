// Key lifecycle and envelope crypto for locked notes (locking.md §2, §3).
// One app-wide passphrase: scrypt derives the master key, and each locked
// note carries a random data key wrapped by it. All the crypto is node:crypto
// AES-256-GCM, so no new package (architecture.md §8). The master key lives
// only in this process's memory, from unlock to relock. This module owns keys
// and byte shapes. notes.ts and assets.ts decide which notes are locked and
// where the seams sit. vault.ts must not import notes.ts, the way notes.ts
// imports workspaces.ts and not the reverse.
import { join } from "node:path";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { APP_HOME, ensureAppHome } from "./workspaces";

// scrypt cost, tuned for an interactive unlock (about 100ms on current
// hardware). saveVaultFile records these parameters in the vault file, but
// nothing reads them back: deriveKey always uses this constant, so raising
// the cost would stop old vaults from opening. maxmem must clear 128*N*r
// bytes or node:crypto refuses.
const KDF = { N: 1 << 17, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 512 * 1024 * 1024;

const KEY_LEN = 32; // AES-256
const NONCE_LEN = 12; // GCM standard
const TAG_LEN = 16;
const SALT_LEN = 16;

// What .vault.json's check value encrypts. Decrypting it is the passphrase
// check. A wrong passphrase derives a wrong key, and GCM authentication then
// fails. No note is touched to find out.
const CHECK_PLAINTEXT = Buffer.from("ledge-vault-check-v1", "utf8");

export const VAULT_PATH = join(APP_HOME, ".vault.json");

// Relock after 15 minutes with no note RPC traffic. Wire activity stands in
// for user activity: notes.ts calls touchVault on every read and write. The
// autosave debounce is seconds, so nothing dirty is left unflushed by the
// time this window elapses. No settings knob until the default demonstrably
// fails someone (architecture.md §6).
const IDLE_RELOCK_MS = 15 * 60 * 1000;
const IDLE_SWEEP_MS = 60 * 1000;

export type VaultState = "none" | "locked" | "unlocked";

// The in-memory vault: the derived master key while unlocked, and the salt
// that every new header copies in. The master key is never written anywhere,
// and lockVault drops it. The salt survives a relock, and the vault file
// holds a copy of it.
let masterKey: Buffer | null = null;
let vaultSalt: Buffer | null = null;
let lastActivity = 0;
let idleTimer: ReturnType<typeof setInterval> | null = null;
let onAutoLock: (() => void) | null = null;

/** Register what auto-relock does beyond dropping the master key (server.ts
 * passes a callback that pushes vaultChanged). One callback, replaced rather
 * than stacked. */
export function configureVault(handlers: { onAutoLock: () => void }): void {
  onAutoLock = handlers.onAutoLock;
}

/** Reset the idle-relock clock. notes.ts calls this from readNote, writeNote
 * and stashNote, the funnel every note content path already passes. */
export function touchVault(): void {
  lastActivity = Date.now();
}

export function vaultState(): VaultState {
  if (masterKey) return "unlocked";
  return vaultSalt ? "locked" : "none";
}

// --- the vault file ---------------------------------------------------------
// Machine-written and Bun-shaped, like .workspaces.json: the view never sees
// its bytes (locking.md §3). Losing it costs a re-derive, never a note, since
// every locked note carries its own salt. All it adds is a passphrase check
// that touches no note. A corrupt file is renamed aside for forensics (as
// workspaces.ts does) and rebuilt from the next successful unlock.

interface VaultFile {
  version: 1;
  kdf: { algo: "scrypt"; N: number; r: number; p: number };
  salt: string;
  check: string;
}

let tmpCounter = 0;
async function saveVaultFile(salt: Buffer, key: Buffer): Promise<void> {
  await ensureAppHome();
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(CHECK_PLAINTEXT), cipher.final(), cipher.getAuthTag()]);
  const file: VaultFile = {
    version: 1,
    kdf: { algo: "scrypt", ...KDF },
    salt: salt.toString("base64"),
    check: Buffer.concat([nonce, ct]).toString("base64"),
  };
  tmpCounter += 1;
  const tmp = join(APP_HOME, `.vault.json.tmp-${process.pid}-${tmpCounter}`);
  try {
    await writeFile(tmp, JSON.stringify(file), "utf8");
    await rename(tmp, VAULT_PATH);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Load the vault file. server.ts calls it once at boot, and unlockVault
 * re-reads VAULT_PATH itself. A missing file leaves the state "none":
 * createVault writes one, or a successful unlock probing a locked note's own
 * header rebuilds it. A corrupt file is moved aside and the run continues.
 * Neither case throws. */
export async function loadVault(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await readFile(VAULT_PATH, "utf8");
  } catch {
    return; // no vault yet
  }
  try {
    const json = JSON.parse(raw) as Partial<VaultFile>;
    const salt = Buffer.from(String(json.salt ?? ""), "base64");
    const check = Buffer.from(String(json.check ?? ""), "base64");
    if (json.version !== 1 || salt.length !== SALT_LEN || check.length < NONCE_LEN + TAG_LEN) {
      throw new Error("unrecognized shape");
    }
    vaultSalt = salt;
  } catch (err) {
    console.warn(`[vault] ${VAULT_PATH} is unreadable (${err}); moving it aside`);
    await rename(VAULT_PATH, `${VAULT_PATH}.bad-${Date.now()}`).catch(() => {});
    vaultSalt = null;
  }
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, { ...KDF, maxmem: SCRYPT_MAXMEM });
}

function checkAgainstFile(key: Buffer, checkB64: string): boolean {
  const raw = Buffer.from(checkB64, "base64");
  try {
    const plain = gcmOpen(key, raw.subarray(0, NONCE_LEN), raw.subarray(NONCE_LEN));
    return plain.length === CHECK_PLAINTEXT.length && timingSafeEqual(plain, CHECK_PLAINTEXT);
  } catch {
    return false;
  }
}

// --- GCM helpers ------------------------------------------------------------

function gcmSeal(key: Buffer, nonce: Buffer, plain: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

// Throws on a bad tag. Callers turn that into "damaged, restore from backup
// or sync" (locking.md §2), never into silently wrong plaintext.
function gcmOpen(key: Buffer, nonce: Buffer, ctAndTag: Buffer): Buffer {
  if (ctAndTag.length < TAG_LEN) throw new Error("ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(ctAndTag.subarray(ctAndTag.length - TAG_LEN));
  return Buffer.concat([decipher.update(ctAndTag.subarray(0, ctAndTag.length - TAG_LEN)), decipher.final()]);
}

// --- lifecycle --------------------------------------------------------------

/** Create the vault from the first lock's passphrase: a fresh salt, the
 * derived master key, and the vault file. Throws when a vault already
 * exists, which is unlockVault's case. */
export async function createVault(passphrase: string): Promise<void> {
  if (vaultSalt !== null) throw new Error("a vault already exists");
  if (passphrase.length === 0) throw new Error("empty passphrase");
  const salt = randomBytes(SALT_LEN);
  const key = deriveKey(passphrase, salt);
  await saveVaultFile(salt, key);
  vaultSalt = salt;
  masterKey = key;
  startIdle();
}

/**
 * Unlock the vault. With a vault file, its check value decides. Without one,
 * but with locked notes on disk (synced from elsewhere, or the file lost),
 * pass `probeHeader`: any locked note's `locked:` value, whose salt derives
 * the key. Unwrapping that header's data key is then the check, and a success
 * rebuilds the vault file. A wrong passphrase returns false, never throws.
 */
export async function unlockVault(passphrase: string, probeHeader?: string): Promise<boolean> {
  // Already unlocked: still check the passphrase, against the key in hand
  // rather than the vault file, which is one derive and no read. The early
  // "yes" this replaces answered a passphrase it never looked at. Nothing in
  // the app reaches it today, since vault.unlock's `when` opens the dialog
  // only while the vault is shut, so this is the contract being made honest
  // rather than a hole being closed: the RPC is callable by any client, and
  // the shape becomes a bypass the moment an unlock is scoped to a caller
  // instead of to the process (locking.md §3). A wrong answer refuses and
  // changes nothing, since a vault that relocked on a typo would be a way to
  // shut another window out.
  if (masterKey !== null) {
    if (vaultSalt === null) return false; // unreachable: a key implies a salt
    const attempt = deriveKey(passphrase, vaultSalt);
    if (!timingSafeEqual(attempt, masterKey)) return false;
    startIdle(); // an unlock the user typed is activity, even a redundant one
    return true;
  }
  if (vaultSalt !== null) {
    let checkB64: string;
    try {
      const json = JSON.parse(await readFile(VAULT_PATH, "utf8")) as VaultFile;
      checkB64 = json.check;
    } catch {
      return false; // file vanished since load; a probe unlock can rebuild it
    }
    const key = deriveKey(passphrase, vaultSalt);
    if (!checkAgainstFile(key, checkB64)) return false;
    masterKey = key;
    startIdle();
    return true;
  }
  if (probeHeader === undefined) return false;
  const header = parseLockedHeader(probeHeader);
  const key = deriveKey(passphrase, header.salt);
  try {
    gcmOpen(key, header.wrapNonce, header.wrappedKey);
  } catch {
    return false;
  }
  await saveVaultFile(header.salt, key);
  vaultSalt = header.salt;
  masterKey = key;
  startIdle();
  return true;
}

/** Drop the master key. Callers push vaultChanged and evict view-side
 * plaintext. Dirty locked buffers must already be flushed: the ⌘L command
 * (vault.lock) flushes before calling this, and idle relock fires only after
 * minutes of no note traffic. */
export function lockVault(): void {
  masterKey = null;
  stopIdle();
}

function startIdle(): void {
  lastActivity = Date.now();
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    if (masterKey === null) return;
    if (Date.now() - lastActivity < IDLE_RELOCK_MS) return;
    console.log("[vault] idle; relocking");
    lockVault();
    onAutoLock?.();
  }, IDLE_SWEEP_MS);
  // The sweep must not hold the process open: tests would hang on it, and
  // the app's own drain loop already keeps the main process alive.
  (idleTimer as unknown as { unref?: () => void }).unref?.();
}

function stopIdle(): void {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
}

function requireKey(): Buffer {
  if (!masterKey) throw new Error("the vault is locked");
  return masterKey;
}

// --- the note envelope ------------------------------------------------------
// On disk (locking.md §2):
//   locked: v1.<b64 salt>.<b64 wrap-nonce>.<b64 wrapped-key+tag>
// in the frontmatter, with the body as base64 of (body-nonce ‖ ct ‖ tag)
// wrapped at 76 columns. Every header copies the salt in, so a locked note
// decrypts with the passphrase alone on any machine, vault file or not.

export interface LockedHeader {
  salt: Buffer;
  wrapNonce: Buffer;
  wrappedKey: Buffer; // 32-byte data key + 16-byte tag
}

const HEADER_RE = /^v1\.([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)$/;

/** Parse a `locked:` frontmatter value. Throws on a malformed one: a note
 * the disk says is locked reads as damaged, never as unlocked. */
export function parseLockedHeader(value: string): LockedHeader {
  const m = HEADER_RE.exec(value.trim());
  if (m) {
    const salt = Buffer.from(m[1]!, "base64");
    const wrapNonce = Buffer.from(m[2]!, "base64");
    const wrappedKey = Buffer.from(m[3]!, "base64");
    if (salt.length === SALT_LEN && wrapNonce.length === NONCE_LEN && wrappedKey.length === KEY_LEN + TAG_LEN) {
      return { salt, wrapNonce, wrappedKey };
    }
  }
  throw new Error("unrecognized locked: header (the note may be damaged)");
}

function unwrapDataKey(header: LockedHeader): Buffer {
  const key = requireKey();
  try {
    return gcmOpen(key, header.wrapNonce, header.wrappedKey);
  } catch {
    // The master key was checked at unlock, so this is not a mistyped
    // passphrase. The header was wrapped under a different master key: another
    // person's vault (locking.md §6a: locked notes do not travel between
    // people), this machine's own vault minted before the note was restored
    // (§6a's recovery order), or a passphrase change whose sweep did not
    // finish. The message names the two the user can act on.
    throw new Error("this note was locked by a different vault, so the current passphrase cannot open it (a note from another person's Ledge, or your own restored onto a machine that already had a passphrase)");
  }
}

/** Mint a fresh header for a note being locked: random data key, wrapped by
 * the current master key, salt copied in. Unlocked only. */
export function mintLockedHeader(): string {
  const key = requireKey();
  if (!vaultSalt) throw new Error("no vault"); // unreachable while unlocked
  const dataKey = randomBytes(KEY_LEN);
  const wrapNonce = randomBytes(NONCE_LEN);
  const wrapped = gcmSeal(key, wrapNonce, dataKey);
  return `v1.${vaultSalt.toString("base64")}.${wrapNonce.toString("base64")}.${wrapped.toString("base64")}`;
}

/** Encrypt a note body under its header's data key (fresh nonce per save). */
export function sealBody(headerValue: string, body: string): string {
  const dataKey = unwrapDataKey(parseLockedHeader(headerValue));
  const nonce = randomBytes(NONCE_LEN);
  const sealed = Buffer.concat([nonce, gcmSeal(dataKey, nonce, Buffer.from(body, "utf8"))]);
  const b64 = sealed.toString("base64");
  return b64.replace(/(.{76})/g, "$1\n").replace(/\n$/, "");
}

/** Decrypt a note body. Throws when the vault is locked, and throws a
 * distinct error when the ciphertext fails authentication (an edit from
 * outside Ledge counts as damage). */
export function openBody(headerValue: string, armored: string): string {
  const dataKey = unwrapDataKey(parseLockedHeader(headerValue));
  const raw = Buffer.from(armored.replace(/\s+/g, ""), "base64");
  if (raw.length < NONCE_LEN + TAG_LEN) throw new Error("locked body is damaged (too short)");
  const plain = (() => {
    try {
      return gcmOpen(dataKey, raw.subarray(0, NONCE_LEN), raw.subarray(NONCE_LEN));
    } catch {
      throw new Error("locked body failed authentication — the file was modified outside Ledge; restore it from a backup or sync history");
    }
  })();
  return plain.toString("utf8");
}

/** Whether `key` unwraps this header's data key. The passphrase change plans
 * its whole sweep before writing anything (locking.md §3), and this is the
 * per-note half of that check: it opens nothing and writes nothing. A
 * malformed header answers false, the same as one wrapped elsewhere. */
export function headerOpensWith(headerValue: string, key: Buffer): boolean {
  try {
    const header = parseLockedHeader(headerValue);
    gcmOpen(key, header.wrapNonce, header.wrappedKey);
    return true;
  } catch {
    return false;
  }
}

/** Re-wrap a header's data key from `oldKey` to `newKey`, stamping in
 * `newSalt`. This is the passphrase change: headers are rewritten, bodies
 * are not. The body still decrypts because the data key is unchanged. */
export function rewrapHeader(headerValue: string, oldKey: Buffer, newKey: Buffer, newSalt: Buffer): string {
  const header = parseLockedHeader(headerValue);
  const dataKey = (() => {
    try {
      return gcmOpen(oldKey, header.wrapNonce, header.wrappedKey);
    } catch {
      throw new Error("header does not open with the current passphrase");
    }
  })();
  const wrapNonce = randomBytes(NONCE_LEN);
  const wrapped = gcmSeal(newKey, wrapNonce, dataKey);
  return `v1.${newSalt.toString("base64")}.${wrapNonce.toString("base64")}.${wrapped.toString("base64")}`;
}

/**
 * Start a passphrase change: derive the new master key under a fresh salt
 * and return it with the old key, so the caller can rewrap every locked
 * note's header and every sealed asset (notes.ts owns finding them). The
 * vault file is not written until commitPassphraseChange. Unlocked only.
 */
export async function beginPassphraseChange(newPassphrase: string): Promise<{ oldKey: Buffer; oldSalt: Buffer; newKey: Buffer; newSalt: Buffer }> {
  const oldKey = requireKey();
  if (!vaultSalt) throw new Error("no vault");
  if (newPassphrase.length === 0) throw new Error("empty passphrase");
  const newSalt = randomBytes(SALT_LEN);
  const newKey = deriveKey(newPassphrase, newSalt);
  // `oldSalt` is what a rollback stamps back in when the sweep fails partway
  // (notes.ts changeVaultPassphrase). Without it the undo could restore the
  // old wrap under the new salt, which opens with neither passphrase.
  return { oldKey, oldSalt: vaultSalt, newKey, newSalt };
}

/** Finish a passphrase change once every header is rewrapped: write the new
 * vault file and make the new key the master key. notes.ts's rewrap sweep
 * calls this, not the RPC layer. */
export async function commitPassphraseChange(newKey: Buffer, newSalt: Buffer): Promise<void> {
  await saveVaultFile(newSalt, newKey);
  vaultSalt = newSalt;
  masterKey = newKey;
}

// --- the head/body split ----------------------------------------------------
// The plaintext head is the frontmatter block plus the first-content-line H1,
// derived the way slug.ts derives a title (frontmatterEnd, then blank lines
// skipped only after a block). Those bytes are where metaAt finds a note's
// title and locked flag (locking.md §2). Everything after is body, blank
// lines included. The split must round-trip byte for byte (head + body ===
// text), because writeNote re-splits on every save.

import { blockLines, frontmatterEnd } from "../shared/frontmatter";

export function splitHead(text: string): { head: string; body: string } {
  const fmEnd = frontmatterEnd(text);
  let pos = fmEnd;
  // Blank lines between the block and the H1 stay in the head, matching
  // headingOf's skip. Only after a frontmatter block, as there.
  if (fmEnd > 0) {
    const m = /^(?:[ \t]*\r?\n)+/.exec(text.slice(pos));
    if (m) pos += m[0].length;
  }
  const nl = text.indexOf("\n", pos);
  const firstLine = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
  if (/^#[ \t]+\S/.test(firstLine)) pos = nl === -1 ? text.length : nl + 1;
  else if (fmEnd === 0) pos = 0; // no block, no H1: nothing is head
  else pos = fmEnd; // block but no H1: the blank-line run is body
  return { head: text.slice(0, pos), body: text.slice(pos) };
}

// --- the asset envelope ------------------------------------------------------
// Sealed images (locking.md §5): magic ‖ salt ‖ wrap-nonce ‖ wrapped data key
// ‖ body nonce ‖ GCM(bytes). The master key does the wrapping, not a note's
// key, since several notes may reference one asset. Sealing happens in place
// under the asset's own name, marked by the magic bytes, so note references
// stay valid. The salt rides along, the way a note header carries one.

const ASSET_MAGIC = Buffer.from("LEDGESEAL1", "ascii");

export function isSealedAsset(bytes: Uint8Array): boolean {
  return bytes.length >= ASSET_MAGIC.length && ASSET_MAGIC.compare(bytes, 0, ASSET_MAGIC.length) === 0;
}

/** How many bytes at the front of a sealed asset carry its wrapped data key:
 * the magic, the salt, the wrap nonce, and the wrapped key with its tag. The
 * passphrase change's plan pass reads this much rather than whole images. */
export const SEALED_ASSET_HEAD_LEN = ASSET_MAGIC.length + SALT_LEN + NONCE_LEN + KEY_LEN + TAG_LEN;

/** Whether `key` unwraps this sealed asset's data key, given at least its
 * first SEALED_ASSET_HEAD_LEN bytes. The asset half of the plan check above.
 * False for bytes that are not a sealed asset, or are too short to tell. */
export function sealedAssetOpensWith(head: Uint8Array, key: Buffer): boolean {
  if (!isSealedAsset(head) || head.length < SEALED_ASSET_HEAD_LEN) return false;
  const buf = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  let at = ASSET_MAGIC.length + SALT_LEN;
  const wrapNonce = buf.subarray(at, (at += NONCE_LEN));
  const wrapped = buf.subarray(at, (at += KEY_LEN + TAG_LEN));
  try {
    gcmOpen(key, wrapNonce, wrapped);
    return true;
  } catch {
    return false;
  }
}

/** Seal image bytes under a fresh data key wrapped by the master key.
 * Unlocked only. */
export function sealAssetBytes(bytes: Uint8Array): Buffer {
  const key = requireKey();
  if (!vaultSalt) throw new Error("no vault");
  const dataKey = randomBytes(KEY_LEN);
  const wrapNonce = randomBytes(NONCE_LEN);
  const wrapped = gcmSeal(key, wrapNonce, dataKey);
  const bodyNonce = randomBytes(NONCE_LEN);
  const sealed = gcmSeal(dataKey, bodyNonce, Buffer.from(bytes));
  return Buffer.concat([ASSET_MAGIC, vaultSalt, wrapNonce, wrapped, bodyNonce, sealed]);
}

/** Open a sealed asset. Throws when the vault is locked, and throws a
 * distinct error when the bytes fail authentication (an edit from outside
 * Ledge counts as damage). */
export function openAssetBytes(sealed: Uint8Array): Buffer {
  const key = requireKey();
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  let at = ASSET_MAGIC.length + SALT_LEN; // the salt is a probe convenience, not needed here
  const wrapNonce = buf.subarray(at, (at += NONCE_LEN));
  const wrapped = buf.subarray(at, (at += KEY_LEN + TAG_LEN));
  const bodyNonce = buf.subarray(at, (at += NONCE_LEN));
  const body = buf.subarray(at);
  const dataKey = (() => {
    try {
      return gcmOpen(key, wrapNonce, wrapped);
    } catch {
      throw new Error("this image was sealed by a different vault, so the current passphrase cannot open it (locking.md §6a)");
    }
  })();
  try {
    return gcmOpen(dataKey, bodyNonce, body);
  } catch {
    throw new Error("sealed image failed authentication — the file was modified outside Ledge");
  }
}

/** Re-wrap a sealed asset's data key under a new master key (the passphrase
 * change's asset half; the sealed body is untouched, like note headers). */
export function rewrapAssetBytes(sealed: Uint8Array, oldKey: Buffer, newKey: Buffer, newSalt: Buffer): Buffer {
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  let at = ASSET_MAGIC.length + SALT_LEN;
  const wrapNonce = buf.subarray(at, (at += NONCE_LEN));
  const wrapped = buf.subarray(at, (at += KEY_LEN + TAG_LEN));
  const rest = buf.subarray(at); // body nonce + sealed bytes, key-unchanged
  const dataKey = gcmOpen(oldKey, wrapNonce, wrapped); // throws: not this vault's asset
  const newNonce = randomBytes(NONCE_LEN);
  return Buffer.concat([ASSET_MAGIC, newSalt, newNonce, gcmSeal(newKey, newNonce, dataKey), rest]);
}

// --- locked: line surgery ---------------------------------------------------
// The header line is Bun-owned text (locking.md §2). A save can neither mint
// nor drop it: writeNote re-stamps the disk's value into whatever the buffer
// says, and only the Remove Lock command strips it. The surgery preserves
// bytes around the one line it owns, since every other frontmatter line is
// the user's.

// A top-level `locked:` line, never an indented one. An indented one would
// be an env var named "locked" under `env:`.
const LOCKED_LINE = /^locked\s*:/;

/** Force the frontmatter to carry `locked: <headerValue>`: replace the
 * existing line where it sits (dropping stray duplicates), insert one as the
 * block's first line, or grow a block on a note that has none. */
export function stampLockedLine(text: string, headerValue: string): string {
  const line = `locked: ${headerValue}`;
  const b = blockLines(text);
  if (b === null) return `---\n${line}\n---\n${text}`;
  const content = b.lines.slice(1, b.close);
  const at = content.findIndex((l) => LOCKED_LINE.test(l));
  const stamped =
    at === -1
      ? [line, ...content]
      : content.map((l, i) => (i === at ? line : l)).filter((l, i) => i === at || !LOCKED_LINE.test(l));
  return [b.lines[0]!, ...stamped, ...b.lines.slice(b.close)].join("\n") + text.slice(b.end);
}

/** Remove every top-level `locked:` line. The whole block goes when every
 * line left in it is blank, so Remove Lock leaves no husk. A block still
 * holding comments or other keys is the user's, and it stays. A block with no
 * `locked:` line comes back untouched, blank or not: the frontmatter editor
 * opens an empty `---\n\n---\n` block, and the autosave that lands before the
 * user has typed anything must not delete it. */
export function stripLockedLine(text: string): string {
  const b = blockLines(text);
  if (b === null) return text;
  const body = b.lines.slice(1, b.close);
  const content = body.filter((l) => !LOCKED_LINE.test(l));
  if (content.length === body.length) return text;
  if (content.every((l) => l.trim() === "")) return text.slice(b.end);
  return [b.lines[0]!, ...content, ...b.lines.slice(b.close)].join("\n") + text.slice(b.end);
}

// --- test seams -------------------------------------------------------------

/** Clear the master key and the salt, stop the idle timer, and forget the
 * auto-lock callback. Tests only: module state outlives a test file, so a
 * vault unlocked in one must not leak into the next. */
export function resetVaultForTests(): void {
  masterKey = null;
  vaultSalt = null;
  stopIdle();
  onAutoLock = null;
}
