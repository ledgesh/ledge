// The view end of the note-store RPC, mirroring terminal/channel.ts: the store
// and the editor pool call these, and main.tsx binds them to the Electroview RPC
// once it exists. Keeping the shim separate means the persistence logic
// (notes/store.ts) is testable without an RPC or a webview.
import type { NoteMeta } from "../../shared/rpc-schema";

interface NoteHandlers {
  list: () => Promise<NoteMeta[]>;
  read: (path: string) => Promise<string | null>;
  write: (path: string, text: string) => Promise<void>;
  create: (text: string) => Promise<NoteMeta>;
  retitle: (path: string, text: string) => Promise<NoteMeta>;
  remove: (path: string) => Promise<void>;
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

export function deleteNote(path: string): Promise<void> {
  return bridge().remove(path);
}

export type { NoteMeta };
