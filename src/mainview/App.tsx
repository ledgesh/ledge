import { useCallback, useEffect, useRef, useState } from "react";
import { TerminalSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LedgeEditor } from "@/editor/LedgeEditor";
import { TerminalDrawer } from "@/terminal/TerminalDrawer";
import { configureBridge } from "@/editor/bridge";
import { sendTerminalText } from "@/terminal/channel";

export default function App() {
  const [termOpen, setTermOpen] = useState(false);
  // A "run in terminal" fired while the drawer is closed queues its command here
  // and flushes once the terminal has mounted, so its output is not dropped.
  const pending = useRef<string | null>(null);

  const runInTerminal = useCallback(
    (code: string) => {
      const cmd = code.endsWith("\n") ? code : code + "\n";
      if (termOpen) {
        sendTerminalText(cmd);
      } else {
        pending.current = cmd;
        setTermOpen(true);
      }
    },
    [termOpen],
  );

  // The editor bridges Ctrl+` (toggle) and "run in terminal" here; main.tsx wires
  // the RPC-backed inline-run handler separately, and configureBridge merges.
  useEffect(() => {
    configureBridge({
      toggleTerminal: () => setTermOpen((o) => !o),
      runInTerminal,
    });
  }, [runInTerminal]);

  const onTerminalReady = useCallback(() => {
    if (pending.current) {
      sendTerminalText(pending.current);
      pending.current = null;
    }
  }, []);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <span className="h-2 w-2 rounded-full bg-primary" />
        <span className="text-sm font-semibold">Ledge</span>
        <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-secondary-foreground">
          Electrobun
        </span>
        <div className="flex-1" />
        <Button
          variant={termOpen ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setTermOpen((o) => !o)}
          title="Toggle terminal (Ctrl+`)"
        >
          <TerminalSquare />
          Terminal
        </Button>
      </header>

      <main className="min-h-0 flex-1">
        <LedgeEditor />
      </main>

      {termOpen && (
        <section className="flex h-[280px] shrink-0 flex-col border-t bg-background">
          <div className="flex h-7 shrink-0 items-center gap-2 border-b px-2">
            <TerminalSquare className="size-3.5 text-muted-foreground" />
            <span className="text-[11px] font-medium text-muted-foreground">Terminal</span>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={() => setTermOpen(false)}
              title="Close terminal"
            >
              <X className="size-3.5" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden p-1.5">
            <TerminalDrawer onReady={onTerminalReady} />
          </div>
        </section>
      )}
    </div>
  );
}
