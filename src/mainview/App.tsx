import { TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LedgeEditor } from "@/editor/LedgeEditor";

export default function App() {
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
          variant="ghost"
          size="sm"
          disabled
          title="Terminal drawer (coming soon)"
        >
          <TerminalSquare />
          Terminal
        </Button>
      </header>
      <main className="min-h-0 flex-1">
        <LedgeEditor />
      </main>
    </div>
  );
}
