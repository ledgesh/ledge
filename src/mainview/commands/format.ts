// Render key bindings as macOS glyphs, and derive tooltips from the command
// table. Pure: safe to import from anywhere, including non-React editor code
// (blocks.ts, find.ts).
import { COMMANDS, keyOf, titleOf, type CommandId } from "./keys";

const MOD_GLYPHS: Record<string, string> = {
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Mod: "⌘",
};

// Canonical macOS modifier order: ⌃ ⌥ ⇧ ⌘, regardless of the binding's spelling.
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

// "Mod-Shift-w" → "⇧⌘W". The final token is the key; everything before it is a
// modifier. A single-letter key renders uppercase; named keys map to their
// glyph; anything else (digits, F3, `, ], [) renders as-is.
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
// just the title when the command has no key. Never hand-write these — a
// tooltip and a binding maintained separately is how they drift apart.
export function tooltip(id: CommandId, key: string | null = keyOf(id)): string {
  const title = titleOf(id);
  return key ? `${title} (${formatKey(key)})` : title;
}

// The chip shown in menu items and palette rows: the formatted primary key,
// or null when there is nothing to advertise.
export function keyChip(id: CommandId): string | null {
  const key = keyOf(id);
  return key ? formatKey(key) : null;
}

// The same, for a built Command rather than a table id (the palette and
// CommandMenuItem hold commands, including generated ones with no table
// entry). A chord wins over a bare row verb: it works from anywhere, while the
// row verb needs the row focused. "D" for a bare `d` is deliberate — it reads
// as a key, and Ledge has no bare shifted bindings for it to be confused with.
export function chipOf(keys?: readonly string[], listKeys?: readonly string[]): string | null {
  const key = keys?.[0] ?? listKeys?.[0];
  return key ? formatKey(key) : null;
}

// Middle-ellipsis a label that will not fit, keeping BOTH ends: for values
// like `ubuntu@anypost-app-prod-01` the distinguishing part is the tail, and
// the CSS `truncate` end-ellipsis is exactly what eats it. The tail keeps one
// more character than the head for the same reason. Callers pair this with a
// `title` carrying the full value.
export function middleEllipsis(label: string, max: number): string {
  if (label.length <= max) return label;
  const tail = Math.ceil((max - 1) / 2);
  const head = max - 1 - tail;
  return `${label.slice(0, head)}…${label.slice(label.length - tail)}`;
}

export type { CommandId };
export { COMMANDS };
