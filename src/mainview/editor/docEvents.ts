// A broadcast fired on every doc change, including the fromDisk loads and
// reloads that pour a note's text in at open and after an external edit
// (workspace/editorPool.ts). setup.ts is the only dispatcher. The Outline
// panel listens and re-derives the active note's headings from the live doc.
// Autosave takes the other path: setup.ts calls noteChanged (notes/store.ts)
// only for real edits, because a load must not arm the autosave debounce.
//
// The dispatch half lives here rather than in editorPool. setup.ts imports it
// and editorPool imports setup, so dispatching from editorPool would make an
// import cycle. This module imports nothing.

type Listener = (docId: string) => void;

const listeners = new Set<Listener>();

export function onDocChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function dispatchDocChanged(docId: string): void {
  for (const fn of listeners) fn(docId);
}
