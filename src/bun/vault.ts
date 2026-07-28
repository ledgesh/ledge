// The vault: key lifecycle and envelope crypto for locked notes
// (locking.md). One app-wide passphrase; scrypt derives the master key;
// each locked note carries a random data key wrapped by it. Everything is
// node:crypto (AES-256-GCM throughout) — the dependency policy's zero-new-
// packages answer — and the master key lives only in this process's memory,
// from unlock to relock. This module owns keys and byte shapes only: WHAT is
// locked, and where the seams sit, is notes.ts/assets.ts business (vault must
// not import notes — the dependency arrow points one way, like workspaces').
import { join } from "node:path";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { APP_HOME, ensureAppHome } from "./workspaces";

// scrypt cost: interactive-unlock territory (~100ms on current hardware),
// chosen once and recorded in the vault file so a future cost bump can read
// old vaults. maxmem must clear 128*N*r bytes or node:crypto refuses.
const KDF = { N: 1 << 17, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 512 * 1024 * 1024;

const KEY_LEN = 32; // AES-256
const NONCE_LEN = 12; // GCM standard
const TAG_LEN = 16;
const SALT_LEN = 16;

// What .vault.json's check value encrypts. Decrypting it successfully IS the
// passphrase check: wrong passphrase -> wrong key -> GCM auth failure, and no
// note was touched to find out.
const CHECK_PLAINTEXT = Buffer.from("ledge-vault-check-v1", "utf8");

export const VAULT_PATH = join(APP_HOME, ".vault.json");

// 15 minutes with no note RPC traffic relocks. Activity on the wire is the
// idle proxy (notes.ts touches on every read/write): autosave debounce means
// a dirty buffer cannot be older than seconds, so an idle window this long
// proves there is nothing unflushed to lose. No settings knob until the
// default demonstrably fails someone (architecture.md §6).
const IDLE_RELOCK_MS = 15 * 60 * 1000;
const IDLE_SWEEP_MS = 60 * 1000;

export type VaultState = "none" | "locked" | "unlocked";

// The whole in-memory vault: the derived master key while unlocked, and the
// salt every header must be minted from. Never written anywhere; dies with
// the process or the relock.
let masterKey: Buffer | null = null;
let vaultSalt: Buffer | null = null;
let lastActivity = 0;
let idleTimer: ReturnType<typeof setInterval> | null = null;
let onAutoLock: (() => void) | null = null;

/** Register what auto-relock should do beyond dropping keys (index.ts pushes
 * vaultChanged). One callback, replaced not stacked. */
export function configureVault(handlers: { onAutoLock: () => void }): void {
  onAutoLock = handlers.onAutoLock;
}

/** Note-RPC activity: resets the idle-relock clock (called from the notes.ts
 * read/write funnel — the one place every content path already passes). */
export function touchVault(): void {
  lastActivity = Date.now();
}

export function vaultState(): VaultState {
  if (masterKey) return "unlocked";
  return vaultSalt ? "locked" : "none";
}

// --- the vault file ---------------------------------------------------------
// Machine-written AND Bun-shaped, like .workspaces.json: the view never sees
// its bytes. A CONVENIENCE artifact, not a precious one — every locked note
// carries its own salt, so this file only buys a passphrase check that
// touches no note. Corrupt: renamed aside for forensics (workspaces' move)
// and rebuilt from the next successful unlock.

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

/** Load the vault file (boot, and before any unlock). Missing file: state
 * stays "none" — first lock creates it, or an unlock probing a locked note's
 * own header rebuilds it. Corrupt: aside-and-continue, never a crash. */
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

// Throws on a bad tag — which is the tamper signal every caller turns into
// "damaged — restore from backup/sync", never into silently-wrong plaintext.
function gcmOpen(key: Buffer, nonce: Buffer, ctAndTag: Buffer): Buffer {
  if (ctAndTag.length < TAG_LEN) throw new Error("ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(ctAndTag.subarray(ctAndTag.length - TAG_LEN));
  return Buffer.concat([decipher.update(ctAndTag.subarray(0, ctAndTag.length - TAG_LEN)), decipher.final()]);
}

// --- lifecycle --------------------------------------------------------------

/** First lock ever: choose the passphrase, mint the vault. Refused when one
 * already exists — that flow is unlockVault. */
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
 * Unlock. Ordinarily the vault file's check value answers; with NO vault file
 * but locked notes on disk (synced from another machine, or the file lost),
 * `probeHeader` — any locked note's own `locked:` value — stands in: its salt
 * derives the key and unwrapping its data key is the check, after which the
 * vault file is rebuilt so the next unlock is ordinary. Returns false for a
 * wrong passphrase; never throws for one.
 */
export async function unlockVault(passphrase: string, probeHeader?: string): Promise<boolean> {
  if (masterKey) return true;
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
 * plaintext; by the time this runs, dirty locked buffers must already be
 * flushed (the ⌘L command flushes first; idle relock proves it by silence). */
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
  // Housekeeping must not hold the process open (tests would hang on it; the
  // app's own drain loop already keeps the main process alive).
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
// in the frontmatter, and the body as base64 of (body-nonce ‖ ct ‖ tag),
// 76-col wrapped. The salt is COPIED into every header so a locked note is
// self-contained: it decrypts with the passphrase alone on any machine,
// vault file or not.

export interface LockedHeader {
  salt: Buffer;
  wrapNonce: Buffer;
  wrappedKey: Buffer; // 32-byte data key + 16-byte tag
}

const HEADER_RE = /^v1\.([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)$/;

/** Parse a `locked:` frontmatter value, or throw — a malformed header on a
 * note the disk says is locked reads as damage, not as unlocked. */
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
    // The master key is checked at unlock, so a failed unwrap here is a note
    // from a DIFFERENT passphrase era (or a tampered header), not a typo.
    throw new Error("this note's key does not open with the current passphrase (damaged, or locked under an old passphrase)");
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

/** Decrypt a note body. Throws when the vault is locked, and — distinctly —
 * when the ciphertext fails authentication (external tamper = damage). */
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

/** Re-wrap an existing header's data key under the current master key (the
 * passphrase-change move: headers rewrite, bodies never do). The body stays
 * decryptable because the DATA key is unchanged. */
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
 * Change the vault passphrase: derive the new master key under a fresh salt,
 * persist the new vault file, and hand the caller both keys so it can rewrap
 * every locked note's header (notes.ts owns finding them). Unlocked only.
 */
export async function beginPassphraseChange(newPassphrase: string): Promise<{ oldKey: Buffer; newKey: Buffer; newSalt: Buffer }> {
  const oldKey = requireKey();
  if (newPassphrase.length === 0) throw new Error("empty passphrase");
  const newSalt = randomBytes(SALT_LEN);
  const newKey = deriveKey(newPassphrase, newSalt);
  return { oldKey, newKey, newSalt };
}

/** Commit a passphrase change after every header rewrapped: the new key
 * becomes the vault. (Called by notes.ts's rewrap sweep, not the RPC layer.) */
export async function commitPassphraseChange(newKey: Buffer, newSalt: Buffer): Promise<void> {
  await saveVaultFile(newSalt, newKey);
  vaultSalt = newSalt;
  masterKey = newKey;
}

// --- the head/body split ----------------------------------------------------
// The plaintext head is the frontmatter block plus the first-content-line H1,
// EXACTLY as slug.ts derives the title (frontmatterEnd, then blank lines are
// skipped only after a block): what stays readable is precisely what labels
// the note. Everything after — blank lines included — is body, and the split
// must round-trip byte-for-byte (head + body === text), because writeNote
// re-splits on every save.

import { frontmatterEnd } from "../shared/frontmatter";

export function splitHead(text: string): { head: string; body: string } {
  const fmEnd = frontmatterEnd(text);
  let pos = fmEnd;
  // Blank lines between the block and the H1 stay in the head, matching
  // headingOf's skip — but only after a frontmatter block, exactly as there.
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
// Sealed images (locking.md §5): magic ‖ salt ‖ wrap-nonce ‖ wrapped
// data key ‖ body nonce ‖ GCM(bytes). Wrapped by the MASTER key, not a
// note's — assets live in a per-root shared pool and may be referenced from
// several notes. Sealed IN PLACE under the asset's own name, detected by the
// magic bytes: the name never changes, so note references stay valid, the
// never-unlink rule holds (the transition is writeAsset's temp+rename, no
// second file), and an external tool still fails loudly — the bytes are not
// a PNG and no longer pretend to be. The salt rides along for the same
// self-containment reason as note headers.

const ASSET_MAGIC = Buffer.from("LEDGESEAL1", "ascii");

export function isSealedAsset(bytes: Uint8Array): boolean {
  return bytes.length >= ASSET_MAGIC.length && ASSET_MAGIC.compare(bytes, 0, ASSET_MAGIC.length) === 0;
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

/** Open a sealed asset. Throws when the vault is locked, and — distinctly —
 * when the bytes fail authentication (tamper = damage). */
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
      throw new Error("this image's key does not open with the current passphrase (damaged, or sealed under an old passphrase)");
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
// The header line is Bun-OWNED text (locking.md §2): a save can neither
// mint nor drop it, so writeNote re-stamps the disk's value into whatever the
// buffer says, and only the Remove Lock command strips it. Byte-preserving
// around the one line it owns: every other frontmatter line is the user's.

// A top-level `locked:` line — never an indented one, which would be an env
// var named "locked" under `env:`.
const LOCKED_LINE = /^locked\s*:/;

// The block's lines, split so surgery can address them: `open`/`close` are
// the fence indices into `lines`; content is the exclusive range between.
// Returns null when the text has no block (frontmatterEnd's definition).
function blockLines(text: string): { end: number; lines: string[]; close: number } | null {
  const end = frontmatterEnd(text);
  if (end === 0) return null;
  const lines = text.slice(0, end).split("\n");
  for (let i = lines.length - 1; i > 0; i -= 1) {
    if (/^---\s*$/.test(lines[i]!)) return { end, lines, close: i };
  }
  return null; // unreachable: frontmatterEnd found a closing fence
}

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

/** Remove every top-level `locked:` line; a block EMPTIED by that removal goes
 * entirely (Remove Lock should leave no husk — but a block with comments or
 * other keys is the user's, and stays). A block this found nothing to remove
 * from is returned untouched, blank or not: the frontmatter editor opens a
 * note's first block as `---\n\n---\n` and the autosave that lands before the
 * user types a key must not delete what they just opened. */
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

/** Reset every module-level piece (tests only: module state outlives test
 * files, and a vault unlocked in one must not leak into the next). */
export function resetVaultForTests(): void {
  masterKey = null;
  vaultSalt = null;
  stopIdle();
  onAutoLock = null;
}
