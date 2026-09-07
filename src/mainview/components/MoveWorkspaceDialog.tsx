// The destination chooser Move Workspace Folder… stops at when the workspace
// is external. A managed one goes straight to the native picker
// (commands/registry.ts), which does not readily reach the hidden ~/.ledge.
// So this dialog offers two destinations: ~/.ledge and that picker. Escape
// or a backdrop click cancels. Arrows move focus. Enter takes the focused one.
import { useEffect, useRef } from "react";
import { FolderInput, House } from "lucide-react";
import { pushLayer } from "@/commands/layers";

const optionClass =
  "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function MoveWorkspaceDialog({
  name,
  onHome,
  onPicker,
  onCancel,
}: {
  name: string;
  onHome: () => void;
  onPicker: () => void;
  onCancel: () => void;
}) {
  const homeRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Focus lands on the ~/.ledge option, the destination this dialog exists to
  // offer. Neither option destroys anything, so this does not need
  // ConfirmDialog's caution about focusing Cancel.
  useEffect(() => {
    homeRef.current?.focus();
  }, []);

  // Escape goes through the shared modal layer stack, same as ConfirmDialog.
  useEffect(() => pushLayer("dialog", onCancel), [onCancel]);

  // Roving focus: the arrows move between the options. Enter has no handler
  // here, since it already activates the focused button.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? at + 1 : at - 1;
    items[(next + items.length) % items.length]?.focus();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      // A click on the backdrop cancels, but only one that both started and
      // ended there. ConfirmDialog carries the same drag guard.
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Move Workspace Folder"
        className="w-full max-w-sm rounded-lg border bg-background p-4 shadow-xl"
      >
        <h2 className="text-sm font-semibold">Move Workspace Folder</h2>
        <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">
          Where should “{name}” live? Every note travels with the folder.
        </p>
        <div ref={listRef} className="mt-3 flex flex-col gap-1" onKeyDown={onKeyDown}>
          <button ref={homeRef} className={optionClass} onClick={onHome}>
            <House className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">Move to ~/.ledge</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                Back under Ledge's home folder
              </span>
            </span>
          </button>
          <button className={optionClass} onClick={onPicker}>
            <FolderInput className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">Choose Another Location…</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                Opens the folder picker
              </span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
