// The `keys` setting, resolved against the command table: which chords each
// command ends up with, and what the file got wrong (interactions.md §2a).
// Pure, so the launch (boot.tsx) and the settings dialog's live preview
// (components/SettingsEditor.tsx) read one answer.
import { COMMANDS, configureKeys, defaultKeysOf, tabSelectKey, takesChord, workspaceSelectKey, type CommandId } from "./keys";
import { FUNCTION_KEY, chordId } from "./keymap";
import { roleChords } from "./menu";
import { modKey } from "./modKey";

export interface ResolvedKeys {
  // Every command whose chords differ from the ones it ships with: the ones
  // the setting named, and the default holders of a chord it gave away.
  changed: Partial<Record<CommandId, readonly string[]>>;
  // The commands the setting named and whose entry was usable.
  bound: CommandId[];
  problems: string[];
}

// Modifier spellings a person might write, to the table's own.
const MODIFIERS: Record<string, string> = {
  mod: "Mod",
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  option: "Alt",
  opt: "Alt",
  shift: "Shift",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  super: "Meta",
  win: "Meta",
};

// The order a normalized chord lists its modifiers in, which is keys.ts's.
const ORDER = ["Ctrl", "Alt", "Mod", "Meta", "Shift"];

// Named keys, lowercased, to the name a key event reports.
const NAMED: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  backspace: "Backspace",
  delete: "Delete",
  tab: "Tab",
  space: "Space",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  insert: "Insert",
};

// Characters a US keyboard types with Shift held. A key event reports the
// unshifted key for a chord (keymap.ts eventToChord), so a binding spelled
// with one of these would never match.
const SHIFTED = '~!@#$%^&*()_+{}|:"<>?';

/**
 * One chord as the file wrote it, in the table's spelling, or why it cannot
 * be one. Accepts "+" as well as "-" between the parts, since the app prints
 * "Ctrl+Shift+W" on a Ctrl desktop and that is what gets copied.
 */
export function normalizeChord(text: string): { chord: string } | { problem: string } {
  const raw = text.trim();
  if (raw === "") return { problem: "is empty" };
  // A trailing separator is the key itself: "Mod--" is Mod with the - key.
  const cut = /[-+]$/.test(raw) ? raw.length - 1 : Math.max(raw.lastIndexOf("-"), raw.lastIndexOf("+")) + 1;
  const keyText = raw.slice(cut);
  const head = raw.slice(0, cut);
  if (head !== "" && !/[-+]$/.test(head)) return { problem: "is not a chord" };
  const parts = head === "" ? [] : head.slice(0, -1).split(/[-+]/);

  const mods = new Set<string>();
  for (const part of parts) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (!mod) return { problem: `has "${part}" where a modifier goes (Mod, Ctrl, Alt, Shift or Meta)` };
    mods.add(mod);
  }

  let key: string;
  if ([...keyText].length === 1) {
    if (SHIFTED.includes(keyText)) return { problem: `names a shifted character: write Shift and the key it is on` };
    key = keyText.toLowerCase();
  } else if (FUNCTION_KEY.test(keyText.toUpperCase())) {
    key = keyText.toUpperCase();
  } else if (/^esc(ape)?$/i.test(keyText)) {
    return { problem: "uses Escape, which always closes or leaves what is in front" };
  } else {
    const named = NAMED[keyText.toLowerCase()];
    if (!named) return { problem: `has "${keyText}" where a key goes` };
    key = named;
  }

  const held = mods.has("Mod") || mods.has("Ctrl") || mods.has("Meta");
  if (!held && !mods.has("Alt") && !FUNCTION_KEY.test(key)) {
    return { problem: "needs Mod, Ctrl or Alt: without one the key is typing" };
  }
  // ⌥ with a character key types another character on a Mac (⌥D is ∂), and
  // that character is what the key event reports.
  if (!held && modKey() === "Meta" && (key.length === 1 || key === "Space")) {
    return { problem: "types a character on a Mac: add Mod or Ctrl" };
  }
  return { chord: [...ORDER.filter((m) => mods.has(m)), key].join("-") };
}

// Chords no entry can take, each with what holds it: the indexed jumps, which
// are generated per slot and have no id to rebind, and on a Mac the menu
// bar's role items, which AppKit answers before the view sees the key.
function reserved(): Map<string, string> {
  const out = new Map<string, string>();
  for (let n = 1; n <= 9; n += 1) {
    out.set(chordId(workspaceSelectKey(n)), `Switch to Workspace ${n}`);
    out.set(chordId(tabSelectKey(n)), `Go to Tab ${n}`);
  }
  if (modKey() === "Meta") for (const role of roleChords()) out.set(chordId(role.key), `${role.label} in the menu bar`);
  return out;
}

/**
 * The `keys` setting applied to the command table. An entry replaces its
 * command's chords, and each chord it assigns is taken from the command that
 * shipped with it. Every problem costs one chord or one entry, never the
 * section: a command whose entry holds no usable chord keeps its defaults.
 */
export function resolveKeys(overrides: Record<string, readonly string[]>): ResolvedKeys {
  const problems: string[] = [];
  const held = reserved();
  const assigned = new Map<CommandId, string[]>();
  // Which entry claimed each chord. The first to ask keeps it.
  const claims = new Map<string, CommandId>();

  for (const [name, chords] of Object.entries(overrides)) {
    if (!(name in COMMANDS)) {
      problems.push(`"keys.${name}" is not a command id`);
      continue;
    }
    const id = name as CommandId;
    if (!takesChord(id)) {
      problems.push(`"keys.${name}" acts on what the pointer is over, so no chord can run it`);
      continue;
    }
    const usable: string[] = [];
    for (const text of chords) {
      const result = normalizeChord(text);
      if ("problem" in result) {
        problems.push(`"keys.${name}": "${text}" ${result.problem}`);
        continue;
      }
      const chord = chordId(result.chord);
      const holder = held.get(chord);
      const claimant = claims.get(chord);
      if (holder) problems.push(`"keys.${name}": "${text}" is ${holder} and cannot be reassigned`);
      else if (claimant && claimant !== id) problems.push(`"keys.${name}": "${text}" is already given to ${claimant}`);
      else if (!claimant) {
        claims.set(chord, id);
        usable.push(result.chord);
      }
    }
    // An empty list is how a command is left with no chord. A list of nothing
    // but mistakes is not that.
    if (chords.length === 0 || usable.length > 0) assigned.set(id, usable);
  }

  const changed: Partial<Record<CommandId, readonly string[]>> = {};
  for (const id of Object.keys(COMMANDS) as CommandId[]) {
    const mine = assigned.get(id);
    const was = defaultKeysOf(id);
    // A default holder keeps every chord no entry claimed.
    const now = mine ?? was.filter((k) => !claims.has(chordId(k)));
    if (now.length !== was.length || now.some((k, i) => k !== was[i])) changed[id] = now;
  }
  return { changed, bound: [...assigned.keys()], problems };
}

/** Resolve the setting, put it in force, and return what it got wrong. */
export function applyKeys(overrides: Record<string, readonly string[]>): string[] {
  const resolved = resolveKeys(overrides);
  configureKeys(resolved);
  return resolved.problems;
}
