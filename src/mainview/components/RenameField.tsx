// The inline "type a new name here" input, shared by the workspace strip and the
// note list. Enter or blur commits, Escape abandons.
//
// The autocorrect attributes are not boilerplate: this is a native <input> in a
// WKWebView, where macOS text substitution is on by default and will capitalise
// and "correct" a name as you type it ("sh" becomes "Sh"). Filenames must be the
// characters the user typed.
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
  // Escape unmounts this field, which fires a blur on the way out; without this
  // the abandoned draft would be committed by the blur handler anyway.
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
        // The palette and the layout hotkeys both listen on the window; a name
        // being typed here is not a command.
        e.stopPropagation();
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") abandon();
      }}
      // It opens focused and selected, so this is not a target to FIND; it is
      // one to put a caret back into after the first thing you typed was wrong,
      // and 22 points is not that. Taking §1a's 44 rather than a smaller number
      // that would also do, so the sweep in phone.spec.ts has no exception to
      // carry: the row it sits in grows to hold it and shrinks back after.
      className="w-full rounded border bg-background px-1 py-0.5 text-sm outline-none touch:min-h-[44px]"
    />
  );
}
