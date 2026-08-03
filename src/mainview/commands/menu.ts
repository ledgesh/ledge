// The macOS menu bar, derived from the command registry like every other
// surface (interactions.md §10). This module is the SPEC — which commands
// appear where — plus the pure builder that turns it into the wire shape Bun
// hands to AppKit. No React, no RPC: menu.test.ts checks the whole thing
// against a stubbed registry.
//
// Two things make the menu bar unlike the palette or a context menu:
//
//   1. It is set from the Bun process, so it cannot read view state on
//      demand. The view rebuilds and re-pushes it whenever the state a
//      `when` could read changes (CommandProvider), which is what keeps
//      enablement honest.
//   2. An accelerator is not a label. AppKit's key-equivalent pass runs
//      BEFORE the key reaches the WebView, so declaring a chord here TAKES
//      it from CodeMirror and xterm — the item, not the editor, handles it
//      from then on. That is fine for commands the registry can run on the
//      focused doc (it is what the palette already does), and wrong for the
//      chords whose meaning depends on where focus is. Those carry
//      `accelerator: false` below, each with the reason.
import type { AppMenuItem } from "../../shared/rpc-schema";
import type { Command, CommandCtx } from "./types";

// One entry in a menu. A `command` item runs a registry command in the view;
// a `role` item is a native AppKit selector that never reaches us (the
// responder chain handles it, which is the only way to get real undo and
// clipboard behavior out of a WKWebView).
export type MenuItem =
  | "---"
  | {
      command: string;
      // Advertise a binding other than the command's primary one. Used where
      // the primary cannot be spelled as an accelerator (⌃Tab) but an alias
      // can (⇧⌘]).
      key?: string;
      // Claim no key equivalent: the item still runs the command when
      // clicked, but the chord keeps flowing to whoever owns it today.
      accelerator?: false;
      // Drop the item entirely when its `when` is false, rather than greying
      // it. For the two-faces pairs (exactly one of which is ever live) and
      // the generated workspace slots, where a row of dimmed twins would say
      // less than one live item.
      hideWhenDisabled?: true;
      // Keep only what follows ": " in the command's title. The generated
      // workspace entries title themselves for the palette ("Switch to
      // Workspace: Notes"); inside a submenu already saying that, the
      // workspace's own name is the label.
      labelAfterColon?: true;
    }
  | { role: string; label: string; accelerator?: string }
  | { label: string; items: readonly MenuItem[] };

export interface MenuSection {
  label: string;
  items: readonly MenuItem[];
}

// The nine generated quick-jumps, as a submenu. They are ordinary commands
// (workspace.select.N), so they need no special handling beyond their labels.
const WORKSPACE_SLOTS: readonly MenuItem[] = Array.from({ length: 9 }, (_, i) => ({
  command: `workspace.select.${i + 1}`,
  hideWhenDisabled: true,
  labelAfterColon: true,
}));

