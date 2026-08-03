// The one predicate for "may this note link leave the app". Lives in shared/
// because both ends need the same answer: the view uses it to decide what is
// ⌘-clickable (and what tooltip to promise), and Bun re-checks it before the
// URL reaches `open` — the view's check is styling, Bun's is the guard
// (architecture.md §2). The distinction is load-bearing: `open` treats a
// non-URL argument as a file path and launches .app bundles, so an
// unvalidated "url" from the least-trusted end would be command execution.
//
// Allowlist, not blocklist: http(s) and mailto are what a note link means.
// Everything else — file:, javascript:, app-registered schemes — is refused,
// even though some would be harmless, because enumerating badness is how
// javascript: sneaks through.

const SCHEMES = new Set(["http", "https", "mailto"]);

// A bare email, the way GFM autolinks one (<dev@example.com> parses to just
// the address). Deliberately crude: it only decides mailto-vs-refuse, and a
// false negative merely makes a link unclickable.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The URL to hand the OS for a note link, or null when the text is not one we
 * open. Normalizes the two schemeless forms markdown produces — `www.` bare
 * links get https, bare emails get mailto — so callers never build URLs
 * themselves.
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
