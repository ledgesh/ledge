import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { toNative, type RunDestination } from "./bridge";

// One inline run of a code block. Output accumulates as bytes arrive from native.
export interface RunInfo {
  id: string;
  from: number; // block start (maps through edits), used to match on re-run
  pos: number; // anchor for the output panel (block end line), maps through edits
  lang: string | null;
  state: "running" | "done" | "error";
  exitCode: number | null;
  text: string; // decoded output (plain text in phase 2a; xterm.js in 2b)
  startedAt: number;
  durationMs: number | null;
}

// One code block found in the document.
interface Block {
  from: number;
  to: number;
  lang: string | null;
  code: string;
}

// --- Run state -------------------------------------------------------------

const addRun = StateEffect.define<RunInfo>();
const setRunState = StateEffect.define<{ id: string; state: RunInfo["state"]; exitCode: number | null }>();
const appendOutput = StateEffect.define<{ id: string; text: string }>();
const removeRun = StateEffect.define<string>();
// A full document replace from native (loading a note) drops all inline output.
export const clearRunsEffect = StateEffect.define<null>();
// A no-op effect whose only purpose is to nudge the overlay plugin to re-measure
// (it treats any effect as a trigger). Dispatched when a pooled editor is
// re-parented between panes/tabs, so its overlay re-pins or collapses at once.
const pingOverlayEffect = StateEffect.define<null>();

// Force the block-chrome overlay to re-measure now. Used by the editor pool when
// an editor's DOM host is attached to (or detached from) a visible pane.
export function pingOverlay(view: EditorView): void {
  view.dispatch({ effects: pingOverlayEffect.of(null) });
}

const runsField = StateField.define<RunInfo[]>({
  create: () => [],
  update(runs, tr) {
    let next = runs;
    if (tr.docChanged) {
      next = next.map((r) => ({
        ...r,
        from: tr.changes.mapPos(r.from, -1),
        pos: tr.changes.mapPos(r.pos, 1),
      }));
    }
    for (const e of tr.effects) {
      if (e.is(clearRunsEffect)) {
        next = [];
      } else if (e.is(addRun)) {
        // A fresh run of a block replaces any earlier run anchored inside it.
        const v = e.value;
        next = next.filter((r) => !(r.pos >= v.from && r.pos <= v.pos));
        next = [...next, v];
      } else if (e.is(setRunState)) {
        next = next.map((r) =>
          r.id === e.value.id
            ? { ...r, state: e.value.state, exitCode: e.value.exitCode, durationMs: r.startedAt ? Date.now() - r.startedAt : null }
            : r,
        );
      } else if (e.is(appendOutput)) {
        next = next.map((r) => (r.id === e.value.id ? { ...r, text: r.text + e.value.text } : r));
      } else if (e.is(removeRun)) {
        next = next.filter((r) => r.id !== e.value);
      }
    }
    return next;
  },
});

// --- Block discovery -------------------------------------------------------

function blockAt(state: EditorView["state"], pos: number): Block | null {
  // Held on an object property, not a bare local: the assignment happens inside
  // the iterate() callback, and TS control-flow analysis would otherwise narrow a
  // local to `null` after the call (it can't see the closure run) and reject the
  // reads below.
  const box: { range: { from: number; to: number } | null } = { range: null };
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "FencedCode" && pos >= node.from && pos <= node.to) {
        box.range = { from: node.from, to: node.to };
      }
    },
  });
  return box.range ? readBlock(state, box.range.from, box.range.to) : null;
}

// The language on the opening fence line, e.g. "sh" from "```sh". Read from the
// line text rather than Lezer child nodes, whose names/shape are less stable.
function langFromFence(state: EditorView["state"], from: number): string | null {
  const line = state.doc.lineAt(from).text;
  const match = line.match(/^\s*(?:`{3,}|~{3,})\s*([^\s`~]*)/);
  return match && match[1] ? match[1].trim() : null;
}