export const MENU: readonly MenuSection[] = [
  {
    // AppKit treats the first menu as the application menu and renders its
    // title in bold; the name here is what it shows.
    label: "Ledge",
    items: [
      { role: "about", label: "About Ledge" },
      "---",
      { command: "settings.open" },
      { command: "cli.install" },
      "---",
      { role: "hide", label: "Hide Ledge", accelerator: "command+h" },
      { role: "hideOthers", label: "Hide Others", accelerator: "command+option+h" },
      { role: "showAll", label: "Show All" },
      "---",
      { role: "quit", label: "Quit Ledge", accelerator: "command+q" },
    ],
  },
  {
    label: "File",
    items: [
      { command: "note.new" },
      { command: "note.fromTemplate" },
      { command: "template.starter" },
      "---",
      { command: "workspace.new" },
      { command: "workspace.attach" },
      { command: "connection.switch" },
      "---",
      { command: "daily.open" },
      { command: "palette.notes" },
      { command: "palette.search" },
      { command: "palette.commands" },
      "---",
      { command: "editor.save" },
      "---",
      { command: "tab.close" },
      { command: "pane.close" },
      { command: "workspace.close" },
      "---",
      // ⌘⌫ stays with the dispatcher: it is page-focus-only on purpose, so
      // CodeMirror's delete-to-line-start keeps working while you type
      // (registry.ts note.deleteCurrent). A menu key equivalent would fire
      // from inside the editor too, and delete the note mid-sentence.
      { command: "note.deleteCurrent", accelerator: false },
      { command: "trash.empty" },
    ],
  },
  {
    label: "Edit",
    items: [
      // Undo/Redo are safe to claim: WebKit turns the native selector into a
      // beforeinput event with inputType historyUndo, which @codemirror/commands
      // maps straight onto its own history. The editor's undo stack is the one
      // that moves, exactly as when CodeMirror binds the key itself.
      { role: "undo", label: "Undo", accelerator: "command+z" },
      { role: "redo", label: "Redo", accelerator: "command+shift+z" },
      "---",
      // The clipboard trio takes no key equivalents. The views:// scheme is
      // not a secure context, so cut/copy/paste run through the Bun process
      // (lib/clipboard.ts), bound at Prec.highest in the editor and by xterm
      // in the terminal — and ⌘V additionally embeds an image when the
      // pasteboard carries one but no text (editor/setup.ts). Claiming the
      // chords here would route all of that through WebKit's own editing
      // commands and lose both. Clicking the items still works: the selector
      // reaches the WebView through the responder chain.
      { role: "cut", label: "Cut" },
      { role: "copy", label: "Copy" },
      { role: "paste", label: "Paste" },
      { role: "selectAll", label: "Select All" },
      "---",
      // Find Next / Previous are absent on purpose: ⌘G and ⇧⌘G live entirely
      // inside CodeMirror's search keymap and have no registry command to
      // hang a menu item on — unlike find/replace, which do.
      { command: "editor.find" },
      { command: "editor.replace" },
      "---",
      { command: "format.bold" },
      { command: "format.italic" },
      { command: "format.link" },
      { command: "task.toggle" },
      { command: "link.open" },
    ],
  },
  {
    label: "Note",
    items: [
      { command: "frontmatter.edit" },
      { command: "profile.open" },
      "---",
      { command: "block.runInline" },
      { command: "block.runInTerminal" },
      { command: "session.restart" },
      "---",
      // Two-faces pairs: the registry keeps exactly one of each live, so the
      // visible item always says what will happen.
      { command: "note.templateOn", hideWhenDisabled: true },
      { command: "note.templateOff", hideWhenDisabled: true },
      { command: "daily.templateEdit", hideWhenDisabled: true },
      { command: "daily.templateNew", hideWhenDisabled: true },
      "---",
      { command: "note.lockOn", hideWhenDisabled: true },
      { command: "note.lockOff", hideWhenDisabled: true },
      { command: "vault.lock" },
      { command: "vault.unlock" },
      { command: "vault.changePassphrase" },
    ],
  },
  {
    label: "View",
    items: [
      { command: "sidebar.toggle" },
      { command: "backlinks.toggle" },
      { command: "outline.toggle" },
      { command: "tags.toggle" },
      // ⌃` stays with the editor's keymap and the terminal's xterm handler,
      // which route it here themselves. ⌃ is the shell's modifier (§2) and a
      // key equivalent fires regardless of focus, which is exactly the
      // window-level Ctrl dispatch the policy forbids.
      { command: "terminal.toggle", accelerator: false },
      "---",
      { command: "pane.splitRight" },
      { command: "pane.splitDown" },
      "---",
      // ⌃Tab is the advertised binding but has no accelerator spelling the
      // native side accepts; the ⇧⌘[ / ⇧⌘] aliases are live keys for the
      // same commands (keys.ts), so the menu advertises those.
      { command: "tab.next", key: "Mod-Shift-]" },
      { command: "tab.prev", key: "Mod-Shift-[" },
      "---",
      { label: "Switch to Workspace", items: WORKSPACE_SLOTS },
      "---",
      { role: "toggleFullScreen", label: "Enter Full Screen", accelerator: "control+command+f" },
    ],
  },
  {
    label: "Window",
    items: [
      { role: "minimize", label: "Minimize", accelerator: "command+m" },
      { role: "zoom", label: "Zoom" },
      "---",
      { role: "bringAllToFront", label: "Bring All to Front" },
    ],
  },
  {
    label: "Help",
    items: [{ command: "docs.toggle" }, { command: "docs.licenses" }, "---", { command: "log.reveal" }],
  },
];

// Chords an inner handler already owns for a DIFFERENT meaning. A key
// equivalent would take them: AppKit's pass runs before the WebView sees the
// key, so the editor's binding would simply stop happening.
//
//   ⌘⌫  CodeMirror's delete-to-line-start — the reason note.deleteCurrent is
//        page-focus-only to begin with (registry.ts).
//   ⌘A ⌘C ⌘X ⌘V  the editor's and terminal's own selection and clipboard
//        handling, which has to go through the Bun process in this non-secure
//        context, and which on ⌘V additionally translates a pasteboard's
//        formatted HTML to Markdown and embeds a pasteboard image.
//   ⇧⌘V  the same paste with the translation left out (editor/htmlPaste.ts).
//        AppKit binds no role to it, and a key equivalent would fire in the
//        terminal too, where the shell owns the paste.
//
// ⌘Z is deliberately NOT here: WebKit turns the native undo selector into a
// beforeinput of type historyUndo, which @codemirror/commands maps onto its
// own history — the menu and the editor mean the same thing by it.
//
// A bare ⌃ chord is off-limits for the same reason without being listed: the
// shell owns Ctrl (interactions.md §2), and a key equivalent fires even while
// the terminal has focus. menu.test.ts enforces both.
export const INNER_OWNED_CHORDS: readonly string[] = [
  "Mod-Backspace",
  "Mod-a",
  "Mod-c",
  "Mod-x",
  "Mod-v",
  "Mod-Shift-v",
];

