// The inline "type a new name here" input, shared by the workspace strip and
// the note list. Enter or blur commits, Escape abandons.
//
// The autocorrect attributes are load-bearing, not copy-paste noise to clean
// up: this is a native <input> in a WKWebView, where macOS text substitution
// is on by default and capitalises or "corrects" a name as the user types it
// ("sh" becomes "Sh"). The filename has to be exactly what the user typed.
import { useEffect, useRef, useState } from "react";

export function RenameField({
  initial,
  onCommit,
  onDone,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  // Set once the name has been committed or the edit abandoned. Escape
  // unmounts the field, which fires a blur on the way out. Without this flag
  // the blur handler would commit the draft that was just abandoned.
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(draft);
    onDone();
  };

  const abandon = () => {
    if (done.current) return;
    done.current = true;
    onDone();
  };

  return (
    <input
      ref={ref}
      value={draft}
      spellCheck={false}
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        // The palette and the layout hotkeys listen on the window in the
        // bubble phase (commands/CommandProvider.tsx). A name being typed here
        // is not a command, so the key does not reach them.
        e.stopPropagation();
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") abandon();
      }}
      // It opens focused and selected, so this is not a target to find. It is
      // one to put the caret back into after a typo, and 22 points is not that.
      // touch:min-h-[44px] takes interactions.md §1a's 44, more than it needs,
      // so the sweep in e2e/phone.spec.ts needs no exception for it. The row
      // grows to hold the field and shrinks back when the rename ends.
      className="w-full rounded border bg-background px-1 py-0.5 text-sm outline-none touch:min-h-[44px]"
    />
  );
}