function readBlock(state: EditorView["state"], from: number, to: number): Block {
  const doc = state.doc;
  const openLine = doc.lineAt(from);
  const endLine = doc.lineAt(Math.min(to, doc.length));
  const lang = langFromFence(state, from);

  // Body is the lines strictly between the opening fence and the closing fence.
  const firstBody = openLine.number + 1;
  const lastBody = endLine.number - 1;
  let code = "";
  if (lastBody >= firstBody) {
    code = doc.sliceString(doc.line(firstBody).from, doc.line(lastBody).to);
  }
  return { from, to, lang, code };
}

function eachBlock(state: EditorView["state"], cb: (from: number, to: number, lang: string | null) => void): void {
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "FencedCode") return;
      cb(node.from, node.to, langFromFence(state, node.from));
    },
  });
}

// --- Running ---------------------------------------------------------------

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `web-${idCounter}-${Date.now()}`;
}

function runBlock(view: EditorView, pos: number, destination: RunDestination): boolean {
  const block = blockAt(view.state, pos);
  if (!block || !isRunnable(block.lang)) return false;

  if (destination === "terminal") {
    // Output goes to the drawer; no inline panel is created here.
    toNative({ type: "run", code: block.code, language: block.lang, destination: "terminal" });
    return true;
  }

  const id = nextId();
  view.dispatch({
    effects: addRun.of({
      id,
      from: block.from,
      pos: view.state.doc.lineAt(block.to).to,
      lang: block.lang,
      state: "running",
      exitCode: null,
      text: "",
      startedAt: Date.now(),
      durationMs: null,
    }),
  });
  toNative({ type: "run", id, code: block.code, language: block.lang, destination: "inline" });
  return true;
}

// --- Output widget ---------------------------------------------------------
//
// The output panel is a block widget: it has to reserve vertical space and push
// the following text down, which only an in-content block widget can do. It holds
// no interactive controls, though. Its dismiss button lives in the overlay layer
// (see `overlayPlugin`) so it sits outside the editable surface, where the browser
// honours `cursor: pointer` instead of forcing the editing I-beam. The panel body
// keeps the text I-beam on purpose: the output is selectable.

class OutputWidget extends WidgetType {
  constructor(readonly run: RunInfo) {
    super();
  }
  eq(other: OutputWidget) {
    return (
      other.run.id === this.run.id &&
      other.run.state === this.run.state &&
      other.run.durationMs === this.run.durationMs &&
      other.run.text.length === this.run.text.length
    );
  }
  toDOM(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "ledge-output";
    panel.contentEditable = "false";
    // Lets the overlay find this panel to anchor the dismiss button.
    panel.dataset.ledgeRun = this.run.id;

    const header = document.createElement("div");
    header.className = "ledge-output-header";

    const dot = document.createElement("span");
    dot.className = `ledge-dot ledge-dot-${this.run.state}`;
    header.appendChild(dot);

    const status = document.createElement("span");
    status.className = "ledge-status";
    status.textContent = statusText(this.run);
    header.appendChild(status);

    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    header.appendChild(spacer);

    if (this.run.durationMs != null) {
      const dur = document.createElement("span");
      dur.className = "ledge-duration";
      dur.textContent = formatDuration(this.run.durationMs);
      header.appendChild(dur);
    }
    // Reserve room on the right so the overlaid dismiss button never sits on top
    // of the duration text.
    const gap = document.createElement("span");
    gap.style.width = "22px";
    header.appendChild(gap);
    panel.appendChild(header);

    const pre = document.createElement("pre");
    pre.className = "ledge-output-body";
    pre.textContent = stripAnsi(this.run.text);
    panel.appendChild(pre);
    return panel;
  }
  ignoreEvent() {
    return false;
  }
}

// --- Icons and buttons -----------------------------------------------------