// True for a chord the terminal's shell should keep: ⌃ without ⌘.
export function shellOwnsChord(binding: string): boolean {
  const parts = binding.split("-");
  return parts.includes("Ctrl") && !parts.includes("Mod");
}

// keys.ts spells bindings CodeMirror-style ("Mod-Shift-p"); the native side
// wants Electron-style accelerators ("command+shift+p"). Modifier and key
// names below are the ones its parser knows.
const ACCEL_MODS: Record<string, string> = {
  Ctrl: "control",
  Alt: "option",
  Shift: "shift",
  Mod: "command",
};

// Canonical order, so two spellings of one chord produce one accelerator (the
// duplicate check in menu.test.ts depends on it).
const ACCEL_ORDER = ["Ctrl", "Alt", "Shift", "Mod"] as const;

const ACCEL_KEYS: Record<string, string> = {
  Enter: "return",
  Backspace: "backspace",
  Escape: "escape",
  " ": "space",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

// "Mod-Shift-p" → "command+shift+p"; null when the binding cannot be spelled
// as one (⌃Tab, F3). Null rather than a guess: an accelerator the parser does
// not understand is a key equivalent that silently never fires, and an item
// with no shortcut at least tells the truth.
export function acceleratorOf(binding: string): string | null {
  const parts = binding.split("-");
  // A binding for the "-" key itself ends in an empty token (format.ts).
  const key = parts[parts.length - 1] === "" ? "-" : parts.pop()!;
  const mods = parts.filter((p) => p in ACCEL_MODS);
  if (mods.length !== parts.length) return null;
  const named = ACCEL_KEYS[key];
  // Single characters (letters, digits, punctuation) pass through; anything
  // else has to be a name the parser knows.
  if (!named && key.length !== 1) return null;
  const ordered = ACCEL_ORDER.filter((m) => mods.includes(m)).map((m) => ACCEL_MODS[m]!);
  return [...ordered, named ?? key.toLowerCase()].join("+");
}

function titleOfCommand(cmd: Command, ctx: CommandCtx): string {
  return typeof cmd.title === "function" ? cmd.title(ctx) : cmd.title;
}

// Build the whole menu against the live registry and context. Unknown command
// ids are dropped rather than thrown on: the menu is a view of the registry,
// and a spec that has drifted is menu.test.ts's problem, not a boot crash.
export function buildMenu(commands: readonly Command[], ctx: CommandCtx): AppMenuItem[] {
  const byId = new Map(commands.map((c) => [c.id, c]));

  function build(items: readonly MenuItem[]): AppMenuItem[] {
    const out: AppMenuItem[] = [];
    for (const item of items) {
      if (item === "---") {
        // Never open or close a section with a divider, and never double one:
        // hidden items would otherwise leave visible gaps.
        if (out.length > 0 && !("type" in out[out.length - 1]!)) out.push({ type: "divider" });
        continue;
      }
      if ("role" in item) {
        out.push({ label: item.label, role: item.role, accelerator: item.accelerator });
        continue;
      }
      if ("items" in item) {
        const submenu = build(item.items);
        if (submenu.length > 0) out.push({ label: item.label, submenu });
        continue;
      }
      const cmd = byId.get(item.command);
      if (!cmd) continue;
      const enabled = !cmd.when || cmd.when(ctx);
      if (!enabled && item.hideWhenDisabled) continue;
      const title = titleOfCommand(cmd, ctx);
      const binding = item.accelerator === false ? null : (item.key ?? cmd.keys?.[0] ?? null);
      out.push({
        label: item.labelAfterColon ? (title.split(": ")[1] ?? title) : title,
        action: cmd.id,
        accelerator: (binding && acceleratorOf(binding)) ?? undefined,
        enabled,
      });
    }
    // A trailing divider is the same gap as a leading one.
    while (out.length > 0 && "type" in out[out.length - 1]!) out.pop();
    return out;
  }

  return MENU.map((section) => ({ label: section.label, submenu: build(section.items) }));
}
