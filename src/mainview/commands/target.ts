// What a keystroke on a focused list row acts on. A right-click passes its
// CommandTarget explicitly. A bare `d` knows only where focus is. Rows carry
// their identity in data attributes, and the dispatcher reads them off the
// focused element (CommandProvider.tsx, interactions.md §7). A module holding
// each list's selection would be a second source of truth that goes stale.
//
// targetFromDataset does the decoding and is pure (target.test.ts).
// targetFromElement is the three-line DOM wrapper over it, small enough to
// leave untested (testing.md §2).
import type { CommandTarget } from "./types";

// The dataset shape a row publishes. The keys are camel-cased because they
// are read back out of an element's DOMStringMap (its `dataset`).
export interface TargetDataset {
  targetKind?: string;
  targetPath?: string;
  targetId?: string;
  targetPane?: string;
  targetTab?: string;
  targetLine?: string;
  targetRaw?: string;
  targetTag?: string;
  targetFolder?: string;
}

// The attributes a row marks itself with. data-target-kind's values mirror
// CommandTarget's kinds; the rest carry that kind's payload.
// targetFromElement below is the only code that reads these attribute names
// back off the DOM. Sidebar.tsx and the e2e specs also select on them.
export function targetAttrs(target: CommandTarget): Record<string, string> {
  switch (target.kind) {
    case "note":
    case "trash":
      return { "data-target-kind": target.kind, "data-target-path": target.path };
    case "folder":
      // The folder gets its own attribute rather than targetPath: it is a
      // root-relative folder of the selected workspace, not a path. A decoder
      // that read it as a path would hand a command half a filename.
      return { "data-target-kind": "folder", "data-target-folder": target.folder };
    case "backlink":
      return {
        "data-target-kind": "backlink",
        "data-target-path": target.path,
        "data-target-line": String(target.line),
        "data-target-raw": target.raw,
      };
    case "heading":
      // targetRaw carries the heading text. It plays the same role as a
      // backlink's raw [[...]]: the query the jump re-finds on the line.
      return {
        "data-target-kind": "heading",
        "data-target-id": target.docId,
        "data-target-line": String(target.line),
        "data-target-raw": target.text,
      };
    case "tag":
      return { "data-target-kind": "tag", "data-target-tag": target.tag };
    case "tagnote":
      // Backlink's attribute shape. targetRaw is the reveal query: the tag as
      // written on the line.
      return {
        "data-target-kind": "tagnote",
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

// Decodes a row's dataset back into a target. An attribute set without its
// partner yields undefined rather than a half-built target.
export function targetFromDataset(d: TargetDataset): CommandTarget | undefined {
  switch (d.targetKind) {
    case "note":
      return d.targetPath ? { kind: "note", path: d.targetPath } : undefined;
    case "trash":
      return d.targetPath ? { kind: "trash", path: d.targetPath } : undefined;
    case "folder":
      // An empty folder string means the workspace's top level. browserRows
      // (notes/folders.ts) draws no row for it, so an empty attribute is a
      // half-built target rather than a target on the top level.
      return d.targetFolder ? { kind: "folder", folder: d.targetFolder } : undefined;
    case "backlink": {
      // data-target-line comes back as text, so the line is parsed here.
      // A row that lost or garbled it yields no target, per the
      // half-built-target rule above. An absent raw is fine: the reveal then
      // lands on the start of the line (workspace/reveal.ts revealSelection).
      const line = Number(d.targetLine);
      return d.targetPath && Number.isInteger(line) && line >= 1
        ? { kind: "backlink", path: d.targetPath, line, raw: d.targetRaw ?? "" }
        : undefined;
    }
    case "heading": {
      // Same rules as backlink. A garbled line yields no target. With no
      // text, the jump still happens and lands on the start of the line
      // (glue.ts jumpToHeading, through revealSelection).
      const line = Number(d.targetLine);
      return d.targetId && Number.isInteger(line) && line >= 1
        ? { kind: "heading", docId: d.targetId, line, text: d.targetRaw ?? "" }
        : undefined;
    }
    case "tag":
      return d.targetTag ? { kind: "tag", tag: d.targetTag } : undefined;
    case "tagnote": {
      // Backlink's decoding rules. A garbled line yields no target. With no
      // raw, the note still opens and the reveal lands on the start of the
      // line.
      const line = Number(d.targetLine);
      return d.targetPath && Number.isInteger(line) && line >= 1
        ? { kind: "tagnote", path: d.targetPath, line, raw: d.targetRaw ?? "" }
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

// The target of the nearest enclosing row, or undefined when the element is
// not in one. An element outside every list decodes to no target, so the row
// verbs do nothing there.
export function targetFromElement(el: EventTarget | null): CommandTarget | undefined {
  if (!(el instanceof Element)) return undefined;
  const row = el.closest<HTMLElement>("[data-target-kind]");
  return row ? targetFromDataset(row.dataset) : undefined;
}
