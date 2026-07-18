// What a keystroke on a focused list row acts on.
//
// A right-click passes its CommandTarget explicitly, but a bare `d` only knows
// where focus is. Rather than have every list publish its selection into a
// module the dispatcher reads (a second source of truth, and one that goes
// stale), rows carry their identity as data attributes and the dispatcher
// reads it back off the focused element: the DOM already owns focus, so it may
// as well own what focus means.
//
// The decoding is pure (targetFromDataset, unit-tested); targetFromElement is
// the two-line DOM wrapper over it.
import type { CommandTarget } from "./types";

// The dataset shape a row publishes. Camel-cased like DOMStringMap, because
// that is what it is read back out of.
export interface TargetDataset {
  targetKind?: string;
  targetPath?: string;
  targetId?: string;
  targetPane?: string;
  targetTab?: string;
  targetLine?: string;
  targetRaw?: string;
}

// The attribute a row marks itself with. The values mirror CommandTarget's
// kinds, and targetFromElement is the only reader.
export function targetAttrs(target: CommandTarget): Record<string, string> {
  switch (target.kind) {
    case "note":
    case "trash":
      return { "data-target-kind": target.kind, "data-target-path": target.path };
    case "backlink":
      return {
        "data-target-kind": "backlink",
        "data-target-path": target.path,
        "data-target-line": String(target.line),
        "data-target-raw": target.raw,
      };
    case "workspace":
      return { "data-target-kind": "workspace", "data-target-id": target.id };
    case "tab":
      return {
        "data-target-kind": "tab",
        "data-target-pane": target.paneId,
        "data-target-tab": target.tabId,
      };
    case "pane":
      return { "data-target-kind": "pane", "data-target-pane": target.paneId };
  }
}

// A row's dataset back into a target. An attribute set without its partner
// yields undefined rather than a half-built target pointed at nothing.
export function targetFromDataset(d: TargetDataset): CommandTarget | undefined {
  switch (d.targetKind) {
    case "note":
      return d.targetPath ? { kind: "note", path: d.targetPath } : undefined;
    case "trash":
      return d.targetPath ? { kind: "trash", path: d.targetPath } : undefined;
    case "backlink": {
      // The line rides the DOM as a string; a row that lost (or garbled) it
      // yields no target at all, per the half-built-target rule above. raw may
      // legitimately be absent-as-empty — the reveal degrades to line start.
      const line = Number(d.targetLine);
      return d.targetPath && Number.isInteger(line) && line >= 1
        ? { kind: "backlink", path: d.targetPath, line, raw: d.targetRaw ?? "" }
        : undefined;
    }
    case "workspace":
      return d.targetId ? { kind: "workspace", id: d.targetId } : undefined;
    case "tab":
      return d.targetPane && d.targetTab
        ? { kind: "tab", paneId: d.targetPane, tabId: d.targetTab }
        : undefined;
    case "pane":
      return d.targetPane ? { kind: "pane", paneId: d.targetPane } : undefined;
    default:
      return undefined;
  }
}

// The target of the nearest enclosing row, or undefined when focus isn't on
// one — which is every non-list surface, and is what makes the row verbs inert
// everywhere else.
export function targetFromElement(el: EventTarget | null): CommandTarget | undefined {
  if (!(el instanceof Element)) return undefined;
  const row = el.closest<HTMLElement>("[data-target-kind]");
  return row ? targetFromDataset(row.dataset) : undefined;
}
