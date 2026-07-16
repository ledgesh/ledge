// The view end of the note-store RPC, mirroring terminal/channel.ts: the store
// and the editor pool call these, and main.tsx binds them to the Electroview RPC
// once it exists. Keeping the shim separate means the persistence logic
// (notes/store.ts) is testable without an RPC or a webview.
import type { NoteMeta, TrashMeta } from "../../shared/rpc-schema";

interface NoteHandlers {
  list: () => Promise<NoteMeta[]>;
  read: (path: string) => Promise<string | null>;
  write: (path: string, text: string) => Promise<void>;
  create: (text: string) => Promise<NoteMeta>;
  retitle: (path: string, text: string) => Promise<NoteMeta>;
  remove: (path: string) => Promise<string | null>;
  trash: () => Promise<TrashMeta[]>;
  restore: (path: string) => Promise<NoteMeta>;
  empty: () => Promise<number>;
}

let handlers: NoteHandlers | null = null;

export function configureNotes(h: NoteHandlers): void {
  handlers = h;
}

function bridge(): NoteHandlers {
  if (!handlers) throw new Error("note bridge not configured");
  return handlers;
}

export function listNotes(): Promise<NoteMeta[]> {
  return bridge().list();
}

export function readNote(path: string): Promise<string | null> {
  return bridge().read(path);
}

export function writeNote(path: string, text: string): Promise<void> {
  return bridge().write(path, text);
}

export function createNote(text: string): Promise<NoteMeta> {
  return bridge().create(text);
}

// Ask Bun to move a note's file to match its heading. Takes the note's text, not
// a name: Bun derives the slug, so it cannot be handed a path.
export function retitleNote(path: string, text: string): Promise<NoteMeta> {
  return bridge().retitle(path, text);
}

// Resolves to where the note landed in the trash (the handle Undo restores
// from), or null if the file was already gone.
export function deleteNote(path: string): Promise<string | null> {
  return bridge().remove(path);
}

export function listTrash(): Promise<TrashMeta[]> {
  return bridge().trash();
}

// Takes a path Bun handed out via listTrash, and Bun re-checks that it really is
// a trashed note before moving it.
export function restoreNote(path: string): Promise<NoteMeta> {
  return bridge().restore(path);
}

export function emptyTrash(): Promise<number> {
  return bridge().empty();
}

export type { NoteMeta, TrashMeta };
