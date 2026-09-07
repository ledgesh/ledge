// The profile editor: a modal of KEY=value rows over one profile's env file.
//
// The dialog is in-app because macOS binds no application to ".env": handing
// the file to the OS editor dead-ends with LSApplicationNotFound
// (architecture.md §6a). Settings later adopted the same shape by choice
// (§6; components/SettingsEditor.tsx).
//
// The file on disk stays a plain dotenv, greppable and editable by hand.
// Saves go through serializeDotenv, which preserves comments and untouched
// lines byte for byte (shared/dotenv.ts), so a person's hand edits and the
// dialog's edits coexist rather than one rewriting the other.
//
// Values are masked by default. A profile's values are resolved Bun-side at
// spawn and otherwise never reach the webview process (architecture.md §6a).
// This dialog is the one exception, so it must not become the place those
// secrets end up on screen. "Show values" reveals them.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Eye, EyeOff, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pushLayer } from "@/commands/layers";
import { copyText, readClipboard } from "@/lib/clipboard";
import { readProfile, writeProfile } from "@/lib/settings";
import { parseDotenvDoc, serializeDotenv } from "../../shared/dotenv";
import { isEnvName } from "../../shared/frontmatter";

// ⌘A/C/X/V on the dialog's inputs, handled in JS. Without a native Edit menu
// the webview gets the keydown but none of the standard editing selectors, so
// select-all does nothing and the clipboard keys go nowhere (lib/clipboard.ts).
// preventDefault also keeps the key from reaching AppKit and ringing the
// system alert (editor/clipboard.ts). Paste is how an API key gets from a
// provider dashboard into this dialog. Copy works on a masked value.
function clipboardKeys(e: KeyboardEvent<HTMLInputElement>, setValue: (v: string) => void): void {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
  const key = e.key.toLowerCase();
  if (key === "a") {
    e.preventDefault();
    e.currentTarget.select();
    return;
  }
  if (key !== "c" && key !== "x" && key !== "v") return;
  e.preventDefault();
  const value = e.currentTarget.value;
  const start = e.currentTarget.selectionStart ?? value.length;
  const end = e.currentTarget.selectionEnd ?? value.length;
  if (key === "v") {
    void readClipboard().then((clip) => {
      if (clip) setValue(value.slice(0, start) + clip + value.slice(end));
    });
    return;
  }
  const selected = value.slice(start, end);
  if (!selected) return;
  copyText(selected);
  if (key === "x") setValue(value.slice(0, start) + value.slice(end));
}

interface Row {
  // The file line this row came from; null for rows added in the dialog.
  line: number | null;
  key: string;
  value: string;
  exported: boolean;
}

export function ProfileEditor({ name, onClose }: { name: string; onClose: () => void }) {
  // null while the file loads. The dialog frame renders right away, with a
  // "Loading…" line where the rows will go, so the command opens the dialog
  // without waiting for the read round trip to Bun.
  const [text, setText] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [reveal, setReveal] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void readProfile(name).then((t) => {
      if (!alive) return;
      setText(t);
      const parsed = parseDotenvDoc(t);
      // An empty profile opens on one blank row, since the next step is
      // always adding a variable.
      setRows(parsed.length > 0 ? parsed : [{ line: null, key: "", value: "", exported: false }]);
    });
    return () => {
      alive = false;
    };
  }, [name]);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, [text]);

  // Escape via the shared layer stack, like every modal (interactions.md §6).
  useEffect(() => pushLayer("dialog", onClose), [onClose]);

  const set = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  // A row's key is wrong only when the row has content and that key is not a
  // usable variable name. Rows with an empty key and an empty value are
  // skipped on save, so an abandoned "Add variable" changes nothing.
  const badKey = (r: Row) => (r.key !== "" || r.value !== "") && !isEnvName(r.key);
  const savable = text !== null && !rows.some(badKey);

  const save = async () => {
    if (!savable || text === null) return;
    const kept = rows.filter((r) => r.key !== "" || r.value !== "");
    await writeProfile(name, serializeDotenv(text, kept));
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      // A click on the backdrop cancels, but only a click that started there
      // (the same rule as ConfirmDialog). A drag that starts in an input and
      // ends outside it must not discard the edits.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Profile ${name}`}
        className="w-full max-w-2xl rounded-lg border bg-background p-4 shadow-xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            Profile <span className="font-mono">{name}</span>
          </h2>
          <button
            type="button"
            className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
            onClick={() => setReveal((v) => !v)}
          >
            {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {reveal ? "Hide values" : "Show values"}
          </button>
        </div>
        <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
          Environment variables for profile <span className="font-mono">{name}</span>.
        </p>

        <div className="mt-3 flex max-h-72 flex-col gap-1.5 overflow-y-auto">
          {text === null ? (
            <p className="py-2 text-[12px] text-muted-foreground">Loading…</p>
          ) : (
            rows.map((r, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  ref={i === 0 ? firstFieldRef : undefined}
                  value={r.key}
                  placeholder="NAME"
                  spellCheck={false}
                  autoCapitalize="off"
                  aria-label="Variable name"
                  aria-invalid={badKey(r)}
                  onChange={(e) => set(i, { key: e.target.value })}
                  onKeyDown={(e) => clipboardKeys(e, (v) => set(i, { key: v }))}
                  className={`h-7 w-40 rounded-md border bg-background px-2 font-mono text-[12px] outline-none focus:border-ring touch:h-[44px] ${
                    badKey(r) ? "border-destructive" : "border-input"
                  }`}
                />
                <input
                  value={r.value}
                  placeholder="value"
                  type={reveal ? "text" : "password"}
                  spellCheck={false}
                  autoCapitalize="off"
                  aria-label="Variable value"
                  onChange={(e) => set(i, { value: e.target.value })}
                  onKeyDown={(e) => clipboardKeys(e, (v) => set(i, { value: v }))}
                  className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-[12px] outline-none focus:border-ring touch:h-[44px]"
                />
                <button
                  type="button"
                  aria-label="Remove variable"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground touch:size-[44px]"
                  onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="mt-3 flex items-center justify-between">
          <Button
            size="sm"
            variant="ghost"
            className="gap-1 text-muted-foreground"
            disabled={text === null}
            onClick={() => setRows((rs) => [...rs, { line: null, key: "", value: "", exported: false }])}
          >
            <Plus className="h-3.5 w-3.5" /> Add variable
          </Button>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={!savable} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
