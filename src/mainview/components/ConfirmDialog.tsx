// A modal confirmation, deliberately rare.
//
// Deleting a NOTE does not use this and should not: it moves the note to the
// trash, where Undo and Restore are waiting, so a prompt would cost a click
// every time to guard against something already reversible. Two callers are
// here because they destroy a note outright — Empty Trash, and Delete
// Permanently on one trashed note — and nothing new that unlinks may skip
// them (interactions.md §4).
//
// Two more are here for a CONSEQUENCE rather than for an unlink, which is the
// narrower door and worth stating so it stays narrow. Remove Lock: nothing is
// destroyed, but the body is readable again by anything that syncs the folder.
// Delete Folder: everything lands in the trash and the Undo strip comes up
// behind the dialog, but a collapsed row does not say whether it holds one
// note or forty, and the dialog is where that number gets said. What does not
// earn one is an action whose extent is on screen and whose undo is a click —
// which is every other delete in the app.
//
// The one caller the USER opts into is a run marked `confirm` on its fence
// (§4b): it is here rather than in its own component because a confirmation
// that looks different from the app's other confirmations reads as a
// different kind of question. `detail` is what that caller needed: the block's
// own code, because the fence body is the truth and a custom `confirm="…"`
// question is a headline, not a substitute for reading it.
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

  // Escape goes through the shared modal layer stack: only the topmost layer
  // (this dialog, unless a menu sits above it) sees it, and the window command
  // dispatcher is suppressed while the dialog is up.
  useEffect(() => pushLayer("dialog", onCancel), [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      // A click on the backdrop cancels, but only a click that both started and
      // ended there: a drag that begins on the text and releases outside must
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
          // buttons off the screen, and the first lines are the ones that
          // say what this is.
          <pre className="mt-3 max-h-48 overflow-auto rounded border bg-muted/50 p-2 font-mono text-[12px] leading-snug whitespace-pre">
            {detail}
          </pre>
        )}
        {/* Both buttons grow to 44 points on a client with no pointer, and the
            gap between them grows with them. A `sm` button is 32 points 8 points
            from its neighbour, which is a comfortable pair to click and an
            uncomfortable pair to tap — and the pair here is Cancel beside the
            button that runs `rm -rf` (interactions.md §4b), where the mis-tap is
            not a mis-tap but the thing the dialog exists to prevent. Focus still
            lands on Cancel; that just stops meaning anything without a keyboard
            behind it, which is why the sizes have to carry it instead.

            Pixels rather than the rem-based `h-11`/`gap-4`, for the reason
            ContextMenu.tsx spells out: this document's root is 14px, so those
            utilities would have given 38.5 and 14. */}
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