const svg = (body: string) =>
  `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const PLAY_ICON = svg('<path d="M5 3.4 12.5 8 5 12.6 Z" fill="currentColor" stroke="none"/>');
const TERMINAL_ICON = svg('<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6.3l2 1.7-2 1.7"/><path d="M8.5 10h3"/>');
const COPY_ICON = svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>');
const CHECK_ICON = svg('<path d="M3.5 8.4l3 3 6-6.8"/>');
const CLOSE_ICON = svg('<path d="M4 4l8 8M12 4l-8 8"/>');

function iconButton(markup: string, title: string, onDown: (e: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "ledge-btn";
  b.title = title;
  b.innerHTML = markup;
  // mousedown, not click: run before the editor moves the selection or steals focus.
  b.addEventListener("mousedown", onDown);
  return b;
}

// navigator.clipboard needs a secure context, which the views:// scheme is not,
// so it is undefined (or rejects) here. Fall back to the temporary-textarea +
// execCommand path, which works in this WebView without a secure context.
function copyText(text: string): void {
  const clip = navigator.clipboard;
  if (clip && typeof clip.writeText === "function") {
    clip.writeText(text).catch(() => execCopy(text));
  } else {
    execCopy(text);
  }
}

function execCopy(text: string): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    // Nothing more we can do; leave the clipboard untouched.
  }
  ta.remove();
}

// Swap the copy glyph for a checkmark for a beat, as click feedback.
function flashCopied(btn: HTMLButtonElement): void {
  btn.innerHTML = CHECK_ICON;
  btn.title = "Copied";
  btn.classList.add("copied");
  window.setTimeout(() => {
    btn.innerHTML = COPY_ICON;
    btn.title = "Copy";
    btn.classList.remove("copied");
  }, 1100);
}

// --- Overlay layer ---------------------------------------------------------
//
// All clickable chrome (run/terminal/copy per block, dismiss per output) is drawn
// here, in a layer parented to <body> (not the editor) and pinned as a fixed box
// over the editor's rect, re-measured on edit, geometry change, and scroll so each
// control stays glued to its block. Living outside the `.cm-editor` subtree is what
// lets the buttons honour `cursor: pointer`: WebKit forces the text I-beam on any
// element inside that editing context regardless of the CSS `cursor`.
//
// Known gap: the dismiss button sits over the output panel, a block widget that IS
// inside `.cm-editor`, and WebKit's cursor hit-test reaches the panel through the
// overlay, so that one button still shows the I-beam. The run/copy controls, which
// sit over plain lines, render the pointer correctly. Unsolved; revisit.

interface ControlSpec {
  from: number;
  lang: string | null;
  top: number;
  right: number;
  caret: boolean;
}
interface CloseSpec {
  id: string;
  top: number;
  right: number;
}
interface Measured {
  rect: { top: number; left: number; width: number; height: number };
  controls: ControlSpec[];
  closes: CloseSpec[];
  sig: string;
}

const overlayPlugin = ViewPlugin.fromClass(
  class {
    layer: HTMLDivElement;
    sig = "";
    hovered: number | null = null;
    onMove: (e: MouseEvent) => void;
    onScroll: () => void;

    constructor(readonly view: EditorView) {
      this.layer = document.createElement("div");
      this.layer.className = "ledge-overlay";
      // Parent to <body>, NOT to the editor: WebKit forces the text I-beam over
      // any element inside the `.cm-editor` editing context, regardless of
      // `cursor`, `contenteditable=false`, or pointer-events. Only elements
      // outside that subtree honour `cursor: pointer`. The layer is a fixed box
      // pinned over the editor's rect (updated each measure) so buttons still
      // track their blocks while living outside the editing context.
      document.body.appendChild(this.layer);

      this.onMove = (e) => this.updateHover(e.clientX, e.clientY);
      this.onScroll = () => this.schedule();
      view.scrollDOM.addEventListener("mousemove", this.onMove);
      view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
      this.schedule();
    }

    update(u: ViewUpdate) {
      const runChanged = u.transactions.some((t) => t.effects.length);
      if (u.docChanged || u.viewportChanged || u.geometryChanged || u.selectionSet || runChanged) {
        this.schedule();
      }
      // A run's output panel is a block widget whose DOM can land a frame after
      // this update, so a measure now would miss it and skip the dismiss button.
      // A macrotask-deferred pass catches the settled layout (fires reliably even
      // where requestAnimationFrame is throttled).
      if (runChanged) {
        setTimeout(() => this.schedule(), 0);
      }
    }

    schedule() {
      this.view.requestMeasure<Measured>({
        key: overlayPlugin,
        read: () => this.read(),
        write: (m) => this.write(m),
      });
    }

    // Reveal a block's controls while the pointer is over that block. The pointer
    // may be over the floating controls themselves; `posAtCoords` still resolves
    // to the block line underneath, so the group stays lit.
    updateHover(x: number, y: number) {
      const pos = this.view.posAtCoords({ x, y });
      const b = pos != null ? blockAt(this.view.state, pos) : null;
      const from = b ? b.from : null;
      if (from === this.hovered) return;
      this.hovered = from;
      for (const g of Array.from(this.layer.querySelectorAll<HTMLElement>(".ledge-ctl-group"))) {
        g.classList.toggle("hover", from != null && g.dataset.block === String(from));
      }
    }

    read(): Measured {
      const view = this.view;
      // A pooled editor for an inactive tab is detached from the DOM (kept alive
      // off-screen; see editorPool.ts). Measuring it would leave the last set of
      // floating buttons stranded on screen, so collapse the overlay entirely
      // until its host is re-parented into a visible pane.
      if (!view.dom.isConnected) {
        return { rect: { top: 0, left: 0, width: 0, height: 0 }, controls: [], closes: [], sig: "detached" };
      }
      // The layer is a fixed box pinned over the editor's rect, so measure every
      // button against the editor's viewport rect and position it relative to that.
      const base = view.dom.getBoundingClientRect();
      const head = view.state.selection.main.head;

      const controls: ControlSpec[] = [];
      eachBlock(view.state, (from, to, lang) => {
        const openLine = view.state.doc.lineAt(from);
        let c: { top: number } | null = null;
        try {
          c = view.coordsAtPos(openLine.from);
        } catch {
          c = null;
        }
        if (!c) return; // block scrolled out of the rendered viewport
        controls.push({
          from,
          lang,
          top: c.top - base.top + 1,
          right: 12,
          caret: head >= from && head <= to,
        });
      });

      // Anchor the dismiss button to the panel element itself for pixel accuracy.
      // A block-widget panel can land in the DOM a frame after the decoration
      // update, so the deferred re-measure in update() guarantees a pass once it
      // is present.
      const closes: CloseSpec[] = [];
      for (const run of view.state.field(runsField)) {
        const panel = view.dom.querySelector<HTMLElement>(`[data-ledge-run="${run.id}"]`);
        if (!panel) continue;
        const r = panel.getBoundingClientRect();
        closes.push({
          id: run.id,
          top: r.top - base.top + 3, // 3px into the 24px header
          right: base.right - r.right + 6, // 6px in from the panel's right edge
        });
      }

      const sig =
        controls.map((c) => `${c.from}:${c.lang}`).join("|") + "#" + closes.map((c) => c.id).join("|");
      const rect = { top: base.top, left: base.left, width: base.width, height: base.height };
      return { rect, controls, closes, sig };
    }

    write(m: Measured) {
      // Pin the fixed layer over the editor's current rect, so child buttons
      // positioned relative to it land on their blocks and are clipped to the
      // editor. Rechecked every measure, which covers window resize and the
      // terminal drawer opening/closing under the editor.
      this.layer.style.top = `${m.rect.top}px`;
      this.layer.style.left = `${m.rect.left}px`;
      this.layer.style.width = `${m.rect.width}px`;
      this.layer.style.height = `${m.rect.height}px`;

      if (m.sig !== this.sig) {
        this.rebuild(m);
        this.sig = m.sig;
      }
      for (const c of m.controls) {
        const el = this.layer.querySelector<HTMLElement>(`.ledge-ctl-group[data-block="${c.from}"]`);
        if (!el) continue;
        el.style.top = `${c.top}px`;
        el.style.right = `${c.right}px`;
        el.classList.toggle("caret", c.caret);
      }
      for (const c of m.closes) {
        const el = this.layer.querySelector<HTMLElement>(`.ledge-close-wrap[data-close="${c.id}"]`);
        if (!el) continue;
        el.style.top = `${c.top}px`;
        el.style.right = `${c.right}px`;
      }
    }

    rebuild(m: Measured) {
      this.layer.textContent = "";
      for (const c of m.controls) {
        const group = document.createElement("div");
        group.className = "ledge-ctl-group";
        group.dataset.block = String(c.from);
        if (isRunnable(c.lang)) {
          group.appendChild(
            iconButton(PLAY_ICON, "Run inline (⌘⏎)", (e) => {
              e.preventDefault();
              runBlock(this.view, c.from, "inline");
            }),
          );
          group.appendChild(
            iconButton(TERMINAL_ICON, "Run in terminal (⇧⌘⏎)", (e) => {
              e.preventDefault();
              runBlock(this.view, c.from, "terminal");
            }),
          );
        }
        const copyBtn = iconButton(COPY_ICON, "Copy", (e) => {
          e.preventDefault();
          const block = blockAt(this.view.state, c.from);
          if (!block) return;
          copyText(block.code);
          flashCopied(copyBtn);
        });
        group.appendChild(copyBtn);
        this.layer.appendChild(group);
      }
      for (const c of m.closes) {
        // Mirror the control group's structure exactly: an absolutely-positioned
        // wrapper holding a statically-positioned button.
        const wrap = document.createElement("div");
        wrap.className = "ledge-close-wrap";
        wrap.dataset.close = c.id;
        wrap.appendChild(
          iconButton(CLOSE_ICON, "Dismiss", (e) => {
            e.preventDefault();
            this.view.dispatch({ effects: removeRun.of(c.id) });
          }),
        );
        this.layer.appendChild(wrap);
      }
      // Re-lighting after a rebuild: keep the hovered block's controls visible.
      if (this.hovered != null) {
        const g = this.layer.querySelector<HTMLElement>(`.ledge-ctl-group[data-block="${this.hovered}"]`);
        g?.classList.add("hover");
      }
    }

    destroy() {
      this.view.scrollDOM.removeEventListener("mousemove", this.onMove);
      this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
      this.layer.remove();
    }
  },
);

// --- Decorations -----------------------------------------------------------

function buildDecorations(state: EditorView["state"]): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const run of state.field(runsField)) {
    const anchor = Math.min(run.pos, state.doc.length);
    const line = state.doc.lineAt(anchor);
    ranges.push(Decoration.widget({ widget: new OutputWidget(run), block: true, side: 1 }).range(line.to));
  }
  return Decoration.set(ranges, true);
}

const decorationsField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update(deco, tr) {
    if (tr.docChanged || tr.effects.length) return buildDecorations(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// --- Native -> web ---------------------------------------------------------

export function handleRunEvent(view: EditorView, id: string, kind: string, payload: unknown): void {
  switch (kind) {
    case "started":
      view.dispatch({ effects: setRunState.of({ id, state: "running", exitCode: null }) });
      break;
    case "output": {
      const text = decodeBase64(String(payload));
      view.dispatch({ effects: appendOutput.of({ id, text }) });
      break;
    }
    case "finished": {
      const code = typeof payload === "number" ? payload : (payload as { exitCode?: number })?.exitCode ?? 0;
      view.dispatch({ effects: setRunState.of({ id, state: code === 0 ? "done" : "error", exitCode: code }) });
      break;
    }
  }
}

export function failAllRuns(view: EditorView): void {
  for (const r of view.state.field(runsField)) {
    if (r.state === "running") {
      view.dispatch({ effects: setRunState.of({ id: r.id, state: "error", exitCode: null }) });
    }
  }
}

// --- Helpers ---------------------------------------------------------------

const RUNNABLE = new Set(["sh", "bash", "zsh", "shell", "console", "python", "python3", "py", "ruby", "rb", "node", "js", "javascript"]);
function isRunnable(lang: string | null): boolean {
  return lang != null && RUNNABLE.has(lang.toLowerCase());
}

function statusText(run: RunInfo): string {
  if (run.state === "running") return "Running";
  if (run.state === "error") return run.exitCode != null ? `Exited ${run.exitCode}` : "Session ended";
  return "Done";
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function decodeBase64(b64: string): string {
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

// --- Extension -------------------------------------------------------------

export function ledgeBlocks(): Extension {
  return [
    runsField,
    decorationsField,
    overlayPlugin,
    keymap.of([
      {
        key: "Mod-Enter",
        run: (view) => runBlock(view, view.state.selection.main.head, "inline"),
      },
      {
        key: "Shift-Mod-Enter",
        run: (view) => runBlock(view, view.state.selection.main.head, "terminal"),
      },
    ]),
  ];
}
