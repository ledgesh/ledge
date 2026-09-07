// Coarse relative time for the Trash rows' "2d ago" (notes/NoteBrowser.tsx).
// Every step rounds down, so the label never overstates the age: a note
// deleted 23 hours ago reads "23h ago", not "1d ago". The label sits beside
// the panel's "Deleted notes are removed for good after 30 days" line, so
// rounding up would put it ahead of the age the purge counts (bun/notes.ts
// purgeTrash, `trash.ttlDays`, 30 days by default).
export function agoLabel(then: number, now: number): string {
  // The clamp at zero keeps a clock that has gone backwards (NTP, a timezone
  // change, a file copied from a machine running ahead) from rendering
  // "-3h ago".
  const secs = Math.max(0, Math.floor((now - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
