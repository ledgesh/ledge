// A modal confirmation. interactions.md §4 sets which actions get one, in
// three classes: unlinking a file (Empty Trash, Delete Permanently); a
// reversible delete whose extent is off screen, where a collapsed row does not
// say whether it holds one note or forty (Delete Folder); and a consequence
// rather than a destruction, where the body becomes readable again by anything
// that syncs the folder (Remove Lock). Deleting one note is none of these. It
// moves the note to the trash, where Undo and Restore bring it back, and a
// prompt in front of an undoable action costs a click every time.
//
// A run marked `confirm` on its fence is the remaining caller (§4b). It shares
// this component so that every confirmation in the app looks alike. `detail` is
// what that caller needed: the block's own code. A custom `confirm="…"`
// question is a headline, not a substitute for reading what runs.
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { pushLayer } from "@/commands/layers";

export function ConfirmDialog({
  title,
  body,
  detail,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  detail?: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus lands on Cancel, not on the destructive button: a stray Return or
  // Space arriving right after the click that opened this must not confirm it.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Escape goes through the shared modal layer stack. Only the topmost layer
  // sees it: this dialog, unless a menu sits above it. The window command
  // dispatcher stays suppressed while the dialog is up (resolveChord in
  // commands/keymap.ts, interactions.md §6).
  useEffect(() => pushLayer("dialog", onCancel), [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      // A click on the backdrop cancels, but only one that both started and
      // ended there. A drag that begins on the text and releases outside must
      // not dismiss the dialog it came from.
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full rounded-lg border bg-background p-4 shadow-xl ${detail ? "max-w-md" : "max-w-sm"}`}
      >
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">{body}</p>
        {detail !== undefined && (
          // Scrolls rather than growing: a long block must not push the
          // buttons off the screen. The height cuts off the end rather than
          // the start, because the first lines are the ones that say what the
          // block is.
          <pre className="mt-3 max-h-48 overflow-auto rounded border bg-muted/50 p-2 font-mono text-[12px] leading-snug whitespace-pre">
            {detail}
          </pre>
        )}
        {/* Both buttons grow to 44 points on a client with no pointer
            (interactions.md §1a), and the gap between them doubles (§4b). The
            buttons pass `sm` below and the row `gap-2`: nominally a 32-point
            button 8 points from its neighbour, and less than that at this
            root. That is a comfortable pair to click and a cramped pair to
            tap. Here Cancel sits beside the button that empties the trash or
            runs `rm -rf`, so a mis-tap runs the action the dialog exists to
            prevent. Focus lands on Cancel, which disarms a stray Return. A
            phone has no Return, so the sizes stand in for that protection.

            The touch sizes are written in pixels rather than the rem-based
            `h-11`/`gap-4`: this document's root is 14px, so those utilities
            would have given 38.5 and 14. ContextMenu.tsx spells out the same
            reason. */}
        <div className="mt-4 flex justify-end gap-2 touch:gap-[16px]">
          <Button
            ref={cancelRef}
            size="sm"
            variant="ghost"
            className="touch:h-[44px] touch:px-5 touch:text-sm"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            className="touch:h-[44px] touch:px-5 touch:text-sm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
