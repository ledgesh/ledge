// The built-in documentation corpus, compiled INTO the binary as text imports
// rather than shipped as loose files: the bundle then needs no build.copy
// entry, and dev and packaged runs resolve the pages identically (no
// import.meta.dir gymnastics against two different bundle layouts). The
// authored sources live in docs/user/ as ordinary Markdown; adding a page is
// one import plus one manifest line, and bun/docs.ts syncs the manifest into
// ~/.ledge/.ledge-docs at every launch.
//
// Filenames are stated here, not derived from the H1 like a user note's:
// these files are machine-written artifacts (the sync compares and prunes by
// exactly these names), and the source file in docs/user/ should keep the
// same name so grep finds both ends.
//
// Authoring rule: one line per paragraph, no hard wrapping. These pages
// render in the editor, which soft-wraps; an 80-column wrap (the style of
// the repo docs next door) shows up as broken lines mid-sentence.
import gettingStarted from "../../docs/user/getting-started.md" with { type: "text" };

export interface DocPage {
  /** The .md filename inside the docs root. */
  name: string;
  text: string;
}

export const DOC_PAGES: DocPage[] = [
  { name: "getting-started.md", text: gettingStarted },
];
