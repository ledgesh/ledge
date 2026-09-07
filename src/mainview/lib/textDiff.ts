// The smallest single span that turns one text into another. The reload
// dispatches one when a note's file changed under a clean buffer
// (workspace/editorPool.ts reloadOpenNotes). The comment on that dispatch
// says why a full-document replace is wrong. Trimming the common prefix and
// suffix leaves the one span that changed, so no position outside it moves.
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
  // Never split a surrogate pair: a boundary that landed between the halves
  // is pulled back so the span holds whole characters. A larger span is still
  // correct, only less minimal.
  if (from > 0 && isHighSurrogate(a.charCodeAt(from - 1))) from -= 1;
  if (suffix > 0 && isLowSurrogate(a.charCodeAt(a.length - suffix))) suffix -= 1;
  return { from, to: a.length - suffix, insert: b.slice(from, b.length - suffix) };
}
