// The one predicate for "may this note link leave the app". It lives in
// shared/ because both ends must give the same answer. The view uses it to
// decide what is ⌘-clickable, and what the tooltip promises. Bun re-checks
// it before the URL reaches `open`: the view's check is styling, Bun's is
// the guard (architecture.md §2). `open` launches .app bundles and treats a
// non-URL argument as a file path, so an unvalidated "url" from the
// least-trusted end would be arbitrary command execution.

// Allowlist, not blocklist. http(s) and mailto are what a note link means.
// Everything else is refused (file:, javascript:, app-registered schemes),
// even ones that would be harmless. Listing the bad ones instead is how
// javascript: gets through.
const SCHEMES = new Set(["http", "https", "mailto"]);

// A bare email, the way GFM autolinks one (<dev@example.com> parses to just
// the address). The pattern does not need to be exact: it only says mailto
// or no. A false negative just makes a link unclickable.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Returns the URL to hand the OS for a note link, or null when Ledge will
 * not open the text. Normalizes the two schemeless forms markdown produces:
 * bare `www.` links get https, bare emails get mailto. Callers take the URL
 * from here and never build one themselves.
 */
export function openableUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return null;
  // Scheme first: "mailto:a@b.c" must not read as a bare email and get a
  // second mailto stacked on top.
  const m = /^([a-z][a-z0-9+.-]*):(.+)$/i.exec(text);
  if (m) return SCHEMES.has(m[1]!.toLowerCase()) ? text : null;
  if (/^www\./i.test(text)) return `https://${text}`;
  if (EMAIL.test(text)) return `mailto:${text}`;
  return null;
}
