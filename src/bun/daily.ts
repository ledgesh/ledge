// Daily notes and template instantiation: the policy layer over the note
// store. notes.ts owns the files; this module owns what "today's note" and
// "a note from that template" MEAN — the local-date title, the create-or-open
// idempotency, which note a template name (or the `template: daily` role)
// resolves to, and how the daily.workspace setting degrades. It sits beside
// openRequest.ts in the architecture: called by the MCP daily_note tool, the
// CLI `today` verb (through that tool), and the app's dailyOpen RPC, so all
// three surfaces share one definition and every store guard still applies.
import { homedir } from "node:os";
import type { NoteMeta } from "../shared/rpc-schema";
import { instantiateTemplate, isoDateOf } from "../shared/template";
import { resolveWikiTitle } from "../shared/wikilinks";
import { createNote, listNotes, readNote } from "./notes";
import { assertRegisteredRoot, availableRoots, workspaceMatches } from "./workspaces";

// The daily.workspace setting resolved to a registered root, or null for
// "use the caller's own fallback" — the selected workspace in the app, cwd
// deixis at the CLI. Null covers unset ("") and, warned, a value that names
// nothing or several roots: a stale knob must degrade the way a bad
// settings.jsonc field does, never strand ⌘J behind an error.
export function resolveConfiguredWorkspace(
  setting: string,
  registered: readonly string[],
  home: string = homedir(),
): string | null {
  const value = setting.trim();
  if (!value) return null;
  const matches = workspaceMatches(value, registered, home);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    console.warn(`[daily] daily.workspace "${value}" names several workspaces (${matches.join(", ")}); falling back`);
  } else {
    console.warn(`[daily] daily.workspace "${value}" is not a registered workspace; falling back`);
  }
  return null;
}

// A template note's current text, found by TITLE — templates are ordinary
// notes, so this is wikilink resolution: the preferred root first (a
// workspace's own "Meeting" template outranks another's), then the remaining
// available roots merged newest-first, the same precedence mcpTools.locate
// gives a bare title. Null when no note bears the title (or it vanished
// between list and read — a race that costs this call only).
export async function findTemplate(
  title: string,
  preferredRoot: string,
): Promise<{ path: string; text: string } | null> {
  const pref = assertRegisteredRoot(preferredRoot);
  const local = resolveWikiTitle(title, await listNotes(pref));
  if (local) {
    const file = await readNote(local.path);
    if (file) return { path: local.path, text: templateText(file, title) };
  }
  const others = availableRoots().filter((r) => r !== pref);
  const metas = (await Promise.all(others.map((r) => listNotes(r)))).flat();
  metas.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const hit = resolveWikiTitle(title, metas);
  if (!hit) return null;
  const file = await readNote(hit.path);
  return file ? { path: hit.path, text: templateText(file, title) } : null;
}

// A template's body is about to be stamped into a NEW, unlocked note — the
// exact opposite of a locked one (docs/locking.md §2's exclusivity, enforced
// where the read happens so hand-crafted marker combinations cannot slip
// through the MCP/CLI template path either). Throwing, not skipping: the
// caller named this note, and a silent fall-through to a same-titled note
// elsewhere would instantiate something they did not point at.
function templateText(file: { text: string; locked?: true }, title: string): string {
  if (file.locked) throw new Error(`"${title}" is locked and cannot be used as a template; remove its lock first`);
  return file.text;
}

// Instantiate a template into a NEW note in `root`. The template was asked
// for by name (create_note's `template`, `ledge new --template`), so a
// name that resolves to nothing throws rather
// than quietly creating a bare note. Deliberately, the note need NOT carry
// the `template: true` marker: the marker is discovery (it puts a note in
// the ⌥⌘N picker), not permission — a note you can name, you can
// instantiate. A null `title` means "Untitled": there is no title-prompt
// dialog and none should be built — editing the H1 IS the rename UI, and
// untitled.md enumerates like any other collision.
export async function createFromTemplate(
  root: string,
  templateTitle: string,
  title: string | null,
  now: Date = new Date(),
): Promise<NoteMeta> {
  const r = assertRegisteredRoot(root);
  const template = await findTemplate(templateTitle, r);
  if (!template) throw new Error(`no note titled "${templateTitle}" to use as a template`);
  return createNote(r, instantiateTemplate(template.text, title ?? "Untitled", now));
}

// The same, from a PATH — the app's noteFromTemplate RPC: the ⌥⌘N picker
// rows come from the view's live note lists, so the pick names a concrete
// file, and resolving its title again could land on a same-named note in
// another workspace. readNote applies the store's path guards; a template
// deleted between render and pick throws rather than instantiating nothing.
export async function createFromTemplatePath(
  root: string,
  templatePath: string,
  title: string | null,
  now: Date = new Date(),
): Promise<NoteMeta> {
  const r = assertRegisteredRoot(root);
  const file = await readNote(templatePath);
  if (!file) throw new Error(`the template note is gone (${templatePath}); pick again`);
  if (file.locked) throw new Error("a locked note cannot be used as a template; remove its lock first");
  return createNote(r, instantiateTemplate(file.text, title ?? "Untitled", now));
}

// The note ⌘J instantiates: the one IN THIS ROOT whose frontmatter claims
// the role — `template: daily`. A corpus marker, not a settings knob (the
// retired `daily.template` named a note by TITLE and went stale on rename;
// the marker travels with the note). Strictly per-workspace, unlike
// findTemplate's cross-root precedence: a daily note materializes unasked,
// so borrowing another workspace's template would be action at a distance —
// a workspace with no claimant gets the bare dated note instead. Within the
// root several claimants resolve newest-first, warned: the degradation
// stance of every daily fact.
export async function findDailyTemplate(root: string): Promise<{ path: string; text: string } | null> {
  const r = assertRegisteredRoot(root);
  // A locked claimant is a hand-crafted file (the commands enforce the
  // marker exclusivity); it cannot seed a daily note, so it does not claim.
  const marked = (await listNotes(r)).filter((m) => m.template === "daily" && !m.locked);
  if (marked.length === 0) return null;
  if (marked.length > 1) {
    console.warn(
      `[daily] ${marked.length} notes claim template: daily; using the newest ("${marked[0]!.title}")`,
    );
  }
  const file = await readNote(marked[0]!.path);
  return file ? { path: marked[0]!.path, text: file.text } : null;
}

// Create-or-open today's note in `root`: titled with the LOCAL calendar date
// (isoDateOf — an 11pm note is today's), resolved case-insensitively the way
// a [[2026-07-18]] wikilink would be, created from the `template: daily`
// note when one exists (findDailyTemplate above), bare otherwise. No
// settings involved: the template is a corpus fact, so a marked note is
// picked up live, no restart. Idempotent per day for one process; two
// PROCESSES racing the same first-open (app and CLI in the same second) can
// still mint a -2 — the reserved-names guard in createNote is in-process,
// and closing the window cross-process would need locking the store nowhere
// else needs. Accepted: the collision needs a same-second race that a
// second ⌘J cannot reproduce.
export async function openDaily(
  root: string,
  now: Date = new Date(),
): Promise<{ meta: NoteMeta; created: boolean }> {
  const r = assertRegisteredRoot(root);
  const title = isoDateOf(now);
  const existing = resolveWikiTitle(title, await listNotes(r));
  if (existing) return { meta: existing, created: false };
  const template = await findDailyTemplate(r);
  const text = template ? instantiateTemplate(template.text, title, now) : `# ${title}\n`;
  return { meta: await createNote(r, text), created: true };
}
