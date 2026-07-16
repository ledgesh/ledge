// The workspace icon catalog: the only place icon keys are defined, so the
// strip, the picker, and any future persisted workspace agree on what a key
// means. `Workspace.symbol` holds one of these keys.
//
// A workspace's icon is chosen, never assigned: new workspaces all start on
// DEFAULT_ICON. Handing them icons by index (as this used to) looks like the
// app knows something about the workspace when it only knows what order you
// made them in, and the icon then shuffles the moment you reorder the strip.
import {
  Beaker,
  Bookmark,
  Boxes,
  Briefcase,
  Bug,
  Cloud,
  Code,
  Compass,
  Database,
  Feather,
  Flag,
  Folder,
  Globe,
  Hammer,
  Inbox,
  Layers,
  Lightbulb,
  Rocket,
  Server,
  Sparkles,
  Star,
  Target,
  Terminal,
  Zap,
  type LucideIcon,
} from "lucide-react";

export interface WorkspaceIcon {
  key: string;
  label: string; // the picker's tooltip and accessible name
  Icon: LucideIcon;
}

// Ordered as the picker renders them: the plain shapes first, then the ones
// people reach for by meaning.
export const WORKSPACE_ICONS: readonly WorkspaceIcon[] = [
  { key: "layers", label: "Layers", Icon: Layers },
  { key: "inbox", label: "Inbox", Icon: Inbox },
  { key: "boxes", label: "Boxes", Icon: Boxes },
  { key: "folder", label: "Folder", Icon: Folder },
  { key: "bookmark", label: "Bookmark", Icon: Bookmark },
  { key: "star", label: "Star", Icon: Star },
  { key: "flag", label: "Flag", Icon: Flag },
  { key: "target", label: "Target", Icon: Target },
  { key: "terminal", label: "Terminal", Icon: Terminal },
  { key: "code", label: "Code", Icon: Code },
  { key: "bug", label: "Bug", Icon: Bug },
  { key: "hammer", label: "Build", Icon: Hammer },
  { key: "beaker", label: "Experiment", Icon: Beaker },
  { key: "rocket", label: "Launch", Icon: Rocket },
  { key: "sparkles", label: "Ideas", Icon: Sparkles },
  { key: "lightbulb", label: "Notes", Icon: Lightbulb },
  { key: "feather", label: "Writing", Icon: Feather },
  { key: "briefcase", label: "Work", Icon: Briefcase },
  { key: "compass", label: "Explore", Icon: Compass },
  { key: "globe", label: "Web", Icon: Globe },
  { key: "cloud", label: "Cloud", Icon: Cloud },
  { key: "server", label: "Server", Icon: Server },
  { key: "database", label: "Database", Icon: Database },
  { key: "zap", label: "Zap", Icon: Zap },
];

// What every new workspace gets, and what an unknown key falls back to.
export const DEFAULT_ICON = "layers";

const BY_KEY = new Map(WORKSPACE_ICONS.map((i) => [i.key, i]));

// The component for a key. Unknown keys resolve to the default rather than
// rendering nothing: a workspace row with no icon reads as a broken row, and a
// key can go stale (a persisted workspace outliving a catalog edit).
export function iconFor(key: string): LucideIcon {
  return (BY_KEY.get(key) ?? BY_KEY.get(DEFAULT_ICON)!).Icon;
}

export function isIconKey(key: string): boolean {
  return BY_KEY.has(key);
}
