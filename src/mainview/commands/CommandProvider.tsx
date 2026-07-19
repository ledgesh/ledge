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
import { buildCommands } from "./registry";
import { eventToChord, resolveChord, type FocusDomain } from "./keymap";
import { modalOpen } from "./layers";
import { targetFromElement } from "./target";
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
function domainOf(target: EventTarget | null): FocusDomain {
  if (target instanceof Element) {
    if (target.closest(".cm-editor")) return "editor";
    if (target.closest(".xterm")) return "terminal";
    // A text field inside a row (the inline rename) is typing, not a row: `r`
    // there is a letter in the name, not the Rename command firing again.
    if (target.closest("input, textarea, [contenteditable='true']")) return "page";
    if (target.closest("[data-list-row]")) return "list";
  }
  return "page";
}

export function CommandProvider({ children }: { children: ReactNode }) {
  const { state, dispatch, selected } = useWorkspace();
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

  const api = useMemo<CommandsApi>(() => ({ exec, commands, ctx }), [exec, commands, ctx]);
  return <CommandsContext.Provider value={api}>{children}</CommandsContext.Provider>;
}

export function useCommands(): CommandsApi {
  const api = useContext(CommandsContext);
  if (!api) throw new Error("useCommands must be used within CommandProvider");
  return api;
}
