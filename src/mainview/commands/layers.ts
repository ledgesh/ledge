// The modal layer stack (interactions.md §6). Every transient surface (context
// menu, confirm dialog, palette overlay) registers here on mount and disposes
// on unmount. One capture-phase Escape listener addresses the topmost layer
// only. Each component used to add its own capture listener. Those fired in
// mount order, so which one answered Escape was an accident. While any layer
// is open, the modalOpen flag suppresses the window command dispatcher
// (resolveChord in keymap.ts).

export type LayerKind = "menu" | "dialog" | "overlay";

export interface Layer {
  kind: LayerKind;
  onEscape: () => void;
}

// The ordering logic is pure, so layers.test.ts can drive it without a DOM.
// The stack is LIFO. Dispose may run out of order: a layer is removed from the
// middle when its component unmounts for a reason other than Escape. A menu
// closing on an outside click while a dialog sits above it does that.
export function createLayerStack<T>() {
  // Entries wrap the items so two pushes of an equal value stay distinct
  // layers. Dispose removes its own entry by identity.
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
// Told when the stack goes from empty to not, and back. One listener: the
// Android shell's Back button is the only thing that asks (`watchLayers`).
let opened: (open: boolean) => void = () => {};

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  const top = layers.top();
  if (!top) return;
  // Consume in the capture phase, so the editor's and terminal's own Escape
  // bindings never see the key.
  e.preventDefault();
  e.stopPropagation();
  top.onEscape();
}

// pushLayer registers a modal layer and returns its dispose. The window
// listener attaches on the first push and detaches when the stack drains, so
// an app with nothing modal open has no capture-phase listener at all.
export function pushLayer(kind: LayerKind, onEscape: () => void): () => void {
  const dispose = layers.push({ kind, onEscape });
  if (!listening) {
    window.addEventListener("keydown", onKey, true);
    listening = true;
    opened(true);
  }
  return () => {
    dispose();
    if (layers.size() === 0 && listening) {
      window.removeEventListener("keydown", onKey, true);
      listening = false;
      opened(false);
    }
  };
}

/**
 * Report whether any layer is open, now and on every change. Android's Back
 * button closes the top layer while one is, and backgrounds the app while none
 * is, and the shell has to know which before the press arrives (interactions.md
 * §6).
 */
export function watchLayers(fn: (open: boolean) => void): void {
  opened = fn;
  fn(layers.size() > 0);
}

/** What Escape does, for a press that is not a key: close the top layer.
 * False when nothing is open. */
export function escapeTop(): boolean {
  const top = layers.top();
  if (!top) return false;
  top.onEscape();
  return true;
}

export function modalOpen(): boolean {
  return layers.size() > 0;
}
