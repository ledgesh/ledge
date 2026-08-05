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
import { Laptop, PlugZap, Server, TriangleAlert, Users } from "lucide-react";
import { useCommands } from "@/commands/CommandProvider";
import { tooltip } from "@/commands/format";
import { activeConnection, connectionStatus, linkState, presence, subscribeConnections } from "@/lib/connections";

export function ConnectionBar() {
  const { exec } = useCommands();
  const [, bump] = useState(0);
  useEffect(() => subscribeConnections(() => bump((n) => n + 1)), []);

  const conn = activeConnection();
  const status = connectionStatus();
  const link = linkState();
  const local = conn.destination === "";
  // The one case where the name alone would mislead: the user chose another
  // machine, it could not be opened, and this is the fallback. Saying "This
  // Mac" without saying why would read as a setting that quietly reverted.
  const fellBack = status.wanted !== status.active ? status.error : "";
  // A dropped wire outranks it: the machine named here is still the right
  // machine, and what changed is whether we can currently reach it
  // (remote.md §7). Saying nothing while requests pile up unanswered is the
  // failure this exists to prevent.
  const dropped = link.state !== "live";
  const Icon = fellBack || link.state === "lost" ? TriangleAlert : dropped ? PlugZap : local ? Laptop : Server;
  const trouble = fellBack || (dropped ? link.detail : "");
  // Who else is on this machine (remote.md §7). Nothing at all when nobody is,
  // which is nearly always: a count that says "1 device" while you are alone is
  // noise in the one strip that must stay readable at a glance. One other is
  // worth naming, since it is the device that can take a shell from under you;
  // past that the names stop fitting and the number is the useful part, with the
  // whole list a hover away.
  const others = presence();
  const company = others.length === 0 ? "" : others.length === 1 ? others[0]!.label || "another device" : `${others.length} devices`;
  const names = others.map((o) => o.label || "an unnamed device").join(", ");

  return (
    <button
      type="button"
      data-connection={conn.id}
      data-link={link.state}
      // The command's own tooltip, prefixed with where the notes actually are:
      // the name in the bar is the user's word for the machine, and the
      // destination is the fact.
      title={`${trouble || (local ? "Notes on this Mac" : `Notes on ${conn.destination}`)} — ${tooltip("connection.switch")}`}
      onClick={() => exec("connection.switch")}
      // 21 points, flush against the workspace strip below it, for the control
      // that replaces every note, tab, tag and shell on screen (§1a). The text
      // stays 11px: this is a physical target, not a bigger label.
      className="flex w-full items-center gap-1.5 border-b px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent/50 touch:min-h-[44px]"
    >
      <Icon className={`size-3 shrink-0 ${trouble ? "text-destructive" : ""}`} />
      <span className="min-w-0 flex-1 truncate">{conn.name}</span>
      {company && (
        // Its own title rather than a clause in the button's: the full list is
        // what a hover over this chip should say, and the button's tooltip is
        // about switching machines.
        <span className="flex max-w-[50%] shrink-0 items-center gap-1 truncate" title={`Also on this server: ${names}`} data-presence={others.length}>
          <Users className="size-3 shrink-0" />
          <span className="truncate">{company}</span>
        </span>
      )}
      {fellBack && <span className="shrink-0 text-destructive">not reachable</span>}
      {!fellBack && link.state === "reconnecting" && <span className="shrink-0">reconnecting…</span>}
      {!fellBack && link.state === "lost" && <span className="shrink-0 text-destructive">disconnected</span>}
    </button>
  );
}
