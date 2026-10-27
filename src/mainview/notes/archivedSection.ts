// Whether the note browser's Archived section is open, per workspace. Closed
// is the default (interactions.md §3).
//
// A module-level mirror for notes/sorting.ts's reasons: the layout save
// subscribes to it (App.tsx), and `.layout.json` carries each workspace's
// choice beside its open folders and its sort (workspace/persist.ts). Whether
// the section is open is arrangement, like which folders are open.
import { useSyncExternalStore } from "react";

// Keyed by workspace root. Absent means closed, so a workspace whose section
// was never opened writes nothing to the layout file.
const opened = new Set<string>();
const subs = new Set<() => void>();

function notify(): void {
  for (const fn of subs) fn();
}

/** Whether one workspace's Archived section is open. */
export function archivedOpenIn(root: string): boolean {
  return opened.has(root);
}

export function setArchivedOpen(root: string, open: boolean): void {
  if (archivedOpenIn(root) === open) return;
  if (open) opened.add(root);
  else opened.delete(root);
  notify();
}

/** What one workspace's saved layout restored (workspace/persist.ts). Only a
 * literal `true` opens it, since the file is machine-written and may predate
 * the field. */
export function seedArchivedOpen(root: string, raw: unknown): void {
  if (raw === true) opened.add(root);
  else opened.delete(root);
  notify();
}

/** Listen for any workspace's section opening or closing. */
export function subscribeArchivedOpen(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** The React face of the same state (the browser's section header). */
export function useArchivedOpen(root: string): boolean {
  return useSyncExternalStore(subscribeArchivedOpen, () => archivedOpenIn(root));
}

/** Tests only: back to a fresh app. */
export function resetArchivedOpen(): void {
  opened.clear();
}
