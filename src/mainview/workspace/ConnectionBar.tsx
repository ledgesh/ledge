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
  // The one case where the name alone would mislead: the user chose another
  // machine, it could not be opened, and this is the fallback. Saying "This
  // Mac" without saying why would read as a setting that quietly reverted.
  const fellBack = status.wanted !== status.active ? status.error : "";
  // A dropped wire outranks it: the machine named here is still the right
  // machine, and what changed is whether we can currently reach it
  // (remote.md §7). Saying nothing while requests pile up unanswered is the
  // failure this exists to prevent.
  const dropped = link.state !== "live";
  // What the wide half DOES, which is not always the same verb. Switching
  // machines is the everyday one, and it is the wrong one to offer FIRST at the
  // moment the machine you are on cannot be reached: the switch reloads the
  // page, so it is refused outright while anything is unsaved
  // (ConnectionPicker), and a bar that answered a dropped connection by opening
  // a chooser that then said no would be the app's only visible response to
  // being disconnected.
  //
  // The app is already dialling on its own (remote.md §7), so this is never the
  // only way back. It is for the person who can see their wifi return and is
  // holding information the beat does not have.
  const verb = dropped ? "connection.reconnect" : "connection.switch";
  const Icon = fellBack || link.state === "lost" ? TriangleAlert : dropped ? PlugZap : local ? Laptop : Server;
  const trouble = fellBack || (dropped ? link.detail : "");
  // The state gets its own line rather than a corner of the name's, so a long
  // machine name and a dropped wire stop competing for the same few pixels in
  // a narrow sidebar. Nothing is drawn while the link is fine, which is what
  // keeps the resting bar two lines tall.
  const state = fellBack
    ? "not reachable"
    : link.state === "reconnecting"
      ? "reconnecting…"
      : link.state === "lost"
        ? "disconnected"
        : "";
  // Who else is on this machine (remote.md §7). Nothing at all when nobody is,
  // which is nearly always: a count that says "1 device" while you are alone is
  // noise in the one strip that must stay readable at a glance. One other is
  // worth naming, since it is the device that can take a shell from under you;
  // past that the names stop fitting and the number is the useful part, with the
  // whole list a hover away.
  const others = presence();
  const company = others.length === 0 ? "" : others.length === 1 ? others[0]!.label || "another device" : `${others.length} devices`;
  const names = others.map((o) => o.label || "an unnamed device").join(", ");
  // The trailing glyph names the verb, so the two things the bar can do are
  // told apart before the click rather than by it: a switcher's chevrons, or
  // the dial-now arrow while the link is down.
  const Verb = dropped ? RotateCw : ChevronsUpDown;

  return (
    // A split button while the link is down, on the pattern the workspace strip
    // already uses for New Workspace (Sidebar.tsx): the wide half is the verb
    // for the moment, the narrow half is the other one.
    //
    // It exists because the switcher was not merely deprioritized while
    // disconnected, it was GONE — one button, one verb, and the only other way
    // to reach the chooser was a palette entry nobody looks for while staring
    // at a bar that says "disconnected". A server that has not come back is
    // exactly when moving to another machine is worth offering, and a window
    // that could not reconnect could not leave either.
    <div className="flex w-full shrink-0 items-stretch border-b">
      <button
        type="button"
        data-connection={conn.id}
        data-link={link.state}
        // The command's own tooltip, prefixed with where the notes actually are:
        // the name in the bar is the user's word for the machine, and the
        // destination is the fact.
        title={`${trouble || (local ? "Notes on this Mac" : `Notes on ${conn.destination}`)} — ${tooltip(verb)}`}
        onClick={() => exec(verb)}
        // Sized as the control it is rather than as a status line. It scopes
        // every note, tab, tag and shell below it (§4-1), so it outranks the
        // section labels it sits above: a labelled two-line row, flush against
        // the workspace strip, and past 44 points on its own without the touch
        // minimum having to raise it (§1a). The label is what makes the machine's
        // name mean something — "v1" alone says nothing about what it names.
        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left hover:bg-accent/50 touch:min-h-[44px]"
      >
        <Icon className={`size-4 shrink-0 ${trouble ? "text-destructive" : "text-muted-foreground"}`} />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            {/* The label never truncates and the chip does: this phrase is two
                fixed words and the chip is a device name of any length, so at the
                narrowest sidebar (App's SIDEBAR_MIN) the one with a tooltip
                behind it is the one that gives way. */}
            <span className="shrink-0">Notes on</span>
            {company && (
              // Its own title rather than a clause in the button's: the full list is
              // what a hover over this chip should say, and the button's tooltip is
              // about switching machines.
              <span className="flex min-w-0 flex-1 items-center justify-end gap-1" title={`Also on this server: ${names}`} data-presence={others.length}>
                <Users className="size-3 shrink-0" />
                <span className="truncate">{company}</span>
              </span>
            )}
          </span>
          <span className="block truncate text-[13px] font-medium text-foreground">{conn.name}</span>
          {state && (
            <span className={`block truncate text-[11px] ${link.state === "reconnecting" && !fellBack ? "text-muted-foreground" : "text-destructive"}`}>
              {state}
            </span>
          )}
        </span>
        <Verb className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {dropped && (
        <button
          type="button"
          data-switch=""
          title={tooltip("connection.switch")}
          onClick={() => exec("connection.switch")}
          // The narrow half of a split button, so its width is a target too:
          // the two halves touch, and a miss here dials instead of choosing.
          className="flex items-center border-l px-2.5 text-muted-foreground hover:bg-accent/50 touch:min-w-[44px] touch:justify-center"
        >
          <ChevronsUpDown className="size-3.5 shrink-0" />
        </button>
      )}
    </div>
  );
}
