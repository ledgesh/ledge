// The bar names the machine the notes are on, and it is always on screen
// (remote.md §8). Persistent chrome rather than a menu item: the failure it
// prevents is running a command on the wrong box, and a fact hidden behind a
// menu prevents nothing (interactions.md §4-1). The drawer's `host:` badge
// says where one block runs; this says where the note lives.
import { useEffect, useState } from "react";
import { ChevronsUpDown, Laptop, PlugZap, RotateCw, Server, TriangleAlert, Users } from "lucide-react";
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
  // The error that explains a fallback, and empty when there was none. The
  // connection the user chose could not be opened, so the app fell back to
  // this Mac (bun/connectionManager.ts). "This Mac" with no reason beside it
  // would read as a setting that reverted on its own.
  const fellBack = status.wanted !== status.active ? status.error : "";
  // A dropped wire decides the verb, ahead of the fallback. The machine named
  // here is still the right machine, and what changed is whether it can be
  // reached right now (remote.md §7). Without this the bar would say nothing
  // while requests went unanswered.
  const dropped = link.state !== "live";
  // What the wide half does. Reconnect leads while the machine cannot be
  // reached. A switch reloads the page, so ConnectionPicker.tsx flushes every
  // dirty note first and refuses if any are still unsaved after that flush. A
  // chooser that opened in order to refuse would be the app's whole visible
  // answer to being disconnected (interactions.md §4-1). Reconnect is not the
  // only way back, because the app dials on its own (remote.md §7). It is for
  // the person who can see their wifi return before the next attempt is due.
  const verb = dropped ? "connection.reconnect" : "connection.switch";
  const Icon = fellBack || link.state === "lost" ? TriangleAlert : dropped ? PlugZap : local ? Laptop : Server;
  const trouble = fellBack || (dropped ? link.detail : "");
  // The card's second line: the trouble while there is some ("not
  // reachable", "reconnecting…", "disconnected"), and otherwise the address
  // the name stands for. Trouble replaces the address rather than joining the
  // name's line, so a long machine name and a dropped wire never compete for
  // the same few pixels of a narrow sidebar (interactions.md §4-1).
  const state = fellBack
    ? "not reachable"
    : link.state === "reconnecting"
      ? "reconnecting…"
      : link.state === "lost"
        ? "disconnected"
        : "";
  const detail = state || (local ? conn.name : conn.destination);
  // Who else is on this machine (remote.md §7). Nothing is drawn while nobody
  // else is, which is nearly always: "1 device" would be noise in a strip that
  // must stay readable at a glance. One other device is named, since it is the
  // one that can take a shell away (interactions.md §4-2). Past that the names
  // stop fitting, so the count shows, with the whole list a hover away.
  const others = presence();
  const company = others.length === 0 ? "" : others.length === 1 ? others[0]!.label || "another device" : `${others.length} devices`;
  const names = others.map((o) => o.label || "an unnamed device").join(", ");
  // The trailing glyph names the verb, so the bar's two actions are told apart
  // before the click: a switcher's chevrons, or the dial-now arrow while the
  // link is down.
  const Verb = dropped ? RotateCw : ChevronsUpDown;

  return (
    // A section of its own, headed like the Workspaces and Notes sections
    // below it, with the machine drawn as a card like a selected workspace
    // row. The heading says what the name is: "v1" alone names nothing
    // (interactions.md §4-1).
    <div className="shrink-0 border-b">
      <div className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Server</div>
      {/* A split button while the link is down, on the pattern the workspace
          strip uses for New Workspace (Sidebar.tsx): the wide half is the verb
          for the moment, the narrow half the other one. One button meant the
          switcher was gone while disconnected, so a window that could not
          reconnect could not leave either (interactions.md §4-1). */}
      <div className="px-1.5 pb-2">
        <div className="flex w-full items-stretch overflow-hidden rounded-md border bg-accent/60">
          <button
            type="button"
            data-connection={conn.id}
            data-link={link.state}
            // The command's own tooltip, prefixed with where the notes are: the
            // name on the card is the user's word for the machine, and the
            // destination is its address.
            title={`${trouble || (local ? "Notes on this Mac" : `Notes on ${conn.destination}`)} — ${tooltip(verb)}`}
            onClick={() => exec(verb)}
            // The same height as a workspace row, and the touch minimum of one
            // (interactions.md §1a).
            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left hover:bg-accent touch:min-h-[44px]"
          >
            <Icon className={`size-4 shrink-0 ${trouble ? "text-destructive" : "text-muted-foreground"}`} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium leading-tight text-foreground">{conn.name}</span>
              <span className="flex items-center gap-1 text-[11px] leading-tight">
                <span
                  className={`min-w-0 truncate ${
                    !state || (link.state === "reconnecting" && !fellBack) ? "text-muted-foreground" : "text-destructive"
                  }`}
                >
                  {detail}
                </span>
                {company && (
                  // Its own title rather than a clause in the button's: a hover
                  // over the chip should give the full list, and the button's
                  // tooltip is about switching machines. The address truncates
                  // first, and at the narrowest sidebar the chip does too.
                  <span
                    className="ml-auto flex min-w-0 shrink items-center gap-1 text-muted-foreground"
                    title={`Also on this server: ${names}`}
                    data-presence={others.length}
                  >
                    <Users className="size-3 shrink-0" />
                    <span className="truncate">{company}</span>
                  </span>
                )}
              </span>
            </span>
            <Verb className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
          {dropped && (
            <button
              type="button"
              data-switch=""
              title={tooltip("connection.switch")}
              onClick={() => exec("connection.switch")}
              // The narrow half of a split button, so its width is a touch
              // target too: the two halves touch, and a miss here dials instead
              // of choosing.
              className="flex items-center border-l px-2.5 text-muted-foreground hover:bg-accent touch:min-w-[44px] touch:justify-center"
            >
              <ChevronsUpDown className="size-3.5 shrink-0" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
