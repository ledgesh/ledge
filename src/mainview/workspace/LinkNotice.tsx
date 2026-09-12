// The strip that says the wire is down when the bar that would say so is not
// on screen (interactions.md §4-1).
//
// ConnectionBar is the app's answer to a dropped connection and it lives in
// the sidebar, which is a pane on a Mac and a shut drawer on a phone
// (App.tsx). So on a phone the one piece of chrome that reports the link sat
// behind a tap nobody thinks to make, and on a Mac it went away with a
// collapsed sidebar.
//
// That did not matter while foregrounding reloaded: the boot screen covered
// the whole reconnect, and a person watched a spinner rather than any chrome.
// Resuming now probes underneath a UI that stays on screen (mainview/ios.tsx),
// so a wire that comes back slowly is a note that looks ordinary and cannot
// save, and this is what says so.
//
// Above the content and never over it: a reconnect is not a modal state and
// the editor stays usable, because the buffer is what keeps the writing until
// a server can take it (notes/store.ts holdSaves).
import { useEffect, useState } from "react";
import { PlugZap, RotateCw, TriangleAlert } from "lucide-react";
import { useCommands } from "@/commands/CommandProvider";
import { linkState, subscribeConnections } from "@/lib/connections";
import { cn } from "@/lib/utils";

export function LinkNotice() {
  const { exec } = useCommands();
  const [, bump] = useState(0);
  useEffect(() => subscribeConnections(() => bump((n) => n + 1)), []);

  const link = linkState();
  if (link.state === "live") return null;

  // The ladder is climbing, which needs no button: it dials again within
  // seconds, and a press could only bring forward something already on its way
  // (shared/transport.ts recheck). Past the ladder the beat is half a minute
  // wide, and the press is for the person who can see their wifi came back
  // before the next one is due.
  const climbing = link.state === "reconnecting";

  // The whole strip is the target while there is one, rather than a button
  // inside a line of text. A finger is 44 points and this row is 24, so a
  // button in it would either be a mis-tap or would set the row's height
  // (interactions.md §1a). One row, one verb, and nothing nested.
  const Tag = climbing ? "div" : "button";
  const Icon = climbing ? PlugZap : TriangleAlert;

  return (
    <Tag
      {...(climbing
        ? // Reported rather than announced: the wire coming and going is not
          // worth interrupting what a screen reader is reading, the same call
          // lib/booting.ts makes.
          { role: "status", "aria-live": "polite" as const }
        : { type: "button" as const, onClick: () => exec("connection.reconnect") })}
      data-link={link.state}
      className={cn(
        "flex w-full shrink-0 items-center gap-2 border-b bg-muted/60 px-3 py-1 text-left text-xs text-muted-foreground",
        !climbing && "touch:min-h-[44px] hover:bg-accent",
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      {/* The transport's own sentence, which names what failed and is the
          string the bar draws too (lib/connections.ts). Truncated rather than
          wrapped, so this strip does not change height on a 390-point screen
          and move the note under it. */}
      <span className="min-w-0 flex-1 truncate">{climbing ? "Reconnecting…" : link.detail || "Disconnected."}</span>
      {!climbing && (
        <span className="flex shrink-0 items-center gap-1 font-medium">
          <RotateCw className="size-3.5" />
          Reconnect
        </span>
      )}
    </Tag>
  );
}
