// Both ends share this folder vocabulary: which notes in a list count as "in"
// a folder. Nothing here builds a path or touches disk. Placing a note is the
// Bun side's alone: `folderPathOf` (bun/notes.ts) validates the one name a
// caller chooses and turns it into a directory (architecture.md §2).
//
// The note browser counts what a collapsed row hides with these functions
// (mainview/notes/folders.ts). The agent surfaces scope a listing, a search or
// a tag scan to one folder with them (bun/mcpTools.ts). One definition,
// because the prefix test is easy to get wrong: `a` must not contain its
// sibling `ab`.
import type { NoteMeta } from "./rpc-schema";

/**
 * Is `candidate` at or below `folder`? Both are root-relative folder paths
 * with forward slashes. "" is the workspace root and contains everything. A
 * scope of "" selects every note. The `/` in the prefix test matters:
 * `startsWith("a")` would make `ab` a child of `a`.
 */
export function folderContains(folder: string, candidate: string): boolean {
  return folder === "" || candidate === folder || candidate.startsWith(`${folder}/`);
}

/**
 * A caller-supplied folder scope, cleaned up: trimmed, trailing slashes
 * removed, null or absent folded into "" (the root, which selects everything).
 *
 * This function validates nothing. The name it returns never becomes a path:
 * `folderPathOf` does that, and it refuses anything unsafe. A malformed scope
 * therefore matches nothing. A correctly spelled folder holding no notes
 * matches nothing too, and Ledge never shows an empty folder
 * (mainview/notes/folders.ts). Neither case is an error.
 */
export function folderScopeOf(folder: unknown): string {
  return typeof folder === "string" ? folder.trim().replace(/\/+$/, "") : "";
}

/**
 * Why `folder` is not a usable folder name, phrased as the parenthetical the
 * errors carry, or null when it is fine. The root ("" and every spelling of
 * it) is fine: it is where notes lived before folders.
 *
 * These are the shape rules only. The remaining rule, whether the resolved
 * path lands inside this workspace, needs a root and stays in `folderPathOf`
 * (bun/notes.ts). That gate composes its message from what this returns.
 *
 * The shape rules live here, not there, because the settings validator asks
 * the same question about `daily.folder` with no root and no filesystem in
 * reach. Only one statement of them can exist: a second copy would drift, and
 * the two would come to disagree about what a folder may be called.
 */
export function folderNameProblem(folder: string): string | null {
  const trimmed = folder.trim();
  if (trimmed.includes("\\")) return "use / to separate segments";
  // This checks the leading slash on the trimmed name, before trailing
  // slashes are stripped. A leading space would otherwise smuggle `/etc`
  // through as an empty segment, and a bare `/` would strip itself down to the
  // root.
  if (trimmed.startsWith("/")) return "folders are relative to the workspace";
  const rel = folderScopeOf(trimmed);
  if (rel === "") return null;
  for (const segment of rel.split("/")) {
    // `..` is rejected on the raw segments rather than left to a containment
    // check, so `a/../b` cannot mean `b`. A caller gets the folder they named,
    // or an error.
    if (segment === "" || segment === "." || segment === "..") return 'empty, "." and ".." segments are not allowed';
    if (segment.startsWith(".")) return "dot-folders are Ledge's own and invisible to the note list";
  }
  return null;
}

/**
 * Why `name` is not a usable folder name for a rename, or null when it is
 * fine. This applies every rule in `folderNameProblem` and adds the two a
 * single segment needs: no empty name, and no separator.
 *
 * `folderNameProblem` accepts "" because "" is a usable folder path (it is the
 * root). It is not a folder name, so `folderLeafProblem` rejects it.
 *
 * A rename says what the folder is called, not where it sits. Naming and
 * placing are two different questions, and the UI asks them separately: a name
 * is a field, a parent is a chooser. A `/` in the name field is therefore a
 * typo, not a shorthand. Reading it as a shorthand would silently reparent the
 * folder (bun/notes.ts renameFolder).
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
