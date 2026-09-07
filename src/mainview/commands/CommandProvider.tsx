// The single window-level keydown dispatcher, and the exec() every surface
// calls: buttons, menu items, palette rows, and the editor bridge all converge
// on the same command definitions. The listener runs at bubble phase, skips
// anything an inner handler already consumed, and dispatches nothing while a
// modal layer is open: menu, dialog, palette (interactions.md §7 and §6).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useWorkspace } from "@/workspace/store";
import { useVaultState } from "@/vault/channel";
import { buildCommands } from "./registry";
import { eventToChord, resolveChord, type FocusDomain } from "./keymap";
import { modalOpen } from "./layers";
import { targetFromElement } from "./target";
import { buildMenu } from "./menu";
import { onNativeCommand, setAppMenu } from "@/lib/menu";
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
// terminal are checked before a row, in case either hosts rows of its own one
// day; a bare key inside them is typing. The terminal comes first: an inline
// run's panel lives inside `.cm-editor` (interactions.md §2 and §6a).
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
  // Only the menu bar reads this. The vault commands' `when`s reach vault
  // state through registryDeps, the way every other command reaches its deps.
  // Locking or unlocking changes no store field, so the menu push effect below
  // lists `vault` in its dependency array.
  const vault = useVaultState();
  const commands = useMemo(() => buildCommands(registryDeps), []);

  // The latest ctx sits in a ref, so the window listener below registers once
  // and still reads current state. This replaces App.tsx's two
  // dependency-churning effects.
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
      // A disabled command lets the key fall through untouched, matching the
      // old behavior of ⌘7 with six workspaces: nothing, no beep-guard.
      // Backspace is the exception. The dispatcher consumes a bare ⌫ in the
      // list domain whether the verb was refused (⌫ on the last workspace) or
      // no command matched at all, so it cannot reach WebKit's history-back
      // (interactions.md §7). A row's text field is safe: focus there sits in
      // domain "page", not "list".
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

  // A clicked menu item runs its command with no target, the way the palette
  // invokes one. The bar has no focused row to point at, so the commands that
  // need a target are kept out of it (interactions.md §10).
  useEffect(() => onNativeCommand((action) => exec(action)), [exec]);

  // The menu bar is installed from Bun, so it cannot ask a `when` anything at
  // the moment the user pulls it down: it carries whatever enablement was true
  // at the last push. This effect pushes again when the state the `when`s read
  // moves: the document model, the selected workspace, the vault. A `when` on
  // live frontmatter (the template marker, profile.open) lags until autosave's
  // notesChanged refreshes the note list. Watching the document text instead
  // would rebuild the menu on every keystroke (interactions.md §10).
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
