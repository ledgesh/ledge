// Coarse relative time, for the Trash section's "deleted 2d ago".
//
// Rounds DOWN at every step, so the label is a floor and never overstates: a
// note deleted 23 hours ago reads "23h ago", not "1d ago". That matters here
// because the number next to it is the one the 30-day eviction counts against,
// and a label that rounds up would quietly age a note faster than it really is.
export function agoLabel(then: number, now: number): string {
  // A clock that has gone backwards (NTP, a timezone change, a file copied from
  // a machine running ahead) must not render "-3h ago".
  const secs = Math.max(0, Math.floor((now - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
