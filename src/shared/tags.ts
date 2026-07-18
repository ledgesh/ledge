// The pure half of tags: what counts as a `#tag` and where a note's tags
// are. A note carries tags from two sources — the frontmatter `tags:` list
// and inline `#hashtags` in the body — and this module merges them into one
// answer. Shared for the same reason as shared/wikilinks.ts: the view styles
// and completes tags, Bun scans whole roots for them (tag directory, notes
// bearing a tag), and both ends must agree on the grammar or a tag would
// render in the editor and not exist to the scan.
//
// The inline grammar, and why:
// - `#` + one or more of letters (any script), digits, "_", "-", "/". The
//   token must contain at least one letter or "_" (isTagToken): `#123` and
//   `#2024` stay plain text.
// - The `#` must sit at start-of-line or after whitespace. That excludes URL
//   fragments (`…/page#frag`) and `##tag` for free. `# Title` is a heading,
//   never a tag (space after `#`); line-start `#word` IS a tag — CommonMark
//   agrees it is not a heading (shared/slug.ts).
// - Fenced code never carries tags (contentLines, the wikilink scan's own
//   fence walk). Inline `code` spans do — the same accepted sliver of
//   imprecision as wikiRefsOf, not worth a markdown parse Bun-side.
// - Identity is the case-folded spelling (normalizeTag): `#Work` and `#work`
//   are one tag, like wikilink titles. Display spelling is the caller's
//   concern (the directory picks the most frequent one).

import { frontmatterEnd, isTagToken, splitTagList, unquote } from "./frontmatter";
import { contentLines } from "./wikilinks";

/** One tag occurrence in a note, located by 1-based line. `tag` is the
 * spelling as written (no leading "#"); fold with normalizeTag for identity.
 * `raw` is the text exactly as written on the line (`#work`, or a frontmatter
 * token) — reveals re-find it there, so it must be the file's own spelling. */
export interface TagRef {
  tag: string;
  line: number;
  raw: string;
}

/** The case-folded identity of a tag, from either spelling (`#Work`/`Work`). */
export function normalizeTag(raw: string): string {
  return (raw.startsWith("#") ? raw.slice(1) : raw).toLowerCase();
}

/** One tag as a directory lists it: a display spelling and how many NOTES
 * bear it (not occurrences — the directory answers "where does this tag
 * lead", and ten mentions in one note lead one place). */
export interface TagInfo {
  tag: string;
  count: number;
}

/**
 * Aggregate per-note tag refs into the workspace's tag directory,
 * alphabetical. Identity is the case-folded tag; the display spelling is the
 * most frequent one across all occurrences, ties to the first seen (callers
 * pass notes newest-first, so a fresh respelling wins only by outnumbering).
 * Pure and shared: bun/notes.ts tagsIn and the e2e harness fake both compose
 * listNotes + tagRefsOf + this, so their semantics cannot drift.
 */
export function tagDirectoryOf(perNote: { path: string; refs: TagRef[] }[]): TagInfo[] {
  const byTag = new Map<string, { spellings: Map<string, number>; notes: Set<string> }>();
  for (const { path, refs } of perNote) {
    for (const ref of refs) {
      const id = normalizeTag(ref.tag);
      let entry = byTag.get(id);
      if (!entry) byTag.set(id, (entry = { spellings: new Map(), notes: new Set() }));
      entry.spellings.set(ref.tag, (entry.spellings.get(ref.tag) ?? 0) + 1);
      entry.notes.add(path);
    }
  }
  const out: TagInfo[] = [];
  for (const entry of byTag.values()) {
    let display = "";
    let best = -1;
    for (const [spelling, n] of entry.spellings) {
      if (n > best) {
        display = spelling;
        best = n;
      }
    }
    out.push({ tag: display, count: entry.notes.size });
  }
  return out.sort((a, b) => a.tag.localeCompare(b.tag));
}

// The inline grammar in one regex. `(^|\s)` is the boundary rule: a `#` mid-
// word is a fragment or a typo, not a tag. The charset must stay identical to
// isTagToken's — the letter-or-underscore requirement is applied after, by
// isTagToken itself, so the two grammars cannot diverge.
const INLINE_TAG = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;

/** Every inline tag on one line: spelling, 0-based column of the `#`, and the
 * raw `#tag` text. Pure per-line core — the editor's tests and the note-wide
 * scan both build on it. */
export function inlineTagsOfLine(line: string): { tag: string; col: number; raw: string }[] {
  const out: { tag: string; col: number; raw: string }[] = [];
  for (const m of line.matchAll(INLINE_TAG)) {
    const tag = m[2]!;
    if (!isTagToken(tag)) continue;
    out.push({ tag, col: m.index! + m[1]!.length, raw: "#" + tag });
  }
  return out;
}

/**
 * Every tag a note carries, frontmatter first, then body occurrences in line
 * order. Frontmatter refs point at the effective `tags:` line (a repeated
 * line replaces, so the last one is the one that counts) with each token as
 * written; inline refs are per-occurrence, fence-aware. No dedupe across
 * sources — a directory counts notes, an occurrence list wants every hit.
 */
export function tagRefsOf(text: string): TagRef[] {
  const out: TagRef[] = [];
  const lines = text.split("\n");
  const end = frontmatterEnd(text);
  // Lines the block spans = newlines in the head slice; body starts after.
  const bodyStart = end > 0 ? text.slice(0, end).split("\n").length - 1 : 0;

  if (end > 0) {
    // The effective `tags:` line, by the block's own line discipline: top-
    // level (not indented — an indented `tags:` is an env var), not a
    // comment, last one wins. What the line YIELDS is splitTagList's call,
    // the same split parseFrontmatter uses — tags.test.ts holds an invariant
    // test that this walk and parseFrontmatter agree on the result.
    let tagsLine = -1;
    let value = "";
    for (let i = 1; i < bodyStart - 1; i += 1) {
      const line = lines[i]!.replace(/\r$/, "");
      if (/^\s/.test(line)) continue;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const colon = trimmed.indexOf(":");
      if (colon <= 0) continue;
      if (trimmed.slice(0, colon).trim() !== "tags") continue;
      // An empty value costs only itself (parseFrontmatter reports it and
      // keeps the earlier list) — it must not shadow the effective line here.
      const v = unquote(trimmed.slice(colon + 1).trim());
      if (!v) continue;
      tagsLine = i;
      value = v;
    }
    if (tagsLine >= 0) {
      for (const { tag, raw } of splitTagList(value).accepted) {
        out.push({ tag, line: tagsLine + 1, raw });
      }
    }
  }

  const bodyLines = lines.slice(bodyStart);
  for (const { line, i } of contentLines(bodyLines)) {
    for (const t of inlineTagsOfLine(line)) {
      out.push({ tag: t.tag, line: bodyStart + i + 1, raw: t.raw });
    }
  }
  return out;
}
