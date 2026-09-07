// A context-menu item rendered from the command registry. Title, icon, key
// chip, destructive styling, and enablement all come from the command
// definition, so the menu cannot advertise a key nothing binds
// (interactions.md §5). The chip shows one key, not every binding: `chipOf`
// in format.ts picks the first, while the dispatcher matches all of them.
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
  // Tooltip text for context the command's title does not carry, set as the
  // `title` attribute on the menu row's button. Delete passes "Recoverable
  // from Trash for 30 days"; the callers are in notes/NoteBrowser.tsx and
  // workspace/Sidebar.tsx.
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
