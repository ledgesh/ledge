// Keyboard navigation for a row list (the note list, the trash, the workspace
// strip). useListNav gives the list a focused row. Without one the list is
// pointer-only, with no way in from the keyboard. Focus is also what makes a
// row addressable by the row verbs from the command registry (`d` to delete,
// Enter to open): the focused row publishes its identity as data attributes
// and the command dispatcher reads it back (commands/target.ts).
//
// Roving tabindex, per the WAI-ARIA listbox pattern: exactly one row is
// tabbable at a time, so Tab moves past the list rather than through every
// note in it, and ↑/↓ move within. The rows are the source of truth for
// order, so `move` below walks the live DOM rather than an index it keeps in
// sync: the DOM already has the answer and cannot disagree with itself.
import { useCallback, useRef, useState, type KeyboardEvent } from "react";

// The selector for a row. The `data-list-row` attribute rowProps writes makes
// the row navigable here and puts the command dispatcher into the list focus
// domain (commands/CommandProvider.tsx).
const ROW = "[data-list-row]";

export interface ListNav {
  // Spread onto the scroll container that holds the rows.
  containerProps: {
    ref: React.RefObject<HTMLDivElement>;
    onKeyDown: (e: KeyboardEvent) => void;
  };
  // Spread onto each row. `key` is the row's stable identity (a note path, a
  // workspace id). The roving tabindex follows the key rather than the row's
  // index, so a re-sort keeps it on the same row. A rename changes the key,
  // which replaces the row instead of relabelling it, so a list with a rename
  // puts focus back on the new key itself (notes/NoteBrowser.tsx).
  rowProps: (key: string, index: number) => {
    "data-list-row": string;
    tabIndex: number;
    onFocus: () => void;
    onMouseDown: (e: React.MouseEvent<HTMLElement>) => void;
  };
}

export function useListNav(): ListNav {
  const ref = useRef<HTMLDivElement>(null);
  // The key of the tabbable row. Null until a row takes focus.
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const move = useCallback((dir: 1 | -1 | "first" | "last") => {
    const rows = Array.from(ref.current?.querySelectorAll<HTMLElement>(ROW) ?? []);
    if (rows.length === 0) return;
    const at = rows.findIndex((r) => r.contains(document.activeElement));
    let next: number;
    if (dir === "first") next = 0;
    else if (dir === "last") next = rows.length - 1;
    // With no row focused, ↓ enters at the top and ↑ at the bottom.
    else if (at < 0) next = dir === 1 ? 0 : rows.length - 1;
    // Clamped, not wrapped: a held ↓ stops at the last row rather than
    // jumping back to the first. Wrapping would send focus to the far end of
    // the list at the moment a held key overshoots the wanted row.
    else next = Math.max(0, Math.min(rows.length - 1, at + dir));
    rows[next]?.focus();
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Only the navigation keys are consumed here. Everything else,
      // including the row verbs and every ⌘ chord, falls through to the
      // window dispatcher. That dispatcher is the one place that decides
      // what a key means, and lists do not run commands (interactions.md §7).
      const dir =
        e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : e.key === "Home" ? "first" : e.key === "End" ? "last" : null;
      if (dir === null || e.metaKey || e.ctrlKey || e.altKey) return;
      // A text field inside a row (the inline rename) keeps its own arrows:
      // ↑/↓ there move the caret and leave the focused row where it is.
      if ((e.target as Element).closest("input, textarea, [contenteditable='true']")) return;
      e.preventDefault(); // stop the sidebar from scrolling under the moving focus
      move(dir);
    },
    [move],
  );

  const rowProps = useCallback(
    (key: string, index: number) => ({
      "data-list-row": key,
      // Exactly one row is tabbable. Until a row takes focus that is the
      // first row, so a fresh list has one way in from the keyboard.
      tabIndex: (focusKey === null ? index === 0 : focusKey === key) ? 0 : -1,
      onFocus: () => setFocusKey(key),
      onMouseDown: (e: React.MouseEvent<HTMLElement>) => {
        // Focus the row explicitly. WebKit does not reliably focus a
        // tabindex'd non-form element on click. Without it a clicked row is
        // styled as current but focused nowhere: click, press `d`, nothing
        // happens. On a press on the row's own controls (the close button,
        // the rename field) this handler returns early without moving focus.
        if ((e.target as Element).closest("button, input, textarea")) return;
        e.currentTarget.focus();
        setFocusKey(key);
      },
    }),
    [focusKey],
  );

  return { containerProps: { ref, onKeyDown }, rowProps };
}
