// A context-menu item rendered from the command registry: title, icon, key
// chip, destructive styling, and enablement all come from the command
// definition, so a menu can never advertise a key the dispatcher doesn't bind.
import { MenuItem } from "@/components/ContextMenu";
import { chipOf } from "./format";
import { useCommands } from "./CommandProvider";
import type { CommandTarget } from "./types";

export function CommandMenuItem({
  id,
  target,
  onClose,
  hint,
}: {
  id: string;
  target?: CommandTarget;
  onClose: () => void;
  // An extra title= line for context the command name doesn't carry (e.g.
  // Delete's "Recoverable from Trash for 30 days").
  hint?: string;
}) {
  const { exec, commands, ctx } = useCommands();
  const cmd = commands.find((c) => c.id === id);
  if (!cmd) return null;

  const c = { ...ctx(), target };
  const enabled = !cmd.when || cmd.when(c);
  const title = typeof cmd.title === "function" ? cmd.title(c) : cmd.title;
  const Icon = cmd.icon;

  return (
    <MenuItem
      destructive={cmd.destructive}
      disabled={!enabled}
      title={hint}
      shortcut={chipOf(cmd.keys, cmd.listKeys) ?? undefined}
      onSelect={() => {
        onClose();
        exec(id, target);
      }}
    >
      {Icon && <Icon className="size-3.5" />} {title}
    </MenuItem>
  );
}
