// Daily notes and template instantiation: the policy layer over the note
// store, where notes.ts owns the files and applies its guards. This module
// owns the local-date title, the create-or-open idempotency, what a template
// name or the `template: daily` role resolves to, and the daily.workspace
// fallback. The MCP daily_note tool, the CLI `today` verb (through that
// tool), and the app's dailyOpen RPC all call into this module, so the three
// surfaces share one definition.
import { homedir } from "node:os";
import type { NoteMeta } from "../shared/rpc-schema";
import { instantiateTemplate, isoDateOf } from "../shared/template";
import { resolveWikiTitle } from "../shared/wikilinks";
import { createNote, listNotes, readNote } from "./notes";
import { assertRegisteredRoot, availableRoots, workspaceMatches } from "./workspaces";

// The daily.workspace setting resolved to a registered root, or null for
// "use the caller's own fallback": the selected workspace in the app, cwd
// deixis at the CLI. Null covers an unset value (""). With a warning, it
// also covers a value that names nothing or several roots. A stale
// `daily.workspace` must fall back the way a bad settings.jsonc field does,
// never strand ⌘J behind an error.
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

// A template note's current text, found by title. Templates are ordinary
// notes, so this is wikilink resolution: the preferred root first (a
// workspace's own "Meeting" template outranks another's), then the other
// available roots merged newest-first. mcpTools.locate gives a bare title
// the same precedence. Null when no note bears the title, or when it
// vanished between the listing and the read (a race costing this call only).
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

// Refuse a locked note as a template source: its body would be stamped into
// a new, unlocked note, writing the decrypted text back out in the clear
// (locking.md §2 makes `template:` and `locked:` exclusive). templateText
// checks readNote's result, so it catches any locked note named as a
// template, on the MCP and CLI paths too. It throws rather than falling
// through to a same-titled note elsewhere, which would instantiate something
// the caller did not point at.
function templateText(file: { text: string; locked?: true }, title: string): string {
  if (file.locked) throw new Error(`"${title}" is locked and cannot be used as a template; remove its lock first`);
  return file.text;
}

// Instantiate a template into a new note in `root`, or in `folder` inside it
// when one is named (create_note's placement argument, validated by
// ensureFolder like every other). The caller names the template by title
// (create_note's `template`, `ledge new --template`), and a title matching
// no note throws rather than quietly creating a bare note. Any note's title
// works: the `template: true` marker is discovery, putting a note in the
// ⌥⌘N picker, not permission (architecture.md §1). A null `title` means
// "Untitled". Editing the H1 is how Ledge renames a note, so Ledge should
// not grow a title-prompt dialog, and untitled.md enumerates like any other
// name collision.
export async function createFromTemplate(
  root: string,
  templateTitle: string,
  title: string | null,
  folder: string | null = null,
  now: Date = new Date(),
): Promise<NoteMeta> {
  const r = assertRegisteredRoot(root);
  const template = await findTemplate(templateTitle, r);
  if (!template) throw new Error(`no note titled "${templateTitle}" to use as a template`);
  return createNote(r, instantiateTemplate(template.text, title ?? "Untitled", now), folder);
}

// The same, from a path: the app's noteFromTemplate RPC. The ⌥⌘N picker
// rows come from the view's live note lists, so the pick names a concrete
// file, and resolving its title again could land on a same-named note in
// another workspace. readNote applies the store's path guards. A template
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

// The note ⌘J instantiates: the one in this root whose frontmatter claims
// the role with `template: daily`. A corpus marker, not a settings knob (the
// retired `daily.template` named a note by title and went stale on rename;
// the marker travels with the note). Resolution is strictly per-workspace,
// unlike findTemplate's cross-root precedence: a daily note appears without
// being asked for, and a template in a workspace nobody is looking at would
// silently shape it. A root with no claimant returns null and openDaily
// writes the bare dated note. Several claimants in one root resolve
// newest-first, with a warning.
export async function findDailyTemplate(root: string): Promise<{ path: string; text: string } | null> {
  const r = assertRegisteredRoot(root);
  // A locked claimant is hand-crafted: the commands enforce the marker
  // exclusivity. It cannot seed a daily note, so it does not claim the role,
  // neither winning nor counting toward the warning below.
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

// Create-or-open today's note in `root`, titled with the local calendar date
// (isoDateOf, so an 11pm note is today's) and matched case-insensitively the
// way a [[2026-07-18]] wikilink resolves. openDaily creates a missing note
// from the root's `template: daily` note (findDailyTemplate above), bare
// otherwise. It reads no settings: the template is a corpus fact, so marking
// a note takes effect live with no restart. Idempotent per day within one
// process. Two processes racing the same first open (the app and the CLI in
// the same second) can still mint a -2, because createNote's reserved-names
// guard is in-process. Ledge accepts that rather than taking a store lock
// nothing else needs, and a second ⌘J does not reproduce the race.
export async function openDaily(
  root: string,
  folder: string | null = null,
  now: Date = new Date(),
): Promise<{ meta: NoteMeta; created: boolean }> {
  const r = assertRegisteredRoot(root);
  const title = isoDateOf(now);
  // Resolution is workspace-wide, and `folder` only says where a new note
  // lands. Whoever opens today's note first decides where it lives, and
  // everyone else finds it there: ⌘J after an agent filed today's note in
  // `journal/` opens that one rather than minting a second at the root.
  const existing = resolveWikiTitle(title, await listNotes(r));
  if (existing) return { meta: existing, created: false };
  const template = await findDailyTemplate(r);
  const text = template ? instantiateTemplate(template.text, title, now) : `# ${title}\n`;
  return { meta: await createNote(r, text, folder), created: true };
}
