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

export type { NoteMeta };
