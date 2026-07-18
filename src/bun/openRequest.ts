// The CLI → app channel: how `ledge <title>` tells a RUNNING (or about to
// run) app which note to show. A request file in the app home, not a socket:
// "external actors reach the app through the filesystem" is already how
// agents' edits arrive (the watcher), it needs no always-listening ingress,
// and the app home is where machine-written coordination files live. The CLI
// resolves the title itself (same store, same rules) and writes the PATH;
// the app consumes the file — read, delete, validate — and reveals the note.
//
// Trust: the file sits in user-writable ground, so its payload is treated
// exactly like a view-supplied path (architecture.md §2) — it must resolve
// inside a registered root and name a .md, and all it can cause is an editor
// tab opening. The unlink here is not a note unlink (the §3 list is about
// notes): this is Bun consuming its own coordination file, the writeNote
// temp-file stance.
import { join, resolve } from "node:path";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { ExternalOpenInfo } from "../shared/rpc-schema";
import { headingOf, labelOf } from "../shared/slug";
import { readNote } from "./notes";
import { APP_HOME, ensureAppHome, rootContaining } from "./workspaces";

export const OPEN_REQUEST_PATH = join(APP_HOME, ".open-request.json");

// A request is "open this NOW", not a standing instruction: one written while
// the app was closed must cover the launch it triggered — seconds — and no
// more. Without the cutoff, an app launched Tuesday would replay a wish
// forgotten on Monday.
export const OPEN_REQUEST_MAX_AGE_MS = 60_000;


// The CLI's half. Temp-plus-rename like every machine write: the app's
// watcher must never read half a request.
export async function writeOpenRequest(path: string): Promise<void> {
  await ensureAppHome();
  const tmp = `${OPEN_REQUEST_PATH}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, JSON.stringify({ version: 1, path, ts: Date.now() }), "utf8");
    await rename(tmp, OPEN_REQUEST_PATH);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// The app's half: consume whatever request is pending. Always removes the
// file first — a request that fails validation is spent, not retried; every
// failure costs exactly the request. Returns null when there is nothing
// valid to open (no file, someone else took it, stale, or a path the guards
// refuse).
export async function takeOpenRequest(now: number = Date.now()): Promise<ExternalOpenInfo | null> {
  let raw: string;
  try {
    raw = await readFile(OPEN_REQUEST_PATH, "utf8");
  } catch {
    return null; // nothing pending
  }
  await unlink(OPEN_REQUEST_PATH).catch(() => {}); // racing consumer already took it: fine
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const req = json as Record<string, unknown>;
  if (req["version"] !== 1 || typeof req["path"] !== "string") return null;
  if (typeof req["ts"] !== "number" || now - req["ts"] > OPEN_REQUEST_MAX_AGE_MS) return null;
  const path = resolve(req["path"]);
  const root = rootContaining(path);
  if (root === null || !/\.md$/i.test(path)) return null; // the view-path guard, applied here
  let file: Awaited<ReturnType<typeof readNote>>;
  try {
    file = await readNote(path);
  } catch {
    return null;
  }
  if (file === null) return null; // renamed or deleted since the CLI resolved it
  return { root, path, title: labelOf(headingOf(file.text), path), mtimeMs: file.mtimeMs };
}
