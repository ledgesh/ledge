// The pure half of tags: what counts as a `#tag`, and where a note's tags
// are. A note carries tags from two sources: the frontmatter `tags:` list and
// inline `#hashtags` in the body. This module merges them into one answer.
// Shared for the same reason as shared/wikilinks.ts: the view styles and
// completes tags, and Bun scans whole roots for them (tag directory, notes
// bearing a tag). Both ends must agree on the grammar, or a tag would render
// in the editor and not exist to the scan.
//
// The inline grammar:
// - `#` then one or more of: letters (any script), digits, "_", "-", "/". The
//   token must contain at least one letter or "_" (isTagToken), so `#123` and
//   `#2024` stay plain text.
// - The `#` sits at start-of-line or after whitespace. That excludes URL
//   fragments (`…/page#frag`) and `##tag`. `# Title` is a heading, never a tag
//   (the space after `#`). A line-start `#word` is a tag: CommonMark does not
//   read it as a heading (shared/slug.ts).
// - Fenced code carries no tags (contentLines, the wikilink scan's own fence
//   walk). Inline `code` spans do carry them. wikiRefsOf accepts the same
//   imprecision, because a markdown parse Bun-side is not worth the cost.
// - Identity is the case-folded spelling (normalizeTag), so `#Work` and
//   `#work` are one tag, as with wikilink titles. The display spelling is the
//   caller's concern (the directory picks the most frequent one).

import { frontmatterEnd, isTagToken, splitTagList, unquote } from "./frontmatter";
import { contentLines } from "./wikilinks";

/** One tag occurrence in a note, located by 1-based line. `tag` is the
 * spelling as written (no leading "#"); fold with normalizeTag for identity.
 * `raw` is the text exactly as written on the line (`#work`, or a frontmatter
 * token). The reveal re-finds the tag by that text, so it must be the file's
 * own spelling. */
export interface TagRef {
  tag: string;
  line: number;
  raw: string;
}

/** The case-folded identity of a tag, from either spelling (`#Work`/`Work`). */
export function normalizeTag(raw: string): string {
  return (raw.startsWith("#") ? raw.slice(1) : raw).toLowerCase();
}

/** One tag as a directory lists it: a display spelling, and the number of
 * notes that bear it. It counts notes, not occurrences: the directory answers
 * "where does this tag lead", and ten mentions in one note lead to one
 * place. */
export interface TagInfo {
  tag: string;
  count: number;
}

/**
 * Aggregate per-note tag refs into the workspace's tag directory, alphabetical.
 * Identity is the case-folded tag; the display spelling is the most frequent
 * one across all occurrences, ties to the first seen (callers pass notes
 * newest-first). Pure and shared: bun/notes.ts tagsIn and the e2e harness fake
 * both compose listNotes + tagRefsOf + this, so their semantics cannot drift.
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

// The inline grammar as a regex. `(^|\s)` is the boundary rule: a `#` mid-word
// is a URL fragment or a typo, not a tag. The charset must stay identical to
// isTagToken's. isTagToken applies the letter-or-underscore requirement
// afterwards, so the two grammars cannot diverge.
const INLINE_TAG = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;

/** Every inline tag on one line: spelling, 0-based column of the `#`, and the
 * raw `#tag` text. Pure per-line core: the editor's tests and the note-wide
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
 * order. Frontmatter refs point at the effective `tags:` line with each token
 * as written (a repeated line replaces, so the last one counts); inline refs
 * are per-occurrence and fence-aware. Nothing is deduped across the two
 * sources: a directory counts notes, an occurrence list wants every hit.
 */
export function tagRefsOf(text: string): TagRef[] {
  const out: TagRef[] = [];
  const lines = text.split("\n");
  const end = frontmatterEnd(text);
  // Lines the block spans = newlines in the head slice; body starts after.
  const bodyStart = end > 0 ? text.slice(0, end).split("\n").length - 1 : 0;

  if (end > 0) {
    // Find the effective `tags:` line by the block's own line discipline:
    // top-level (not indented, since an indented `tags:` is an env var), not a
    // comment, last one wins. splitTagList decides what the line yields, the
    // same split parseFrontmatter uses. tags.test.ts holds an invariant test
    // that this walk and parseFrontmatter agree on the result.
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
      // An empty value must not shadow the effective line. parseFrontmatter
      // reports it and keeps the earlier list, so this walk skips it too.
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
