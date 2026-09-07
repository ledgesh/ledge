// The destination chooser behind Move to Folder… and New Folder…
// (interactions.md §3). Both commands ask for a folder of this workspace.
// They differ only in whether the folder exists yet, so one dialog serves
// both.
//
// The field filters and names at once: typing narrows the list, and when the
// text matches no folder the last row offers to create it. That is the
// overlay's empty-state rule, the one behind "Search '…' in note text"
// (interactions.md §1a). Nothing is created until a row is picked, so Escape
// leaves no folder behind.
//
// A pick returns a root-relative folder, never a path (null for the
// workspace's top level). Bun resolves and guards it (bun/notes.ts
// folderPathOf).
import { useEffect, useMemo, useRef, useState } from "react";
import { Folder, FolderPlus, House } from "lucide-react";
import { cn } from "@/lib/utils";
import { pushLayer } from "@/commands/layers";

// The rows a query produces, in the order they are drawn. `folder` is what the
// pick returns, and null means the workspace's top level.
export interface FolderChoice {
  folder: string | null;
  label: string;
  hint?: string;
  create?: true;
}

/** Whether Bun will take this folder name. The shape rules match
 * `folderNameProblem` (shared/folders.ts), except that "" is the root there
 * and not a name here. Checked so the create row is not offered for a name Bun
 * would refuse. Bun's guard is the one that decides, and this one never sees a
 * path. */
export function usableFolderName(query: string): boolean {
  const name = query.trim().replace(/\/+$/, "");
  if (name === "" || name.startsWith("/") || name.includes("\\")) return false;
  return name.split("/").every((s) => s !== "" && s !== "." && s !== ".." && !s.startsWith("."));
}

/**
 * The rows for a query. Pure, so the ordering and the create row's appearance
 * are unit-testable without a DOM.
 *
 * Matching is a case-insensitive substring over the whole folder path, so
 * "api" finds `projects/api`. It is the same forgiving contains-match note
 * search uses (shared/search.ts), not the palette's fuzzy score
 * (notes/fuzzy.ts): a folder list is short, and a wrong pick files the note in
 * the wrong folder.
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
  // The create row appears only when no folder answers to that exact name.
  // With `projects` already in the list above, a New folder “projects” row
  // would be a second row for the same outcome, and it reads as though picking
  // it makes a folder.
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
  // The highlight is what Enter takes, so it never points past the last row.
  // Typing puts it back on the first row (the field's onChange below). This
  // clamp covers the list shrinking without a keystroke, when the `folders`
  // prop changes under the open dialog.
  const index = Math.min(at, Math.max(choices.length - 1, 0));

  // The field takes focus on open, with its text selected. Typing both filters
  // the list and names a new folder, so focusing anything else would cost a
  // click before the dialog is usable.
  useEffect(() => {
    fieldRef.current?.focus();
    fieldRef.current?.select();
  }, []);

  // Escape goes through the shared modal layer stack, same as every dialog.
  useEffect(() => pushLayer("dialog", onCancel), [onCancel]);

  // Keep the highlighted row on screen. This runs when the arrows move the
  // highlight and when the list changes length.
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
                // The highlight follows the pointer, so the row under the
                // cursor is always the row Enter takes.
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
