// Pure key-event resolution for the window-level command dispatcher.
//
// Bindings use CodeMirror's spelling ("Mod-Shift-w"); Mod is ⌘ (macOS-only
// app). The dispatcher (CommandProvider) turns each keydown into a Chord via
// eventToChord, then resolveChord picks the command whose binding matches and
// whose domains include where focus currently sits.

// "list" is a focused row in a navigable list (the note list, the trash, the
// workspace strip) — the one domain where BARE keys dispatch (`d` deletes,
// Enter opens; docs/interactions.md §2). It sits inside the page chrome, so a
// page-domain command fires there too (see domainMatches): focusing a note row
// must not cost you ⌘N.
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
  // The kind of the row focus sits on, in the list domain. Commands declaring
  // a targetKind only resolve on a matching row, which is what lets `r` mean
  // Rename on a workspace and Restore on a trashed note without ambiguity.
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

// Where the window dispatcher fires a command unless it says otherwise. ⌘
// chords are app-global (they bubble out of the editor and the terminal, whose
// handlers consume the ones they own); Ctrl chords must opt out of "terminal"
// explicitly, because the shell owns Ctrl.
export const DEFAULT_DOMAINS: readonly FocusDomain[] = ["page", "editor", "terminal"];

// A list row is page chrome that happens to be focusable, so anything bound
// for "page" also fires there. Nothing widens the other way: a command that
// only makes sense on a row must say "list" and carry a targetKind.
export function domainMatches(domains: readonly FocusDomain[], domain: FocusDomain): boolean {
  if (domains.includes(domain)) return true;
  return domain === "list" && domains.includes("page");
}

// With Shift held, punctuation arrives as its shifted character ("}" for
// Shift-]), so bindings like Mod-Shift-] would never match on e.key alone.
// e.code names the physical key; map the ones we could plausibly bind back to
// their base character.
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
  if (e.shiftKey && e.code) {
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
// the focus domain. Null while a modal layer is open: menus, dialogs, and the
// palette own the keyboard outright (docs/interactions.md §6).
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
