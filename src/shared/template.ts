// Template instantiation: {{token}} substitution plus H1 forcing.
//
// Shared because both ends need it and they must agree: Bun instantiates
// templates when a note is created (daily notes, create_note, `ledge new
// --template`), and the harness's fake store must produce the same bytes for
// the e2e specs to mean anything. Pure over (text, title, now) — the caller
// supplies the clock — so the whole grammar is specifiable by its tests.
//
// The vocabulary is deliberately a closed set of five words, not a scripting
// language: the dynamic tier of a template is a prompt fence in its body,
// which this module passes through (substituted, but never run). Unknown
// tokens survive verbatim — degradation over failure, the frontmatter.ts
// stance — which is also why there is no escape syntax: a template that needs
// a literal "{{date}}" is a corner not worth a grammar.

import { frontmatterEnd, parseFrontmatter } from "./frontmatter";
import { headingOf } from "./slug";

/** What a template may interpolate. The clock comes from the caller. */
export interface TemplateVars {
  title: string;
  now: Date;
}

// Local calendar date, YYYY-MM-DD. Deliberately NOT toISOString().slice(0,10)
// (the assets.ts pasted-image spelling): that is UTC, and a daily note started
// at 11pm must be today's, not tomorrow's. The two idioms coexist on purpose —
// an asset name only has to be unique, a daily title has to be *right*.
export function isoDateOf(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local wall-clock time, 24h HH:MM. */
export function timeOf(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Adjacent calendar days via the Date constructor, not string math: month and
// year rollover (and the DST days that are 23 or 25 hours long) are its
// problem, not ours.
function shiftDay(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

const TOKEN = /\{\{\s*([a-z]+)\s*\}\}/gi;

/**
 * Replace the known {{tokens}} — date, time, title, yesterday, tomorrow —
 * everywhere in the text, fence bodies included: a prompt fence saying
 * "Summarize [[{{yesterday}}]]" is exactly what templates are for. Unknown
 * tokens are returned verbatim, so a fence containing unrelated {{x}} (or
 * shell ${...}) is untouched.
 */
export function renderTemplate(text: string, vars: TemplateVars): string {
  const values: Record<string, string> = {
    date: isoDateOf(vars.now),
    time: timeOf(vars.now),
    title: vars.title,
    yesterday: isoDateOf(shiftDay(vars.now, -1)),
    tomorrow: isoDateOf(shiftDay(vars.now, 1)),
  };
  return text.replace(TOKEN, (match, word: string) => values[word.toLowerCase()] ?? match);
}

/**
 * Make the text's H1 be `# <title>`: replace the line headingOf would take the
 * title from, or insert one after the frontmatter block when there is none.
 *
 * This is load-bearing, not cosmetic: a template's own H1 is its title
 * ("Daily Template"), and without the force every instance would inherit it —
 * slug-colliding into daily-template-2.md, and never resolvable by the date
 * title the daily feature promises. A template whose H1 is already the target
 * (e.g. it wrote "# {{title}}" and renderTemplate ran first) is left alone.
 */
export function forceTitle(text: string, title: string): string {
  const heading = headingOf(text);
  if (heading === title) return text;
  const start = frontmatterEnd(text);
  if (heading === null) {
    // No H1 to replace: insert one where headingOf will find it, keeping the
    // conventional blank line between fence/heading and body.
    const body = text.slice(start);
    const sep = body.startsWith("\n") || body === "" ? "\n" : "\n\n";
    return `${text.slice(0, start)}# ${title}${sep}${body}`;
  }
  // Replace exactly the line headingOf reads: the first content line after the
  // frontmatter block, past the blank lines it skips there.
  const gap = start === 0 ? 0 : (/^(?:[ \t]*\r?\n)+/.exec(text.slice(start))?.[0].length ?? 0);
  const lineStart = start + gap;
  const nl = text.indexOf("\n", lineStart);
  const lineEnd = nl === -1 ? text.length : nl;
  return `${text.slice(0, lineStart)}# ${title}${text.slice(lineEnd)}`;
}

// The line that marks a note as a template, as frontmatter.ts accepts it: a
// top-level `template: ...` inside the block. Only unindented lines qualify —
// an indented `template:` is an env var under `env:`, and stripping it would
// change what the note's shells are born with.
const MARKER = /^template\s*:/;

/**
 * Remove the note's `template:` frontmatter line, whatever its value. Every
 * instantiation runs this: the marker means "offer me in the template picker",
 * and without the strip every instance would inherit it and the picker would
 * fill with copies. A block emptied by the strip loses its fences too; one
 * that still says anything else (cwd, tags, even a comment) keeps them.
 */
export function stripTemplateMarker(text: string): string {
  const end = frontmatterEnd(text);
  if (end === 0) return text;
  const openLen = text.indexOf("\n") + 1;
  const inner = text.slice(openLen, end).replace(/\r?\n?---[ \t]*\r?\n?$/, "");
  const lines = inner.split("\n");
  const kept = lines.filter((line) => /^\s/.test(line) || !MARKER.test(line));
  if (kept.length === lines.length) return text;
  if (kept.every((line) => line.trim() === "")) return text.slice(end);
  return `${text.slice(0, openLen)}${kept.join("\n")}\n---\n${text.slice(end)}`;
}

/**
 * Declare (or undeclare) the note as a template: the view's "Make This Note a
 * Template" verb. Off is exactly the instantiation strip; on appends the line
 * at the end of the block — where it cannot split the `env:` map — creating
 * the block when the note has none. On is idempotent: a note already marked
 * comes back unchanged.
 */
export function setTemplateMarker(text: string, on: boolean): string {
  if (!on) return stripTemplateMarker(text);
  if (parseFrontmatter(text).params.template) return text;
  const stripped = stripTemplateMarker(text); // replace a `template: false` line, not join it
  const end = frontmatterEnd(stripped);
  if (end === 0) return `---\ntemplate: true\n---\n${stripped}`;
  const close = stripped.lastIndexOf("---", end - 1);
  return `${stripped.slice(0, close)}template: true\n${stripped.slice(close)}`;
}

/**
 * The one entry instantiators use: drop the template marker, substitute, then
 * force the H1. The result is what createNote receives, so the note's
 * filename comes out of the same H1-slug flow as every other note.
 */
export function instantiateTemplate(text: string, title: string, now: Date): string {
  return forceTitle(renderTemplate(stripTemplateMarker(text), { title, now }), title);
}
