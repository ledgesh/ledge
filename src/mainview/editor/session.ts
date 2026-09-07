import { Annotation, Facet } from "@codemirror/state";

// The note (docId) an editor belongs to, set once in createEditor (setup.ts).
// blocks.ts reads it so a block run carries the note's id. The Bun side uses
// that id to route the run to the note's own shell. The facet sits in its own
// module to avoid a circular import: setup.ts imports blocks.ts, and blocks.ts
// needs the facet.
export const sessionIdFacet = Facet.define<string, string>({
  combine: (values) => values[0] ?? "",
});

// Marks the transactions that load a note's saved text from disk into its
// editor. editorPool.ts dispatches them at open, on a reload after an
// external edit, and when the server's text is adopted over a stranded local
// edit. Only the autosave arm of the change listener in setup.ts skips them,
// so a load does not mark the note dirty. The doc-changed broadcast still
// runs, so the Outline panel fills in when a note's text arrives.
export const fromDisk = Annotation.define<boolean>();
