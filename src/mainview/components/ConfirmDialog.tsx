// A modal confirmation, deliberately rare.
//
// Delete does not use this and should not: it moves a note to the trash, where
// Undo and Restore are waiting, so a prompt would cost a click every time to
// guard against something already reversible. The callers are the two actions
// that destroy a note outright — Empty Trash, and Delete Permanently on one
// trashed note — and nothing else should join them without also being an
// unlink (docs/interactions.md §4).
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { pushLayer } from "@/commands/layers";

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
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
        className="w-full max-w-sm rounded-lg border bg-background p-4 shadow-xl"
      >
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button ref={cancelRef} size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
