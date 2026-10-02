// About Ledge (interactions.md §10). It shows the line `ledge --version` prints
// and the launch log opens with (shared/version.ts versionLine), plus the
// server this window is on, and copies both for a bug report. It is the same
// dialog on every client: the Mac's menu item runs this command rather than
// AppKit's own About panel, which knows no channel, build hash or server.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { pushLayer } from "@/commands/layers";
import { aboutText, appInfo } from "@/lib/about";
import { copyText } from "@/lib/clipboard";
import { activeConnection, connectionStatus } from "@/lib/connections";
import type { AppInfo } from "../../shared/version";

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    appInfo().then(setInfo, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => pushLayer("dialog", onClose), [onClose]);

  const text = info ? aboutText(info, connectionStatus(), activeConnection().name) : "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      // ConfirmDialog's backdrop rule: only a click that starts and ends here.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="About Ledge"
        className="w-full max-w-md rounded-lg border bg-background p-4 shadow-xl"
        data-testid="about-dialog"
      >
        <h2 className="text-sm font-semibold">{info ? `Ledge ${info.version}` : "Ledge"}</h2>
        <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">
          {error || "Paste these lines into a bug report."}
        </p>
        {/* Selectable as well as copyable: some people copy by hand. */}
        <pre
          data-testid="about-text"
          className="mt-3 min-h-[2.5em] overflow-x-auto rounded border bg-muted/50 p-2 font-mono text-[12px] leading-snug whitespace-pre select-text"
        >
          {text}
        </pre>
        <div className="mt-4 flex justify-end gap-2 touch:gap-[16px]">
          <Button
            size="sm"
            variant="ghost"
            className="touch:h-[44px] touch:px-5 touch:text-sm"
            disabled={text === ""}
            onClick={() => {
              copyText(text);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button ref={closeRef} size="sm" className="touch:h-[44px] touch:px-5 touch:text-sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
