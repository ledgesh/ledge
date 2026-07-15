import { useEffect, useRef } from "react";
import { createEditor } from "./setup";
import { handleRunEvent } from "./blocks";
import { onRunEvent } from "./bridge";
import type { RunEvent } from "../../shared/rpc-schema";

// Seed content: prose plus runnable shell blocks, so the editor demonstrates the
// whole loop on first launch. Built from lines rather than a template literal so
// the ``` fences don't collide with JS backticks.
const INITIAL_DOC = [
  "# Ledge",
  "",
  "Runnable Markdown notes. Drop a shell block below, then press Cmd+Enter inside",
  "it, or click the run button that appears when you hover the block.",
  "",
  "```sh",
  'echo "hello from Ledge on Electrobun"',
  'echo "arch: $(uname -m)"',
  "uname -sr",
  "```",
  "",
  "Output streams into a panel beneath the block. The shell is reused across",
  "runs, so cwd and environment changes persist from one block to the next.",
  "",
  "```sh",
  "pwd",
  "date",
  "```",
  "",
].join("\n");

// Translate a Bun-side RunEvent into the (kind, payload) shape the editor's
// handleRunEvent already understands (its vocabulary predates the RPC).
function applyRunEvent(view: Parameters<typeof handleRunEvent>[0], ev: RunEvent): void {
  if (ev.kind === "began") handleRunEvent(view, ev.id, "started", null);
  else if (ev.kind === "output") handleRunEvent(view, ev.id, "output", ev.dataB64);
  else handleRunEvent(view, ev.id, "finished", ev.exitCode);
}

export function LedgeEditor() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = createEditor(host, INITIAL_DOC);
    const off = onRunEvent((ev) => applyRunEvent(view, ev));
    view.focus();

    return () => {
      off();
      view.destroy();
    };
  }, []);

  return <div ref={hostRef} className="h-full w-full" />;
}
