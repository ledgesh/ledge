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

/**
 * Why `folder` is not a usable folder NAME, phrased as the parenthetical the
 * errors carry, or null when it is fine. The root ("" and every spelling of
 * it) is fine: it is where notes lived before folders.
 *
 * These are the shape rules only. Containment — is the resolved path actually
 * inside this workspace — needs a root and stays in `folderPathOf`
 * (bun/notes.ts), which composes its message from what this returns. It lives
 * here because the settings validator has to ask the same question about
 * `daily.folder` with no root and no filesystem in reach, and two statements
 * of what a folder may be called is one more than the rule can survive.
 */
export function folderNameProblem(folder: string): string | null {
  const trimmed = folder.trim();
  if (trimmed.includes("\\")) return "use / to separate segments";
  // Tested on the trimmed name but BEFORE trailing slashes are stripped, so
  // that a leading space cannot smuggle `/etc` through as an empty segment and
  // a bare `/` cannot strip itself down to the root.
  if (trimmed.startsWith("/")) return "folders are relative to the workspace";
  const rel = folderScopeOf(trimmed);
  if (rel === "") return null;
  for (const segment of rel.split("/")) {
    // `..` is rejected on the RAW segments rather than left to a containment
    // check, so `a/../b` cannot quietly mean `b`: the folder a caller names is
    // the folder they get, or an error.
    if (segment === "" || segment === "." || segment === "..") return 'empty, "." and ".." segments are not allowed';
    if (segment.startsWith(".")) return "dot-folders are Ledge's own and invisible to the note list";
  }
  return null;
}

/**
 * Why `name` is not a usable folder name for a RENAME, or null when it is
 * fine. `folderNameProblem`'s rules plus the two that a single segment adds.
 *
 * Empty is one of them: "" is a perfectly good folder PATH (it is the root)
 * and no kind of folder name at all, so the rule that lets the root through
 * above has to be closed here.
 *
 * A separator is the other. A rename says what the folder is called; it does
 * not say where it sits, and the two are different questions with different
 * UI — a name is a field, a parent is a chooser. A `/` in the field is
 * therefore a typo, not a shorthand, and reading it as one would silently
 * reparent the folder (bun/notes.ts renameFolder).
 */
export function folderLeafProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "a folder needs a name";
  if (trimmed.includes("/")) return "a rename names a folder, it does not move it";
  return folderNameProblem(trimmed);
}

/** The notes at or below `folder`. The whole list when the scope is the root. */
export function notesUnder<T extends Pick<NoteMeta, "folder">>(notes: readonly T[], folder: string): T[] {
  return folder === "" ? [...notes] : notes.filter((n) => folderContains(folder, n.folder ?? ""));
}
