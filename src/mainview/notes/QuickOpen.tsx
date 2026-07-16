// Cmd+P quick-open: fuzzy-filter every note by filename and open the pick.
// Shares the store's note list and the `openNote` action with the browser, so it
// inherits open-or-focus (a note already in a tab is never opened twice).
import { useEffect, useMemo, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/workspace/store";
import { filterNotes } from "./fuzzy";

export function QuickOpen({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useWorkspace();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => filterNotes(query, state.notes), [query, state.notes]);
  // A stale index from a longer result set would point past the end.
  const active = Math.min(index, Math.max(results.length - 1, 0));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep the highlighted row visible as the arrows walk past the fold.
  useEffect(() => {
    listRef.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active, results]);

  const open = (i: number) => {
    const note = results[i];
    if (!note) return;
    dispatch({ type: "openNote", note });
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex(Math.min(active + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(Math.max(active - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
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
          placeholder="Search notes"
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
          {results.length === 0 ? (
            <p className="px-2.5 py-3 text-center text-[11px] text-muted-foreground">
              {state.notes.length === 0 ? "No notes yet" : "No notes match"}
            </p>
          ) : (
            results.map((note, i) => (
              <div
                key={note.path}
                data-active={i === active ? "" : undefined}
                className={cn(
                  "flex cursor-default items-center gap-2 rounded px-2.5 py-1.5",
                  i === active && "bg-accent",
                )}
                // Highlight follows the pointer, so mouse and keyboard agree on
                // what Enter would open.
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
