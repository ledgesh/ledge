// Render key bindings as macOS glyphs, and derive tooltips from the command
// table. Pure: safe to import from anywhere, including non-React editor code
// (editor/blocks.ts, editor/livePreview.ts).
import { COMMANDS, keyOf, titleOf, type CommandId } from "./keys";

const MOD_GLYPHS: Record<string, string> = {
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Mod: "⌘",
};

// Modifiers render in macOS order (⌃ ⌥ ⇧ ⌘), whatever order the binding
// lists them in.
const MOD_ORDER = ["Ctrl", "Alt", "Shift", "Mod"] as const;

const KEY_GLYPHS: Record<string, string> = {
  Enter: "↩",
  Backspace: "⌫",
  Escape: "⎋",
  Tab: "⇥",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  " ": "Space",
};

// "Mod-Shift-w" → "⇧⌘W". The last token is the key, and everything before it
// is a modifier. Three kinds of key:
//   - a single letter, uppercased;
//   - a named key, through the table above (" " gives "Space");
//   - anything else as-is (digits, F3, `, ], [).
export function formatKey(binding: string): string {
  const parts = binding.split("-");
  const key = parts[parts.length - 1] === "" ? "-" : parts.pop()!;
  const mods = MOD_ORDER.filter((m) => parts.includes(m))
    .map((m) => MOD_GLYPHS[m])
    .join("");
  const keyGlyph =
    KEY_GLYPHS[key] ?? (/^[a-z]$/.test(key) ? key.toUpperCase() : key);
  return mods + keyGlyph;
}

// The `title=` string for a control bound to a command: "Close Tab (⌘W)", or
// just the title when the command has no key. A control that runs a command
// must not carry a hand-written tooltip (interactions.md §5): a tooltip and a
// binding that are maintained separately drift apart.
export function tooltip(id: CommandId, key: string | null = keyOf(id)): string {
  const title = titleOf(id);
  return key ? `${title} (${formatKey(key)})` : title;
}

// The chip shown in menu items and palette rows: the formatted primary key,
// or null when the command has no binding.
export function keyChip(id: CommandId): string | null {
  const key = keyOf(id);
  return key ? formatKey(key) : null;
}

// The chip for a built Command rather than a table id, since the palette and
// CommandMenuItem hold commands that were generated and have no COMMANDS
// entry. A chord wins over a bare row verb: the chord works from anywhere,
// while the row verb needs the row focused. A bare `d` renders as "D", which
// reads as a key. No row verb is shifted, so "D" cannot be read as ⇧D.
export function chipOf(keys?: readonly string[], listKeys?: readonly string[]): string | null {
  const key = keys?.[0] ?? listKeys?.[0];
  return key ? formatKey(key) : null;
}

// Shorten a label to `max` characters by eliding the middle, keeping both
// ends. A label that already fits comes back unchanged. The tail is what
// tells `ubuntu@anypost-app-prod-01` from `-02`, and CSS `truncate` would
// cut it. The tail keeps one character more than the head for that reason.
// Callers pass the full value as `title` (components/HostPicker.tsx).
export function middleEllipsis(label: string, max: number): string {
  if (label.length <= max) return label;
  const tail = Math.ceil((max - 1) / 2);
  const head = max - 1 - tail;
  return `${label.slice(0, head)}…${label.slice(label.length - tail)}`;
}

export type { CommandId };
export { COMMANDS };
