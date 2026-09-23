// Which key "Mod" is on this client: ⌘ on a Mac and a phone, Ctrl everywhere
// else. Every binding in keys.ts is spelled with Mod, and this is the one
// place the spelling meets a keyboard. The dispatcher (keymap.ts), the chip
// formatter (format.ts) and the held-modifier badges all read it, and
// CodeMirror resolves the same Mod the same way from navigator.platform, so
// the editor's chords and the window's agree by construction (interactions.md
// §2).
//
// Read from navigator.platform at load rather than set by the entry point,
// unlike the configureX seams (lib/shell.ts): modules spell chords into
// constants as they load (a link's tooltip, the frontmatter completions), and
// an entry point's body runs only after every import has. Only a page reads
// it: Bun has a navigator too, and the unit suite runs the Mac grammar on
// every host, with the tests that want Ctrl saying so. The harness overrides
// it to run the Ctrl grammar in headless WebKit. No imports, since keys.ts
// imports this and keys.ts imports nothing from app code.

export type ModKey = "Meta" | "Ctrl";

let current: ModKey = typeof document === "undefined" ? "Meta" : modKeyFor(navigator.platform);

export function configureModKey(key: ModKey): void {
  current = key;
}

export function modKey(): ModKey {
  return current;
}

// The Mod key for a navigator.platform string: the fact CodeMirror's
// `browser.mac` reads, so the editor and the window dispatcher cannot
// disagree about which key a "Mod-" binding means. iPadOS can report
// "MacIntel", which lands on the same answer.
export function modKeyFor(platform: string): ModKey {
  return /Mac|iP(hone|[oa]d)/.test(platform) ? "Meta" : "Ctrl";
}
