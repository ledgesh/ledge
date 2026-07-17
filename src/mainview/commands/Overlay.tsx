// The unified quick-open overlay: one component, three modes.
//
// ⌘P opens in notes mode (fuzzy-open a note by title, the old QuickOpen);
// ⇧⌘P opens in commands mode (every palette-visible command with its key
// chip); ⌥⌘P opens in search mode (full-text over note bodies, via the
// noteSearch RPC). Typing ">" as the first character of notes mode switches to
// commands — the VS Code convention — and "#" switches to search; Backspace
// over the sigil switches back. Only the first typed character triggers a
// switch, so a note whose title contains either character stays findable, and
// the direct chords always land in their mode.
import { useEffect, useMemo, useRef, useState } from "react";
import { Command as CommandIcon, FileText, TextSearch } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/workspace/store";
import { filterNotes, fuzzyFilter } from "@/notes/fuzzy";
import { searchNotes, type SearchHit } from "@/notes/channel";
import { requestReveal } from "@/workspace/editorPool";
import { pushLayer } from "./layers";
import { useCommands } from "./CommandProvider";
import { paletteItems, type PaletteItem } from "./registry";

export type OverlayMode = "notes" | "commands" | "search";

// How long a keystroke burst can run before the RPC fires. Short enough that
// results feel live, long enough that "shipping" is one scan, not eight.
const SEARCH_DEBOUNCE_MS = 80;

export function Overlay({ initialMode, onClose }: { initialMode: OverlayMode; onClose: () => void }) {
  const { state, dispatch } = useWorkspace();
  const { exec, commands, ctx } = useCommands();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The sigils only fire as the first character of notes mode; the direct
  // chords are unconditional.
  const sigil = initialMode === "notes" ? (query.startsWith(">") ? "commands" : query.startsWith("#") ? "search" : null) : null;
  const mode: OverlayMode = sigil ?? initialMode;
  const isCommands = mode === "commands";
  const isSearch = mode === "search";
  // Strip the mode-switch sigil before filtering; a direct chord open has none.
  const q = sigil ? query.slice(1) : query;

  const notes = useMemo(
    () => (mode === "notes" ? filterNotes(q, state.notes) : []),
    [mode, q, state.notes],
  );

  // Search mode asks Bun, debounced, and guards against answers landing out of
  // order: only the reply to the query still on screen may set the list.
  const [hits, setHits] = useState<SearchHit[]>([]);
  useEffect(() => {
    if (!isSearch || q.trim() === "") {
      setHits([]);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      searchNotes(q).then(
        (h) => {
          if (!stale) setHits(h);
        },
        () => {
          if (!stale) setHits([]);
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [isSearch, q]);
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

  const count = isCommands ? items.length : isSearch ? hits.length : notes.length;
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
    } else if (isSearch) {
      const hit = hits[i];
      if (!hit) return;
      // The reveal is registered before the open: openNote's render is what
      // attaches (or creates) the editor the reveal lands in.
      requestReveal(hit.path, hit.line, q);
      dispatch({ type: "openNote", note: { path: hit.path, title: hit.title, mtimeMs: hit.mtimeMs } });
      onClose();
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
          placeholder={
            isCommands
              ? "Run a command"
              : isSearch
                ? "Search inside notes"
                : "Search notes  (> commands · # in text)"
          }
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
                : isSearch
                  ? q.trim() === ""
                    ? "Type to search every note's text"
                    : "No matches"
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
          ) : isSearch ? (
            hits.map((hit, i) => {
              // The snippet with its match set off: col/length index the query
              // inside it (shared/search.ts windows long lines around it).
              const len = q.trim().length;
              return (
                <div
                  key={`${hit.path}:${hit.line}`}
                  data-active={i === active ? "" : undefined}
                  className={cn(
                    "flex cursor-default items-center gap-2 rounded px-2.5 py-1.5",
                    i === active && "bg-accent",
                  )}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => open(i)}
                >
                  <TextSearch className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                    {hit.snippet.slice(0, hit.col)}
                    <span className="rounded-[2px] bg-primary/15 font-medium text-foreground">
                      {hit.snippet.slice(hit.col, hit.col + len)}
                    </span>
                    {hit.snippet.slice(hit.col + len)}
                  </span>
                  <span className="max-w-[35%] shrink-0 truncate text-[11px] text-muted-foreground">
                    {hit.title}
                  </span>
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
