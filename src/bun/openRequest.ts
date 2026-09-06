// The CLI-to-app channel: `ledge <title>` tells a running (or about to run)
// app which note to show. The CLI resolves the title itself (same store, same
// rules) and writes the path into a request file in the app home. The app
// reads the file, deletes it, validates it, and reveals the note. Requests
// travel through a file rather than a socket because external actors reach
// the app through the filesystem, as agents' edits do through the watcher
// (architecture.md §1).
//
// Trust: anyone who can write the app home can write this file, so its
// payload is treated like a view-supplied path (architecture.md §2). It must
// resolve inside a registered root and name a .md. The worst it can cause is
// an editor tab opening. The unlink here is not a note unlink (the §3 list
// covers notes): Bun removes a coordination file it wrote itself, as
// writeNote does with its temp file after a failed save.
import { join, resolve } from "node:path";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { ExternalOpenInfo } from "../shared/rpc-schema";
import { headingOf, labelOf } from "../shared/slug";
import { readNote } from "./notes";
import { APP_HOME, ensureAppHome, rootContaining } from "./workspaces";

export const OPEN_REQUEST_PATH = join(APP_HOME, ".open-request.json");

// How long a request stays valid. A request means "open this now", not a
// standing instruction. One written while the app was closed only has to
// cover the launch it triggered. That takes seconds. Without the cutoff, an
// app launched days later would open a note the user asked for long ago.
export const OPEN_REQUEST_MAX_AGE_MS = 60_000;


// The CLI's half of the channel. Writes the request file with a temp file
// plus rename, like every machine write, so the app's watcher never reads
// half a request.
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

// The app's half of the channel. Consumes whatever request is pending,
// removing the file before validating anything. A bad request is therefore
// spent rather than retried, and costs that one request and nothing more.
// Returns null when there is nothing valid to open: no file exists, a racing
// consumer took it, the request is older than OPEN_REQUEST_MAX_AGE_MS, or
// the path guards refuse it.
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
