// Seed text for a note with no file yet (workspace/tree.ts `seed`). The
// welcome note is a file from a machine's first launch on (shared/welcome.ts),
// and this unsaved copy fills the first tab only when a folder has no notes
// and there is no saved layout (workspace/store.tsx initialState). Every other
// new tab opens on the near-empty scratch note. A tab whose note is on disk
// loads the file.
export { WELCOME_DOC, WELCOME_TITLE } from "../../shared/welcome";
import { WELCOME_DOC } from "../../shared/welcome";

// The H1 and nothing else. Typing over the heading is how a note is renamed:
// the first line names the file (notes/store.ts syncTitle), and there is no
// rename command for notes. Nothing else is seeded, so a new note opens as a
// blank page with no sample block to delete first.
export const SCRATCH_DOC = ["# Untitled", "", ""].join("\n");

export function seedDoc(seed: "demo" | "scratch"): string {
  return seed === "demo" ? WELCOME_DOC : SCRATCH_DOC;
}
