// The macOS menu bar, built from the command registry like every other
// surface (interactions.md §10). This module holds the spec (which command
// sits where) and the pure builder that turns it into the wire shape Bun
// hands to AppKit. No React and no RPC: menu.test.ts checks it against a
// stubbed registry.
//
// Two rules from §10 shape the spec below.
//
//   1. Enablement is a snapshot. The bar is set from the Bun process and
//      cannot read view state on demand. The view re-pushes it when the
//      document model, the selected workspace, or the vault moves
//      (CommandProvider.tsx).
//   2. An accelerator is a claim, not a label. AppKit's key-equivalent pass
//      runs before the WebView sees the key, so declaring a chord here takes
//      it from CodeMirror and xterm. Claim it where the registry's command
//      does the same thing to the focused editor (⌘S, ⌘F, ⌘↩, ⌘B). Where an
//      inner handler owns the chord for a different meaning, the item carries
//      `accelerator: false` with a reason.
import type { AppMenuItem } from "../../shared/rpc-schema";
import type { Command, CommandCtx } from "./types";

// One entry in a menu. A `command` item runs a registry command in the view.
// A `role` item is a native AppKit selector: the responder chain answers it
// with no view code involved, which is how a WKWebView gets real undo and
// clipboard behavior.
export type MenuItem =
  | "---"
  | {
      command: string;
      // Advertise a binding other than the command's primary one. Used where
      // the primary cannot be spelled as an accelerator (⌃Tab) but an alias
      // can (⇧⌘]).
      key?: string;
      // Claim no key equivalent. The item still runs the command when
      // clicked, and the chord keeps reaching the handler that owns it.
      accelerator?: false;
      // Drop the item when its `when` is false, rather than greying it. Used
      // by the two-faces pairs and the generated workspace slots, where
      // exactly one face is ever live and a row of dimmed twins would say
      // less than one live item (interactions.md §10).
      hideWhenDisabled?: true;
      // Keep only what follows ": " in the command's title. The generated
      // workspace entries title themselves for the palette ("Switch to
      // Workspace: Notes"). The submenu already says that, so the label is
      // the workspace name alone.
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
    // title in bold. This label is what it shows.
    label: "Ledge",
    items: [
      { role: "about", label: "About Ledge" },
      // A two-faces pair: while an update waits to be installed, Restart to
      // Install Update replaces Check for Updates…. Both are absent on a build
      // that does not update itself (lib/updates.ts).
      { command: "update.check", hideWhenDisabled: true },
      { command: "update.install", hideWhenDisabled: true },
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
      // Beside the News rather than with the workspace verbs: a folder is
      // where a note goes, not a place of its own. The verb creates the
      // folder and writes its first note into it (notes/NoteBrowser.tsx).
      { command: "folder.new" },
      "---",
      { command: "workspace.new" },
      { command: "workspace.attach" },
      // Beside Switch Connection rather than with the other News: a window is a
      // client of one server, so choosing a window is choosing a machine
      // (remote.md §8a).
      { command: "connection.switch" },
      { command: "window.new", hideWhenDisabled: true },
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
      // No key equivalent. ⌘⌫ is CodeMirror's delete-to-line-start in the
      // editor, which is why note.deleteCurrent is page-focus-only
      // (registry.ts). A menu key equivalent would fire from inside the
      // editor too and delete the note the user is typing in.
      { command: "note.deleteCurrent", accelerator: false },
      { command: "trash.empty" },
    ],
  },
  {
    label: "Edit",
    items: [
      // Undo and Redo are safe to claim. WebKit turns the native selector into
      // a beforeinput event with inputType historyUndo, which
      // @codemirror/commands maps onto its own history. The editor's undo
      // stack is the one that moves, as it is when CodeMirror binds the key.
      { role: "undo", label: "Undo", accelerator: "command+z" },
      { role: "redo", label: "Redo", accelerator: "command+shift+z" },
      "---",
      // The clipboard trio takes no key equivalents (interactions.md §10). The
      // views:// scheme is not a secure context, so cut, copy and paste run
      // through the Bun process (lib/clipboard.ts). The editor binds them at
      // Prec.highest (editor/setup.ts) and xterm binds them in the terminal.
      // ⌘V also embeds an image when the pasteboard carries one but no text
      // (editor/clipboard.ts). Claiming the chords here would route all of
      // that through WebKit's own editing commands and lose both the Bun
      // routing and the image embed. Clicking the items still works: the
      // selector reaches the WebView through the responder chain.
      { role: "cut", label: "Cut" },
      { role: "copy", label: "Copy" },
      { role: "paste", label: "Paste" },
      { role: "selectAll", label: "Select All" },
      "---",
      // The Edit menu has no Find Next or Find Previous item. ⌘G and ⇧⌘G live
      // in the editor's own find keymap (editor/find.ts), and there is no
      // registry command to hang a menu item on, unlike find and replace.
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
      // The favorite marker, which is one command wearing the title of the
      // face it will run (registry.ts), where the pairs below are two
      // commands. Either way the visible item says what will happen.
      { command: "note.favorite" },
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
      // No key equivalent. The shell owns Ctrl (interactions.md §2), and a key
      // equivalent fires regardless of focus, which is the window-level Ctrl
      // dispatch that policy forbids. The editor's keymap routes ⌃` to this
      // command (editor/setup.ts). Inside the terminal, the same chord closes
      // the drawer directly (terminal/TerminalDrawer.tsx).
      { command: "terminal.toggle", accelerator: false },
      "---",
      { command: "pane.splitRight" },
      { command: "pane.splitDown" },
      "---",
      // ⌃Tab is the primary binding, and ACCEL_KEYS below has no name for Tab,
      // so acceleratorOf returns null for it. The ⇧⌘[ and ⇧⌘] aliases are live
      // keys for the same commands (keys.ts), so the menu advertises those
      // instead.
      { command: "tab.next", key: "Mod-Shift-]" },
      { command: "tab.prev", key: "Mod-Shift-[" },
      // Keep Tab Open, beside the other verbs on the focused pane's active
      // tab. It has no chord, so the menu bar and the tab's own menu are where
      // a pointer client finds it (interactions.md §1b).
      { command: "tab.keep" },
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

// Chords an inner handler already owns for a different meaning. A key
// equivalent would take them: AppKit's pass runs before the WebView sees the
// key. interactions.md §10 names each owner and says why ⌘Z is not listed.
//   ⌘⌫  CodeMirror's delete-to-line-start (registry.ts).
//   ⌘A ⌘C ⌘X ⌘V  the editor's and terminal's selection and clipboard.
//   ⇧⌘V  paste without the HTML-to-Markdown translation (editor/htmlPaste.ts).
// A bare ⌃ chord is off-limits for the same reason without being listed
// (shellOwnsChord below). menu.test.ts enforces both.
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

// keys.ts spells bindings CodeMirror-style ("Mod-Shift-p"). The native side
// wants Electron-style accelerators ("command+shift+p"). The modifier and key
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

// "Mod-Shift-p" becomes "command+shift+p", and null when the binding cannot
// be spelled as one (⌃Tab, F3). Null rather than a guess: an accelerator the
// parser does not understand becomes a key equivalent that silently never
// fires, while an item with no shortcut simply shows no chord.
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
// ids are dropped rather than thrown on, so menu.test.ts catches a spec that
// has drifted from the registry, rather than the boot doing it.
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
    // Drop a trailing divider, for the same reason as a leading one.
    while (out.length > 0 && "type" in out[out.length - 1]!) out.pop();
    return out;
  }

  return MENU.map((section) => ({ label: section.label, submenu: build(section.items) }));
}
