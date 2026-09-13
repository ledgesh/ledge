// The Attach Folder as Workspace… dialog (interactions.md §3). It asks for one
// thing: the folder's path on the machine that holds the notes. That machine
// checks the path (bun/workspaces.ts attachExternal), and its refusal comes
// back under the field, so a typo is fixed in place rather than read off the
// browser's error strip after the dialog has gone.
//
// `pick` is this client's own folder dialog, offered as a button that fills
// the field. It is null where the client has none (a phone), or where the
// notes are on another machine and this Mac's folders would be the wrong
// filesystem's (workspace/Sidebar.tsx decides). The field is what attaches
// either way: a picked path goes to the server the way a typed one does.
import { useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import { pushLayer } from "@/commands/layers";

export function AttachFolderDialog({
  place,
  pick,
  onAttach,
  onCancel,
}: {
  /** Where the path is: "this Mac", or the server's name. */
  place: string;
  pick: (() => Promise<string | null>) | null;
  /** Resolves to the refusal to show, or to null once the folder is attached,
   * by which point the owner has closed this dialog. */
  onAttach: (path: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fieldRef = useRef<HTMLInputElement>(null);

  // The field takes focus on open: the path is the whole question.
  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  // Escape goes through the shared modal layer stack, same as every dialog.
  useEffect(() => pushLayer("dialog", onCancel), [onCancel]);

  const typed = path.trim();

  const submit = async () => {
    if (typed === "" || busy) return;
    setBusy(true);
    const refusal = await onAttach(typed);
    // Attached: the owner has unmounted this, and there is nothing to show.
    if (refusal === null) return;
    setBusy(false);
    setError(refusal);
    fieldRef.current?.focus();
  };

  const choose = async () => {
    if (!pick) return;
    const picked = await pick();
    // A cancelled picker leaves whatever was typed.
    if (picked) {
      setPath(picked);
      setError(null);
    }
    fieldRef.current?.focus();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-6 pt-24"
      // A click on the backdrop cancels. Clicks inside the dialog bubble up to
      // this handler too, and the target check is what keeps them from
      // cancelling.
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Attach Folder as Workspace"
        className="w-full max-w-sm rounded-lg border bg-background p-4 shadow-xl"
      >
        <h2 className="text-sm font-semibold">Attach Folder as Workspace</h2>
        <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">
          The folder's path on {place}. Its Markdown files become the workspace's notes, and stay
          where they are.
        </p>
        <input
          ref={fieldRef}
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="~/Projects/notes"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          data-testid="attach-folder-field"
          className="mt-3 w-full rounded-md border bg-transparent px-2.5 py-1.5 font-mono text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring touch:min-h-[44px]"
        />
        {error && (
          <p role="alert" data-testid="attach-folder-error" className="mt-2 text-[12px] leading-snug text-destructive">
            {error}
          </p>
        )}
        <div className="mt-3 flex items-center gap-2">
          {pick && (
            <button
              type="button"
              onClick={() => void choose()}
              className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring touch:min-h-[44px]"
            >
              <FolderOpen className="size-4 text-muted-foreground" />
              Choose Folder…
            </button>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-2.5 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring touch:min-h-[44px]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={typed === "" || busy}
            onClick={() => void submit()}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring touch:min-h-[44px]"
          >
            Attach
          </button>
        </div>
      </div>
    </div>
  );
}
