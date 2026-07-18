// Who edits tells; who derives listens. A tiny broadcast fired on EVERY doc
// change — user edits AND fromDisk loads/reloads — which is what sets it apart
// from notes/store's noteChanged, which deliberately skips loads (a load must
// not arm autosave). The Outline panel re-derives the active note's headings
// from the live doc on this signal; setup.ts is the one dispatcher.
//
// Its own module (not editorPool) because setup.ts must import the dispatch
// half and editorPool imports setup — this stays cycle-free by importing
// nothing at all.

type Listener = (docId: string) => void;

const listeners = new Set<Listener>();

export function onDocChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function dispatchDocChanged(docId: string): void {
  for (const fn of listeners) fn(docId);
}
