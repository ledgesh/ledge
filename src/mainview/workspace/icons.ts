// The workspace icon catalog. This file defines every icon key, so the strip,
// the picker, and persisted workspaces agree on what a key means.
// `Workspace.symbol` holds one of these keys.
//
// A workspace's icon is chosen, never assigned. Every new workspace starts on
// DEFAULT_ICON. Deriving an icon instead (by creation index, as an earlier
// version did) implies the app knows something about the workspace when it
// only knows what order the workspaces were made in. An index also changes
// when the strip is reordered, so the icon changes with it.
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

// Ordered as the picker renders them (IconPicker.tsx maps this list into its
// grid): the plain shapes first, then the ones people pick for what they mean.
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

// The icon component for a key. An unknown key resolves to the default
// rather than rendering nothing, because a workspace row with no icon reads
// as a broken row. Callers screen keys first: persist.ts coerces a persisted
// symbol the catalog no longer has to DEFAULT_ICON, and store.tsx's
// `setWorkspaceIcon` refuses one. This is the backstop if a key gets past
// them.
export function iconFor(key: string): LucideIcon {
  return (BY_KEY.get(key) ?? BY_KEY.get(DEFAULT_ICON)!).Icon;
}

export function isIconKey(key: string): boolean {
  return BY_KEY.has(key);
}
