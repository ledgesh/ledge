// The destination chooser Move Workspace Folder… stops at for EXTERNAL
// workspaces only. A managed folder skips this dialog entirely (the command
// opens the native picker directly); an external one gets two destinations,
// because its natural answer — back under ~/.ledge — is the one place the
// native picker cannot reasonably offer (a hidden folder). Escape (via the
// modal layer stack) or a backdrop click cancels; arrows move between the
// options; Enter takes the focused one.
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

  // Focus lands on the ~/.ledge option: it is the reason this dialog exists
  // (the return trip the picker can't offer), and neither option destroys
  // anything, so the ConfirmDialog's focus-Cancel caution does not apply.
  useEffect(() => {
    homeRef.current?.focus();
  }, []);

  // Escape goes through the shared modal layer stack, same as ConfirmDialog.
  useEffect(() => pushLayer("dialog", onCancel), [onCancel]);

  // Roving focus on arrows; Enter activates the focused option natively.
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
      // Only a click that both started and ended on the backdrop cancels, the
      // same drag guard ConfirmDialog carries.
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
