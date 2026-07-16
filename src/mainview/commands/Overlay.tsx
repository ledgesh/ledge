// The unified quick-open overlay: one component, two modes.
//
// ⌘P opens in notes mode (fuzzy-open a note, the old QuickOpen); ⇧⌘P opens in
// commands mode (every palette-visible command with its key chip). Typing ">"
// as the first character of notes mode switches to commands — the VS Code
// convention — and Backspace over it switches back. Only the first typed
// character triggers the switch, so a note whose title contains ">" stays
// findable, and ⇧⌘P is always a direct route to commands.
import { useEffect, useMemo, useRef, useState } from "react";
import { Command as CommandIcon, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/workspace/store";
import { filterNotes, fuzzyFilter } from "@/notes/fuzzy";
import { pushLayer } from "./layers";
import { useCommands } from "./CommandProvider";
import { paletteItems, type PaletteItem } from "./registry";

export type OverlayMode = "notes" | "commands";

export function Overlay({ initialMode, onClose }: { initialMode: OverlayMode; onClose: () => void }) {
  const { state, dispatch } = useWorkspace();
  const { exec, commands, ctx } = useCommands();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const isCommands = initialMode === "commands" || query.startsWith(">");
  // Strip the mode-switch ">" before filtering; a direct ⇧⌘P open has none.
  const q = isCommands && initialMode === "notes" ? query.slice(1) : query;

  const notes = useMemo(
    () => (isCommands ? [] : filterNotes(q, state.notes)),
    [isCommands, q, state.notes],
  );
  const items = useMemo<PaletteItem[]>(() => {
    if (!isCommands) return [];
    const visible = paletteItems(commands, ctx());
    // An empty query shows the registry's own order (semantic grouping); a
    // query re-ranks by match quality.
    return q.trim() ? fuzzyFilter(q, visible, (i) => i.title) : visible;
    // ctx() reads a ref; state/selected are the real inputs that change what
    // `when` and the dynamic titles produce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCommands, q, commands, state]);

  const count = isCommands ? items.length : notes.length;
  // A stale index from a longer result set would point past the end.
  const active = Math.min(index, Math.max(count - 1, 0));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // This is a modal layer: Escape (capture, topmost-only) closes it, and the
  // window command dispatcher is suppressed while it is up.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => pushLayer("overlay", () => onCloseRef.current()), []);

  // Keep the highlighted row visible as the arrows walk past the fold.
  useEffect(() => {
    listRef.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active, count]);

  const open = (i: number) => {
    if (isCommands) {
      const item = items[i];
      if (!item) return;
      // Close first: commands that refocus the editor (Find, Run Block) need
      // the overlay's focus out of the way before they act.
      onClose();
      exec(item.id);
    } else {
      const note = notes[i];
      if (!note) return;
      dispatch({ type: "openNote", note });
      onClose();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex(Math.min(active + 1, count - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(Math.max(active - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(active);
    }
    // Escape is handled by the layer stack (layers.ts), not here.
  };

  return (
    // The backdrop closes on click; the panel stops the click from reaching it.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[60vh] w-[min(520px,90vw)] flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          placeholder={isCommands ? "Run a command" : "Search notes  (> for commands)"}
          spellCheck={false}
          // WKWebView applies autocorrect/autocapitalize to a bare <input> and
          // mangles what you type ("sh" becomes "Sh"). `autocorrect` is WebKit-only
          // with no IDL property, hence setAttribute-style props here.
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
          className="shrink-0 border-b bg-transparent px-3.5 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
        />

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
          {count === 0 ? (
            <p className="px-2.5 py-3 text-center text-[11px] text-muted-foreground">
              {isCommands
                ? "No matching commands"
                : state.notes.length === 0
                  ? "No notes yet"
                  : "No notes match"}
            </p>
          ) : isCommands ? (
            items.map((item, i) => {
              const Icon = item.icon ?? CommandIcon;
              return (
                <div
                  key={item.id}
                  data-active={i === active ? "" : undefined}
                  className={cn(
                    "flex cursor-default items-center gap-2 rounded px-2.5 py-1.5",
                    i === active && "bg-accent",
                  )}
                  // Highlight follows the pointer, so mouse and keyboard agree
                  // on what Enter would run.
                  onMouseMove={() => setIndex(i)}
                  onClick={() => open(i)}
                >
                  <Icon
                    className={cn(
                      "size-3.5 shrink-0",
                      item.destructive ? "text-destructive" : "text-muted-foreground",
                    )}
                  />
                  <span className={cn("min-w-0 flex-1 truncate text-sm", item.destructive && "text-destructive")}>
                    {item.title}
                  </span>
                  {item.chip && (
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {item.chip}
                    </span>
                  )}
                </div>
              );
            })
          ) : (
            notes.map((note, i) => (
              <div
                key={note.path}
                data-active={i === active ? "" : undefined}
                className={cn(
                  "flex cursor-default items-center gap-2 rounded px-2.5 py-1.5",
                  i === active && "bg-accent",
                )}
                onMouseMove={() => setIndex(i)}
                onClick={() => open(i)}
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm">{note.title}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
