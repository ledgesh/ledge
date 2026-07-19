// Keyboard navigation for a row list (the note list, the trash, the workspace
// strip).
//
// Two jobs, and they are the same job: give the list a focused row. Without one
// the lists are pointer-only (no way in from the keyboard at all) and the row
// verbs from the command registry — `d` to delete, Enter to open — have nothing
// to act on. Focus is what makes them addressable: the focused row publishes
// its identity as data attributes and the command dispatcher reads it back
// (commands/target.ts).
//
// Roving tabindex, per the WAI-ARIA listbox pattern: exactly one row is
// tabbable at a time, so Tab moves past the list rather than through every note
// in it, and ↑/↓ move within. The rows are the source of truth for order — this
// walks the live DOM rather than an index it keeps in sync, because the DOM
// already has the answer and cannot disagree with itself.
import { useCallback, useRef, useState, type KeyboardEvent } from "react";

// A row's marker: the attribute that makes it navigable here and puts the
// command dispatcher into the "list" focus domain (commands/CommandProvider).
const ROW = "[data-list-row]";

export interface ListNav {
  // Spread onto the scroll container that holds the rows.
  containerProps: {
    ref: React.RefObject<HTMLDivElement>;
    onKeyDown: (e: KeyboardEvent) => void;
  };
  // Spread onto each row. `key` is the row's stable identity (a note path, a
  // workspace id) — the roving tabindex follows it, so it survives the list
  // re-sorting under a rename.
  rowProps: (key: string, index: number) => {
    "data-list-row": string;
    tabIndex: number;
    onFocus: () => void;
    onMouseDown: (e: React.MouseEvent<HTMLElement>) => void;
  };
}

export function useListNav(): ListNav {
  const ref = useRef<HTMLDivElement>(null);
  // Which row is tabbable. Null until the list has been touched, when the
  // first row takes it: a fresh list must have exactly one way in.
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const move = useCallback((dir: 1 | -1 | "first" | "last") => {
    const rows = Array.from(ref.current?.querySelectorAll<HTMLElement>(ROW) ?? []);
    if (rows.length === 0) return;
    const at = rows.findIndex((r) => r.contains(document.activeElement));
    let next: number;
    if (dir === "first") next = 0;
    else if (dir === "last") next = rows.length - 1;
    // From nowhere, ↓ enters at the top and ↑ at the bottom.
    else if (at < 0) next = dir === 1 ? 0 : rows.length - 1;
    // Clamped, not wrapped: wrapping a list you are holding ↓ on jumps you to
    // the other end just as you overshoot the one you wanted.
    else next = Math.max(0, Math.min(rows.length - 1, at + dir));
    rows[next]?.focus();
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Only the pure navigation keys are consumed here. Everything else —
      // including the row verbs and every ⌘ chord — falls through to the
      // window dispatcher, which is the one place that decides what a key
      // means (interactions.md §7).
      const dir =
        e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : e.key === "Home" ? "first" : e.key === "End" ? "last" : null;
      if (dir === null || e.metaKey || e.ctrlKey || e.altKey) return;
      // A text field inside a row (the inline rename) owns its own arrows:
      // ↑/↓ there move the caret, they don't leave the field.
      if ((e.target as Element).closest("input, textarea, [contenteditable='true']")) return;
      e.preventDefault(); // stop the sidebar from scrolling under the moving focus
      move(dir);
    },
    [move],
  );

  const rowProps = useCallback(
    (key: string, index: number) => ({
      "data-list-row": key,
      // Before anything is focused, the first row is the entry point.
      tabIndex: (focusKey === null ? index === 0 : focusKey === key) ? 0 : -1,
      onFocus: () => setFocusKey(key),
      onMouseDown: (e: React.MouseEvent<HTMLElement>) => {
        // Focus the row explicitly. WebKit does not reliably focus a
        // tabindex'd non-form element on click, so without this a clicked row
        // is styled as current but focused nowhere, and the row verbs have
        // nothing to act on — click, press `d`, nothing happens.
        //
        // The row's own controls (the close ✕, the rename field) keep their
        // focus: the press only claims the row itself.
        if ((e.target as Element).closest("button, input, textarea")) return;
        e.currentTarget.focus();
        setFocusKey(key);
      },
    }),
    [focusKey],
  );

  return { containerProps: { ref, onKeyDown }, rowProps };
}
