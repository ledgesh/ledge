// The single window-level keydown dispatcher, and the exec() every surface
// calls: buttons, menu items, palette rows, and the editor bridge all converge
// on the same command definitions.
//
// The anti-double-fire contract (interactions.md §7): CodeMirror keymaps
// and xterm handlers consume their keys with preventDefault, this listener
// runs at bubble phase and skips anything already handled, and while a modal
// layer is open (menu/dialog/palette) it dispatches nothing.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useWorkspace } from "@/workspace/store";
import { useVaultState } from "@/vault/channel";
import { buildCommands } from "./registry";
import { eventToChord, resolveChord, type FocusDomain } from "./keymap";
import { modalOpen } from "./layers";
import { targetFromElement } from "./target";
import { buildMenu } from "./menu";
import { onMenuCommand, setAppMenu } from "@/lib/menu";
import { registryDeps, uiHooks } from "./glue";
import type { Command, CommandCtx, CommandTarget } from "./types";

interface CommandsApi {
  exec(id: string, target?: CommandTarget): void;
  commands: readonly Command[];
  // A fresh ctx for surfaces that render from command state (palette, menus).
  ctx(): CommandCtx;
}

const CommandsContext = createContext<CommandsApi | null>(null);

// Where focus sits, for domain gating: inside a CodeMirror editor, inside an
// xterm terminal, on a focused list row, or in the page chrome. The editor and
// terminal are checked first: they can host rows of their own one day, and a
// bare key inside them is always typing.
//
// The terminal is asked FIRST because one kind of terminal lives inside the
// editor: an inline run's panel is a block widget inside `.cm-editor`, and a
// run that has taken the keyboard (inlineTerm.claimFocus) is a shell like any
// other — it owns Ctrl (§7), the same as the drawer.
function domainOf(target: EventTarget | null): FocusDomain {
  if (target instanceof Element) {
    if (target.closest(".xterm")) return "terminal";
    if (target.closest(".cm-editor")) return "editor";
    // A text field inside a row (the inline rename) is typing, not a row: `r`
    // there is a letter in the name, not the Rename command firing again.
    if (target.closest("input, textarea, [contenteditable='true']")) return "page";
    if (target.closest("[data-list-row]")) return "list";
  }
  return "page";
}

export function CommandProvider({ children }: { children: ReactNode }) {
  const { state, dispatch, selected } = useWorkspace();
  // Only the menu bar reads this: the vault's `when`s go through registryDeps
  // like every other, but a transition changes no store field, so the push
  // effect below needs its own reason to run.
  const vault = useVaultState();
  const commands = useMemo(() => buildCommands(registryDeps), []);

  // The latest ctx rides in a ref so the window listener registers once and is
  // never stale — this replaces App.tsx's two dependency-churning effects.
  const ctxRef = useRef<CommandCtx>({ state, dispatch, selected, ui: uiHooks });
  ctxRef.current = { state, dispatch, selected, ui: uiHooks };

  const ctx = useCallback(() => ctxRef.current, []);

  const exec = useCallback(
    (id: string, target?: CommandTarget) => {
      const cmd = commands.find((c) => c.id === id);
      if (!cmd) {
        console.warn(`[commands] unknown command: ${id}`);
        return;
      }
      const c: CommandCtx = { ...ctxRef.current, target };
      if (cmd.when && !cmd.when(c)) return;
      cmd.run(c);
    },
    [commands],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // an inner handler consumed it
      // The focused row, if any: a bare `d` carries no target of its own, so
      // the row it landed on is the target (commands/target.ts).
      const target = targetFromElement(e.target);
      const domain = domainOf(e.target);
      const hit = resolveChord(commands, eventToChord(e), {
        domain,
        modalOpen: modalOpen(),
        targetKind: target?.kind,
      });
      const c: CommandCtx = { ...ctxRef.current, target };
      // A disabled command lets the key fall through untouched (matching the
      // old behavior of e.g. ⌘7 with six workspaces: nothing, no beep-guard) —
      // except a bare ⌫ on a focused row, which must die here either way:
      // some WebKit builds treat an unhandled Backspace outside a text field
      // as history-back, so a refused verb (⌫ on the last workspace) has to
      // be a no-op, not a navigation. A text field inside a row is safe: its
      // focus puts the domain at "page", not "list" (domainOf above).
      if (!hit || (hit.when && !hit.when(c))) {
        const bare = !e.metaKey && !e.ctrlKey && !e.altKey;
        if (domain === "list" && bare && e.key === "Backspace") e.preventDefault();
        return;
      }
      e.preventDefault();
      hit.run(c);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commands]);

  // A clicked menu item runs its command with no target — the palette's
  // invocation, which is the only honest one from the menu bar: the bar has no
  // row to point at, and the commands that need one are kept out of it
  // (interactions.md §10).
  useEffect(() => onMenuCommand((action) => exec(action)), [exec]);

  // The menu bar is installed from Bun, so it cannot ask a `when` anything at
  // the moment the user pulls it down: it carries whatever enablement was true
  // at the last push. Re-push whenever the state those predicates read moves —
  // the document model, the selected workspace, the vault. The one thing not
  // covered is a `when` that reads the LIVE note text (the template marker's
  // two faces, profile.open): editing frontmatter changes no store field, so
  // those items lag until autosave's notesChanged refreshes the note list a
  // moment later. Watching the doc instead would rebuild the menu on every
  // keystroke, which is a worse trade for an item nobody is looking at while
  // they type.
  useEffect(() => {
    setAppMenu(buildMenu(commands, ctxRef.current));
  }, [commands, state, selected, vault]);

  const api = useMemo<CommandsApi>(() => ({ exec, commands, ctx }), [exec, commands, ctx]);
  return <CommandsContext.Provider value={api}>{children}</CommandsContext.Provider>;
}

export function useCommands(): CommandsApi {
  const api = useContext(CommandsContext);
  if (!api) throw new Error("useCommands must be used within CommandProvider");
  return api;
}
