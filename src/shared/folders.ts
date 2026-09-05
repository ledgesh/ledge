// The folder vocabulary both ends share: what "in a folder" means when the
// question is asked about a note that is already listed.
//
// Placing a note is Bun's alone — `folderPathOf` (bun/notes.ts) validates the
// one name a caller chooses and turns it into a directory, and nothing here
// builds a path or touches a disk. What lives here is the SELECTION question,
// which both ends ask and neither should answer twice: the note browser
// counting what a collapsed row hides (mainview/notes/folders.ts), and the
// agent surfaces scoping a listing, a search or a tag scan to one folder
// (bun/mcpTools.ts). One definition because the prefix test is the kind that
// looks obvious and is not: `a` must not contain its SIBLING `ab`.
import type { NoteMeta } from "./rpc-schema";

/**
 * Is `candidate` at or below `folder`? Both are root-relative folder paths
 * with forward slashes, "" being the workspace root — which contains
 * everything, so a scope of "" is no scope at all.
 *
 * The `/` in the prefix test is load-bearing: `startsWith("a")` would make
 * `ab` a child of `a`.
 */
export function folderContains(folder: string, candidate: string): boolean {
  return folder === "" || candidate === folder || candidate.startsWith(`${folder}/`);
}

/**
 * A caller-supplied folder scope, cleaned up: trimmed, trailing slashes gone,
 * and null/absent folded into "" — the root, which selects everything.
 *
 * No validation, deliberately. This name never becomes a path (that is
 * `folderPathOf`'s job and it refuses everything unsafe), so the worst a
 * malformed scope can do here is match nothing — and matching nothing is also
 * what a correctly-spelled folder holding no notes does. A folder holding no
 * notes is not a thing Ledge shows anywhere (mainview/notes/folders.ts), so
 * the two cases are the same answer and neither is an error.
 */
export function folderScopeOf(folder: unknown): string {
  return typeof folder === "string" ? folder.trim().replace(/\/+$/, "") : "";
}

/** The notes at or below `folder`. The whole list when the scope is the root. */
export function notesUnder<T extends Pick<NoteMeta, "folder">>(notes: readonly T[], folder: string): T[] {
  return folder === "" ? [...notes] : notes.filter((n) => folderContains(folder, n.folder ?? ""));
}
