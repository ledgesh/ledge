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
// same name so grep finds both ends. The numeric prefix IS the reading
// order: the note browser sorts the docs workspace by path (NoteBrowser.tsx),
// so the manifest's numbering decides how the manual reads top to bottom —
// titles stay clean, and renumbering is just a rename the sync absorbs.
//
// Authoring rules: one line per paragraph, no hard wrapping (these pages
// render in the editor, which soft-wraps; an 80-column wrap, the style of
// the repo docs next door, shows up as broken lines mid-sentence) — and no
// em dashes in the prose.
import gettingStarted from "../../docs/user/01-getting-started.md" with { type: "text" };
import notesAndWorkspaces from "../../docs/user/02-notes-and-workspaces.md" with { type: "text" };
import runningCode from "../../docs/user/03-running-code.md" with { type: "text" };
import findingThings from "../../docs/user/04-finding-things.md" with { type: "text" };

export interface DocPage {
  /** The .md filename inside the docs root. */
  name: string;
  text: string;
}

export const DOC_PAGES: DocPage[] = [
  { name: "01-getting-started.md", text: gettingStarted },
  { name: "02-notes-and-workspaces.md", text: notesAndWorkspaces },
  { name: "03-running-code.md", text: runningCode },
  { name: "04-finding-things.md", text: findingThings },
];
