// The Bun end of session persistence: .layout.json in the notes root, holding
// which workspaces exist, their pane trees, and which notes are open where.
// This is machine-written state, not settings (architecture.md §6): the VIEW
// owns the shape and self-heals a corrupt file by discarding it at parse time
// (workspace/persist.ts), so this module deals only in bytes — read them back,
// write them atomically. Dotted, so listNotes never shows it.
import { basename, join } from "node:path";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { ensureRoot, NOTES_ROOT } from "./notes";

export const LAYOUT_PATH = join(NOTES_ROOT, ".layout.json");

// The saved layout's raw text, or null when none has ever been saved (first
// launch) or it cannot be read — both mean the same thing to the caller: boot
// fresh. The view's parser handles everything else, so no validation here.
export async function readLayout(): Promise<string | null> {
  try {
    return await readFile(LAYOUT_PATH, "utf8");
  } catch {
    return null;
  }
}

// Persist the layout text. Two guards, one on each side of the trust boundary:
// the text must parse as JSON — the write lands in the notes root, and an RPC
// that wrote arbitrary view-supplied bytes to a fixed name would still be
// arbitrary byte storage in the folder people sync — and the write is the same
// temp-plus-rename as a note save, so a crash mid-write leaves the old layout
// or the new one, never half. Returns false (warned) for non-JSON.
let tmpCounter = 0;
export async function writeLayout(text: string): Promise<boolean> {
  try {
    JSON.parse(text);
  } catch (err) {
    console.warn(`[layout] refusing to save non-JSON layout (${err})`);
    return false;
  }
  await ensureRoot();
  tmpCounter += 1;
  const tmp = join(NOTES_ROOT, `.${basename(LAYOUT_PATH)}.tmp-${process.pid}-${tmpCounter}`);
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, LAYOUT_PATH);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return true;
}
