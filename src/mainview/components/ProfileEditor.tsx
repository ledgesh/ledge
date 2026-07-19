// The profile editor: a modal of KEY=value rows over one profile's env file.
//
// This dialog exists because macOS binds no application to ".env": handing
// the file to the OS editor dead-ends with LSApplicationNotFound, so "the
// file is the UI" needed an in-app editor — the move settings.jsonc later
// adopted too (components/SettingsEditor.tsx). The file on
// disk stays a plain dotenv — greppable, hand-editable — and saves go through
// serializeDotenv, which preserves comments and untouched lines byte-for-byte
// (shared/dotenv.ts), so hand edits and dialog edits coexist.
//
// Values are masked by default: profiles hold exactly the secrets the
// frontmatter design keeps OFF the screen, so the editor must not become the
// place they end up visible anyway. One toggle reveals them deliberately.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Eye, EyeOff, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pushLayer } from "@/commands/layers";
import { copyText, readClipboard } from "@/lib/clipboard";
import { readProfile, writeProfile } from "@/lib/settings";
import { parseDotenvDoc, serializeDotenv } from "../../shared/dotenv";
import { isEnvName } from "../../shared/frontmatter";

// ⌘A/C/X/V on the dialog's inputs, handled in JS: without a native Edit menu
// the webview gets the keydown but none of the standard editing selectors, so
// select-all does nothing and the clipboard keys go nowhere (lib/clipboard.ts
// has the whole story) — and a profile value — an API key from a provider
// dashboard — is exactly the string nobody should have to retype.
// preventDefault doubles as the no-AppKit-beep move the editor's clipboard
// keymap makes by returning true. Copy works on a masked value too: the mask
// governs the screen, not the user's access to their own secret.
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
  // null while the file loads; the dialog frame shows immediately so the
  // command feels instant even if the RPC round trip does not.
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
      // An empty profile opens straight onto a blank row: the next act is
      // always "add a variable", so the dialog starts there.
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

  // A key is wrong only when non-empty and unusable; fully empty rows are
  // simply skipped on save, so an abandoned "Add variable" costs nothing.
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
      // Backdrop click cancels, but only a click that started there (same
      // rule as ConfirmDialog): a drag out of an input must not eat edits.
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
                  className={`h-7 w-40 rounded-md border bg-background px-2 font-mono text-[12px] outline-none focus:border-ring ${
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
                  className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-[12px] outline-none focus:border-ring"
                />
                <button
                  type="button"
                  aria-label="Remove variable"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
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
