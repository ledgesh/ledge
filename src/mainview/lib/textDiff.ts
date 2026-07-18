// The minimal single-span difference between two texts: what the external
// reload dispatches when a note's file changed under a clean buffer
// (workspace/editorPool.ts reloadOpenNotes). A full-document replace would be
// textually identical but positionally destructive: every mapped position —
// run-output anchors (editor/blocks.ts runsField), the caret — collapses to
// the document's edges, which is how an agent appending to a note used to
// teleport the block's output panel below the appended text. Trimming the
// common prefix and suffix leaves the one span that really changed, so every
// position outside it simply does not move.
export interface TextSpan {
  from: number;
  to: number;
  insert: string;
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c < 0xdc00;
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c < 0xe000;
}

/** The span of `a` to replace with `insert` to obtain `b`; null when equal. */
export function changedSpan(a: string, b: string): TextSpan | null {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let from = 0;
  while (from < max && a.charCodeAt(from) === b.charCodeAt(from)) from += 1;
  let suffix = 0;
  while (suffix < max - from && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) {
    suffix += 1;
  }
  // Never split a surrogate pair: retreat a boundary that landed between the
  // halves so the span holds whole characters. Growing the span is always
  // safe — it makes the change less minimal, never wrong.
  if (from > 0 && isHighSurrogate(a.charCodeAt(from - 1))) from -= 1;
  if (suffix > 0 && isLowSurrogate(a.charCodeAt(a.length - suffix))) suffix -= 1;
  return { from, to: a.length - suffix, insert: b.slice(from, b.length - suffix) };
}
