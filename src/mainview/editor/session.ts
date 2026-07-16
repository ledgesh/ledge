import { Facet } from "@codemirror/state";

// The note (docId) an editor belongs to, stamped once at createEditor. blocks.ts
// reads it so a block run carries its note's id, and the Bun side routes the run
// to that note's own shell. Lives in its own module to keep setup.ts <-> blocks.ts
// free of a circular import (setup imports blocks; blocks needs the facet).
export const sessionIdFacet = Facet.define<string, string>({
  combine: (values) => values[0] ?? "",
});
