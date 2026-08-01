// Which machine you are typing into, always on screen (remote.md §8).
//
// Persistent chrome rather than a menu item, because the failure it prevents
// is running a command on the wrong box, and a fact you have to go looking for
// does not prevent anything. It sits above the workspace strip because that is
// what it scopes: the workspaces, their notes, their trash, their tags and
// their shells all belong to the machine named here, and switching replaces
// every one of them.
//
// Distinct from the `host:` badge a terminal drawer wears, which says where
// one block will RUN. This says where the note lives.
import { useEffect, useState } from "react";
import { Laptop, Server, TriangleAlert } from "lucide-react";
import { useCommands } from "@/commands/CommandProvider";
import { tooltip } from "@/commands/format";
import { activeConnection, connectionStatus, subscribeConnections } from "@/lib/connections";

export function ConnectionBar() {
  const { exec } = useCommands();
  const [, bump] = useState(0);
  useEffect(() => subscribeConnections(() => bump((n) => n + 1)), []);

  const conn = activeConnection();
  const status = connectionStatus();
  const local = conn.destination === "";
  // The one case where the name alone would mislead: the user chose another
  // machine, it could not be opened, and this is the fallback. Saying "This
  // Mac" without saying why would read as a setting that quietly reverted.
  const fellBack = status.wanted !== status.active ? status.error : "";
  const Icon = fellBack ? TriangleAlert : local ? Laptop : Server;

  return (
    <button
      type="button"
      data-connection={conn.id}
      // The command's own tooltip, prefixed with where the notes actually are:
      // the name in the bar is the user's word for the machine, and the
      // destination is the fact.
      title={`${fellBack || (local ? "Notes on this Mac" : `Notes on ${conn.destination}`)} — ${tooltip("connection.switch")}`}
      onClick={() => exec("connection.switch")}
      className="flex w-full items-center gap-1.5 border-b px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent/50"
    >
      <Icon className={`size-3 shrink-0 ${fellBack ? "text-destructive" : ""}`} />
      <span className="min-w-0 flex-1 truncate">{conn.name}</span>
      {fellBack && <span className="shrink-0 text-destructive">not reachable</span>}
    </button>
  );
}
