// The modal layer stack (interactions.md §6). Every transient surface —
// context menu, confirm dialog, palette overlay — registers itself here on
// mount and disposes on unmount. One capture-phase Escape listener addresses
// only the topmost layer, replacing the per-component capture listeners whose
// ordering was an accident of mount order. While any layer is open, the window
// command dispatcher is suppressed (resolveChord's modalOpen flag).

export type LayerKind = "menu" | "dialog" | "overlay";

export interface Layer {
  kind: LayerKind;
  onEscape: () => void;
}

// The ordering logic, pure and unit-testable: LIFO with out-of-order dispose
// (a layer can be removed from the middle when its component unmounts for a
// reason other than Escape, e.g. a menu closing on outside click while a
// dialog sits above it).
export function createLayerStack<T>() {
  // Entries wrap the items so two pushes of an equal value are still distinct
  // layers; dispose removes its own entry by identity.
  const stack: Array<{ item: T }> = [];
  return {
    push(item: T): () => void {
      const entry = { item };
      stack.push(entry);
      return () => {
        const i = stack.indexOf(entry);
        if (i >= 0) stack.splice(i, 1);
      };
    },
    top(): T | null {
      return stack.length ? stack[stack.length - 1]!.item : null;
    },
    size(): number {
      return stack.length;
    },
  };
}

const layers = createLayerStack<Layer>();
let listening = false;

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  const top = layers.top();
  if (!top) return;
  // Consume before the editor's or terminal's own Escape bindings can see it:
  // a modal owns the keyboard.
  e.preventDefault();
  e.stopPropagation();
  top.onEscape();
}

// Register a modal layer; returns its dispose. The window listener attaches on
// first push and detaches when the stack drains, so an app with nothing modal
// open has no capture-phase listener at all.
export function pushLayer(kind: LayerKind, onEscape: () => void): () => void {
  const dispose = layers.push({ kind, onEscape });
  if (!listening) {
    window.addEventListener("keydown", onKey, true);
    listening = true;
  }
  return () => {
    dispose();
    if (layers.size() === 0 && listening) {
      window.removeEventListener("keydown", onKey, true);
      listening = false;
    }
  };
}

export function modalOpen(): boolean {
  return layers.size() > 0;
}
