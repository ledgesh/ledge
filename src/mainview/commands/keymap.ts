// Pure key-event resolution for the window-level command dispatcher.
//
// Bindings use CodeMirror's spelling ("Mod-Shift-w"); Mod is ⌘ (macOS-only
// app). The dispatcher (CommandProvider) turns each keydown into a Chord via
// eventToChord, then resolveChord picks the command whose binding matches and
// whose domains include where focus currently sits.

// "list" is a focused row in a navigable list: the note list, the trash, the
// workspace strip. It is the one domain where the resolver dispatches on
// unmodified keys (`d` deletes, Enter opens; interactions.md §2). A row sits
// inside the page chrome, so domainMatches below widens "page" to cover it.
// Focusing a note row does not disable ⌘N.
export type FocusDomain = "page" | "editor" | "terminal" | "list";

export interface Chord {
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface ContextFlags {
  domain: FocusDomain;
  modalOpen: boolean;
  // The kind of the row focus sits on, in the list domain. A command that
  // declares a targetKind resolves only on a matching row. That is how `r`
  // means Rename on a workspace row and Restore on a trashed note.
  targetKind?: string;
}

// The subset of a Command the resolver needs; the full type lives in types.ts.
export interface KeyedCommand {
  keys?: readonly string[];
  // Bare (unmodified) keys, honored only on a focused list row.
  listKeys?: readonly string[];
  domains?: readonly FocusDomain[];
  targetKind?: string;
}

// A command that names no domains of its own fires in these three. ⌘ chords
// are app-global: they bubble out of the editor and the terminal, whose
// handlers consume the ones they own. A Ctrl chord must opt out of "terminal"
// explicitly. The shell owns Ctrl there (interactions.md §2).
export const DEFAULT_DOMAINS: readonly FocusDomain[] = ["page", "editor", "terminal"];

// A list row is focusable page chrome, so a command bound for "page" fires
// there too. Nothing widens the other way: naming "list" in domains does not
// reach page focus. A row's own verbs are bare keys in listKeys instead
// (interactions.md §2), each with a targetKind that registry.test.ts checks.
export function domainMatches(domains: readonly FocusDomain[], domain: FocusDomain): boolean {
  if (domains.includes(domain)) return true;
  return domain === "list" && domains.includes("page");
}

// Base characters for the punctuation keys, keyed by e.code. The table covers
// the keys a binding could plausibly use, so a new punctuation binding may
// need a row added. With Shift held, punctuation arrives as its shifted
// character ("}" for Shift-]), and macOS Option can transform it too ("≤" for
// ⌥-,). Bindings like Mod-Shift-] and Alt-Mod-, would never match on e.key
// alone. eventToChord reads e.code (the physical key) and maps it back here.
const CODE_BASE: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Semicolon: ";",
  Quote: "'",
  Backslash: "\\",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

export function eventToChord(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & { code?: string },
): Chord {
  let key = e.key;
  // Shifted letters arrive uppercase; bindings store lowercase.
  if (/^[A-Z]$/.test(key)) key = key.toLowerCase();
  if ((e.shiftKey || e.altKey) && e.code) {
    const base = CODE_BASE[e.code];
    if (base) key = base;
    // Shift+digit arrives as the symbol ("!" for 1); recover the digit.
    else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  }
  return { key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
}

// "Mod-Shift-w" → its Chord. The last token is the key, the rest modifiers.
export function parseKey(binding: string): Chord {
  const parts = binding.split("-");
  // A trailing empty token means the key itself was "-" ("Mod--").
  const key = parts[parts.length - 1] === "" ? "-" : parts.pop()!;
  return {
    key: /^[A-Z]$/.test(key) ? key.toLowerCase() : key,
    meta: parts.includes("Mod") || parts.includes("Meta"),
    ctrl: parts.includes("Ctrl"),
    alt: parts.includes("Alt"),
    shift: parts.includes("Shift"),
  };
}

export function matchesKey(binding: string, chord: Chord): boolean {
  const b = parseKey(binding);
  return (
    b.key === chord.key &&
    b.meta === chord.meta &&
    b.ctrl === chord.ctrl &&
    b.alt === chord.alt &&
    b.shift === chord.shift
  );
}

// The first command whose binding matches the chord and whose domains include
// the focus domain. Null while a modal layer is open (a menu, a dialog, or an
// overlay): the window dispatcher is suppressed there (interactions.md §6).
export function resolveChord<T extends KeyedCommand>(
  commands: readonly T[],
  chord: Chord,
  flags: ContextFlags,
): T | null {
  if (flags.modalOpen) return null;
  const bare = !chord.meta && !chord.ctrl && !chord.alt;
  // Bare keys (no ⌘/⌃/⌥) are typing everywhere except on a focused list row,
  // where they are the row's verbs. Shift alone doesn't make a chord either.
  if (bare && flags.domain !== "list") return null;
  for (const cmd of commands) {
    // A row verb only resolves on the kind of row it acts on.
    if (cmd.targetKind && cmd.targetKind !== flags.targetKind) continue;
    if (bare) {
      if (cmd.listKeys?.some((k) => matchesKey(k, chord))) return cmd;
      continue;
    }
    if (!cmd.keys?.length) continue;
    if (!domainMatches(cmd.domains ?? DEFAULT_DOMAINS, flags.domain)) continue;
    if (cmd.keys.some((k) => matchesKey(k, chord))) return cmd;
  }
  return null;
}
