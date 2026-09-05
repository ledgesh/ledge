// Where a note goes: the destination chooser behind Move to Folder… and New
// Folder… (interactions.md §3).
//
// One dialog for both because both ask the same question — name a folder of
// this workspace — and the only difference is whether the folder is expected to
// exist yet. So the field FILTERS and NAMES at once: type to narrow the list,
// and when what you typed matches no folder, the last row offers to create it.
// That is the overlay's rule about empty states ("Search '…' in note text",
// §1a): where a mode runs out, offer the next one instead of reporting the
// emptiness. Nothing is created until a row is picked — Escape leaves no
// folder behind.
//
// The view never learns a path here: what comes back is a ROOT-RELATIVE folder
// (null for the workspace's top level) which Bun resolves and guards
// (bun/notes.ts folderPathOf).
import { useEffect, useMemo, useRef, useState } from "react";
import { Folder, FolderPlus, House } from "lucide-react";
import { cn } from "@/lib/utils";
import { pushLayer } from "@/commands/layers";

// The rows a query produces, in the order they are drawn. `folder` is what the
// pick resolves to; null is the workspace's top level.
export interface FolderChoice {
  folder: string | null;
  label: string;
  hint?: string;
  create?: true;
}

/** Is this a folder name Bun will take? The same shape rules as
 * folderPathOf's, checked here only so a doomed row is not offered — the guard
 * that matters is Bun's, and this one never sees a path. */
export function usableFolderName(query: string): boolean {
  const name = query.trim().replace(/\/+$/, "");
  if (name === "" || name.startsWith("/") || name.includes("\\")) return false;
  return name.split("/").every((s) => s !== "" && s !== "." && s !== ".." && !s.startsWith("."));
}

/**
 * The rows for a query. Pure, so the ordering and the create-row's appearance
 * are unit-testable without a DOM.
 *
 * Matching is a case-insensitive substring over the whole folder path, so
 * "api" finds `projects/api` — the same forgiving contains-match the note
 * lists use, not a fuzzy score: a folder list is short and a wrong destination
 * is a note filed somewhere you did not mean.
 */
export function folderChoices(
  folders: readonly string[],
  query: string,
  allowRoot: boolean,
): FolderChoice[] {
  const q = query.trim().replace(/\/+$/, "");
  const lower = q.toLowerCase();
  const out: FolderChoice[] = [];
  if (allowRoot && (q === "" || "top level".includes(lower))) {
    out.push({ folder: null, label: "Top level", hint: "The workspace folder itself" });
  }
  for (const folder of folders) {
    if (q === "" || folder.toLowerCase().includes(lower)) out.push({ folder, label: folder });
  }
  // Only when nothing already answers to that exact name: offering to create
  // `projects` while `projects` is in the list above would be two rows for one
  // outcome, and the wrong one is the destructive-looking one.
  if (q !== "" && usableFolderName(q) && !folders.some((f) => f.toLowerCase() === lower)) {
    out.push({ folder: q, label: `New folder “${q}”`, hint: "Created when you pick it", create: true });
  }
  return out;
}

export function FolderPicker({
  title,
  description,
  folders,
  allowRoot = true,
  initialQuery = "",
  onPick,
  onCancel,
}: {
  title: string;
  description: string;
  folders: readonly string[];
  allowRoot?: boolean;
  initialQuery?: string;
  onPick: (folder: string | null) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [at, setAt] = useState(0);
  const fieldRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const choices = useMemo(() => folderChoices(folders, query, allowRoot), [folders, query, allowRoot]);
  // A query that narrowed the list past the highlight puts it back on the first
  // row: the highlight is what Enter takes, and one pointing past the end would
  // make Enter do nothing with a row plainly on screen.
  const index = Math.min(at, Math.max(choices.length - 1, 0));

  // The field takes focus: typing is how you both filter and name, so anything
  // else would cost a click before the dialog is usable.
  useEffect(() => {
    fieldRef.current?.focus();
    fieldRef.current?.select();
  }, []);

  // Escape goes through the shared modal layer stack, same as every dialog.
  useEffect(() => pushLayer("dialog", onCancel), [onCancel]);

  // Keep the highlighted row on screen while the arrows walk past the fold.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index, choices.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (choices.length === 0) return;
      const next = e.key === "ArrowDown" ? index + 1 : index - 1;
      setAt((next + choices.length) % choices.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const choice = choices[index];
      if (choice) onPick(choice.folder);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-6 pt-24"
      // Only a click that both started and ended on the backdrop cancels, the
      // same drag guard ConfirmDialog carries.
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[60vh] w-full max-w-sm flex-col rounded-lg border bg-background p-4 shadow-xl"
      >
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">{description}</p>
        <input
          ref={fieldRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setAt(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Folder name"
          spellCheck={false}
          autoComplete="off"
          data-testid="folder-picker-field"
          className="mt-3 w-full rounded-md border bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring touch:min-h-[44px]"
        />
        <div ref={listRef} className="mt-2 min-h-0 flex-1 overflow-y-auto">
          {choices.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
              No folder by that name, and it is not one Ledge can make. Folder names cannot start
              with a dot or contain \ characters.
            </p>
          ) : (
            choices.map((choice, i) => (
              <button
                key={choice.create ? `new:${choice.folder}` : (choice.folder ?? ":root")}
                data-active={i === index}
                data-testid={choice.create ? "folder-picker-create" : "folder-picker-row"}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left touch:min-h-[44px]",
                  i === index ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                )}
                // The highlight follows the pointer, so the row Enter takes and
                // the row under the cursor are never two different rows.
                onMouseMove={() => setAt(i)}
                onClick={() => onPick(choice.folder)}
              >
                {choice.create ? (
                  <FolderPlus className="size-4 shrink-0 text-muted-foreground" />
                ) : choice.folder === null ? (
                  <House className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{choice.label}</span>
                  {choice.hint && (
                    <span className="block truncate text-[11px] text-muted-foreground">{choice.hint}</span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
