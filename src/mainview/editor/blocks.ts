import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  toNative,
  cancelRun,
  isTerminalBusy,
  onTerminalBusyChange,
  resizeInline,
  inputInline,
  type RunDestination,
} from "./bridge";
import { sessionIdFacet } from "./session";
import { acquireInlineTerm, getInlineTerm, releaseInlineTerm } from "./inlineTerm";
import { copyText } from "../lib/clipboard";
import { settings } from "../lib/settings";
import { keyOf, type CommandId } from "../commands/keys";
import { tooltip } from "../commands/format";

// One inline run of a code block. Output accumulates as bytes arrive from native.
export interface RunInfo {
  id: string;
  from: number; // block start (maps through edits), used to match on re-run
  pos: number; // anchor for the output panel (block end line), maps through edits
  lang: string | null;
  state: "running" | "done" | "error";
  exitCode: number | null;
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
const removeRun = StateEffect.define<string>();
// A full document replace from native (loading a note) drops all inline output.
// Not dispatched yet (note persistence is unwired); when it is, it must interrupt
// any still-running run first (see the dismiss button) or it will orphan a program
// in the note's shared shell.
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

// Whether this note's inline shell is mid-block. A note has one inline shell, so
// any running block closes every block in the note, not just the one that is going.
//
// Known gap, and a real one: the blocks of a note are not independent, and this is
// the blunt way to say so. Letting a second block through while the first runs does
// not queue it politely. The shell is mid-job, so the tty echoes the second block's
// marker command straight into the FIRST block's output, and the parser, which can
// only go by markers, files that echo under the running block. You get the other
// block's plumbing printed inside the panel you are watching.
//
// The fix is not on this side: Bun should hold the bytes until the shell is back at
// a prompt, rather than writing them into a busy one. It already does exactly this
// for the drawer (pasteQueue / promptReady in bun/index.ts), and the inline shell
// wants the same treatment. Until then, one block at a time per note.
export function isInlineBusy(state: EditorState): boolean {
  return state.field(runsField).some((r) => r.state === "running");
}

// Whether a block can be sent to `destination` right now. Both shells are single
// and serial: a second block sent while one is running does not run, it waits, and
// the wait is not something either shell can currently show.
//
// Runs are per editor and an editor is per note, and terminal busy is keyed by the
// note's session, so neither rule reaches across notes: their shells are separate
// and so is their state.
export function canRun(view: EditorView, destination: RunDestination): boolean {
  return destination === "terminal"
    ? !isTerminalBusy(view.state.facet(sessionIdFacet))
    : !isInlineBusy(view.state);
}

export function runBlock(view: EditorView, pos: number, destination: RunDestination): boolean {
  const block = blockAt(view.state, pos);
  if (!block || !isRunnable(block.lang)) return false;
  // Checked here rather than only on the buttons, so the keymap and the palette
  // are held to the same rule: a disabled-looking button and a live Cmd+Enter
  // would just move the invisible queue somewhere else.
  if (!canRun(view, destination)) return false;

  // This note's id, so the run reaches this note's own shell (see bridge.ts).
  const sessionId = view.state.facet(sessionIdFacet);

  if (destination === "terminal") {
    // Output goes to the drawer; no inline panel is created here.
    toNative({ type: "run", sessionId, code: block.code, language: block.lang, destination: "terminal" });
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
      startedAt: Date.now(),
      durationMs: null,
    }),
  });
  toNative({ type: "run", sessionId, id, code: block.code, language: block.lang, destination: "inline" });
  return true;
}

// --- Output widget ---------------------------------------------------------
//
// The output panel is a block widget: it reserves vertical space and pushes the
// following text down, which only an in-content block widget can do. For a normal
// run it renders the note's output through a real terminal emulator (xterm.js),
// which lives in a pool keyed by run id (see inlineTerm.ts) because a widget is
// rebuilt on every change but a terminal must persist and be written to
// incrementally. The widget only re-parents the pooled DOM; handleRunEvent writes
// bytes and updates the header imperatively. `eq` therefore only distinguishes id:
// state/duration changes are pushed to the live DOM, so CodeMirror keeps the
// terminal mounted across them. A block that launches a full-screen or interactive
// program (vim, claude, a REPL) renders and is driven inline; the block's terminal
// button stays the escape hatch to the full drawer.
//
// Its dismiss/copy buttons live in the overlay layer (see `overlayPlugin`) so they
// sit outside the editable surface, where the browser honours `cursor: pointer`.

class OutputWidget extends WidgetType {
  constructor(readonly run: RunInfo) {
    super();
  }
  eq(other: OutputWidget) {
    return other.run.id === this.run.id;
  }
  toDOM(view: EditorView): HTMLElement {
    const sessionId = view.state.facet(sessionIdFacet);
    const it = acquireInlineTerm(this.run.id, {
      // Keep the note's inline shell winsize matched to the rendered grid, so
      // size-aware programs lay out correctly inline.
      onResize: (cols, rows) => resizeInline(sessionId, cols, rows),
      // Keystrokes from the live block go to the note's inline shell, so an
      // interactive program running inline can be typed into.
      onInput: (data) => inputInline(sessionId, data),
      // The terminal changes height out of band (first output, freeze); ask
      // CodeMirror to re-measure so following content sits at the right offset.
      onHeightChange: () => view.requestMeasure(),
      // When the command finishes, hand focus back to the prose editor.
      onFocusEditor: () => view.focus(),
    });
    it.setState(this.run);
    return it.wrap;
  }

  // CodeMirror removed this widget (run dismissed, block deleted, note reloaded):
  // drop the pooled terminal so it does not leak. Idempotent.
  destroy() {
    releaseInlineTerm(this.run.id);
  }
  // Let the browser own events inside the panel: xterm manages its own selection
  // and focus, and CodeMirror would otherwise treat a mousedown here as a click
  // into the document. The panel is contenteditable=false.
  ignoreEvent() {
    return true;
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

// Why a run button is off. Worth spelling out on the button itself: "nothing
// happened when I clicked" is the problem we are fixing, and a gray button with no
// reason is a quieter version of the same mystery.
const INLINE_BUSY = "This note's shell is running a block";
const TERM_BUSY = "This note's terminal is busy";

// Gray out a run button while its shell cannot take a block. The native `disabled`
// does the work: it stops the mousedown, so the click cannot queue anything, and
// there is no second code path to keep in step with the CSS.
function setBusy(btn: HTMLButtonElement | null, busy: boolean, id: CommandId, why: string): void {
  if (!btn) return;
  btn.disabled = busy;
  btn.title = busy ? why : tooltip(id);
}

function iconButton(markup: string, title: string, onDown: (e: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "ledge-btn";
  b.title = title;
  b.innerHTML = markup;
  // mousedown, not click: run before the editor moves the selection or steals focus.
  b.addEventListener("mousedown", onDown);
  return b;
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
  // Per destination, because a note's two shells are independent: a block can be
  // running inline and still free to send to the drawer.
  runBusy: boolean;
  termBusy: boolean;
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
    onKeyDown: (e: KeyboardEvent) => void;
    offBusy: () => void;

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
      // Cmd+C over a selection inside an output panel: the panel is a
      // contenteditable=false widget and the WebView's native copy does not put
      // its text on the clipboard, so copy the selection explicitly through the
      // native clipboard. Capture phase, so it runs before CodeMirror's own key
      // handling. Scoped to this editor's panels, so with pooled editors only the
      // one holding the selection acts.
      this.onKeyDown = (e) => this.handleCopyKey(e);
      // The terminal drawer's shell going busy or idle is invisible to the editor's
      // own update cycle (no doc, geometry, or run-state change), so the chrome has
      // to be told. Every editor subscribes; read() filters by its own note.
      this.offBusy = onTerminalBusyChange(() => this.schedule());
      document.addEventListener("keydown", this.onKeyDown, true);
      view.scrollDOM.addEventListener("mousemove", this.onMove);
      view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
      this.schedule();
    }

    handleCopyKey(e: KeyboardEvent) {
      if (!(e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "c" || e.key === "C"))) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const anchor = sel.anchorNode;
      const el = anchor && (anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement);
      const body = el?.closest?.(".ledge-output-body");
      if (!body || !this.view.dom.contains(body)) return;
      const text = sel.toString();
      if (!text) return;
      // Consume the event: preventDefault stops the native (beeping) copy, and
      // stopping propagation keeps the editor's Mod-c keymap from also running and
      // overwriting the clipboard with the (unrelated) document selection.
      e.preventDefault();
      e.stopPropagation();
      copyText(text);
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

      // The card's right border, measured rather than assumed. A block's card is a
      // line decoration, so it spans `.cm-content`'s content box: its right edge
      // moves whenever that box narrows, and a note long enough to scroll narrows it
      // by the scrollbar's width. Deriving the inset from the editor's outer rect
      // instead would leave the buttons where the card used to end, hanging off it.
      const content = view.contentDOM.getBoundingClientRect();
      const padRight = parseFloat(getComputedStyle(view.contentDOM).paddingRight) || 0;
      const cardInset = base.right - (content.right - padRight);

      // Both shells are per note, so their busy state is the same for every block
      // in this editor: measure it once, not once per block.
      const runBusy = isInlineBusy(view.state);
      const termBusy = isTerminalBusy(view.state.facet(sessionIdFacet));

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
          // Anchor to the opening fence line's glyph (coordsAtPos), nudged up so the
          // group sits in the panel's top padding at the card's top-right corner.
          // Glyph-based (not the line's DOM rect) so it lands identically whether or
          // not an output panel is present, in every engine.
          top: c.top - base.top - 3,
          // Sit inside the card's top-right corner rather than flush against it.
          right: cardInset + 10,
          caret: head >= from && head <= to,
          runBusy,
          termBusy,
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
        setBusy(el.querySelector('[data-act="run"]'), c.runBusy, "block.runInline", INLINE_BUSY);
        setBusy(el.querySelector('[data-act="term"]'), c.termBusy, "block.runInTerminal", TERM_BUSY);
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
          const runBtn = iconButton(PLAY_ICON, tooltip("block.runInline"), (e) => {
            e.preventDefault();
            runBlock(this.view, c.from, "inline");
          });
          runBtn.dataset.act = "run";
          group.appendChild(runBtn);
          const termBtn = iconButton(TERMINAL_ICON, tooltip("block.runInTerminal"), (e) => {
            e.preventDefault();
            runBlock(this.view, c.from, "terminal");
          });
          termBtn.dataset.act = "term";
          group.appendChild(termBtn);
        }
        const copyBtn = iconButton(COPY_ICON, tooltip("block.copy"), (e) => {
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
        // An absolutely-positioned wrapper holding the output panel's controls:
        // copy (the current output, ANSI stripped) and dismiss.
        const wrap = document.createElement("div");
        wrap.className = "ledge-close-wrap";
        wrap.dataset.close = c.id;
        const copyBtn = iconButton(COPY_ICON, tooltip("block.copyOutput"), (e) => {
          e.preventDefault();
          const text = getInlineTerm(c.id)?.plainText();
          if (!text) return;
          copyText(text);
          flashCopied(copyBtn);
        });
        wrap.appendChild(copyBtn);
        wrap.appendChild(
          iconButton(CLOSE_ICON, tooltip("block.dismissOutput"), (e) => {
            e.preventDefault();
            // Dismissing a still-running block must not orphan its process: the
            // note's shell is shared, so a program left in the foreground would
            // keep it busy forever and silently swallow every later block. Only
            // interrupt if THIS run is the running one; dismissing an old finished
            // panel must not cancel whatever is running now.
            const run = this.view.state.field(runsField).find((r) => r.id === c.id);
            if (run?.state === "running") cancelRun(this.view.state.facet(sessionIdFacet));
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
      this.offBusy();
      document.removeEventListener("keydown", this.onKeyDown, true);
      this.view.scrollDOM.removeEventListener("mousemove", this.onMove);
      this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
      this.layer.remove();
    }
  },
);

// --- Decorations -----------------------------------------------------------

// A rounded panel behind each fenced code block, so code stands out from prose.
// Every line of the block gets a background (via a line decoration); the opening
// and closing fence lines additionally round the top/bottom corners. Emitted
// first, in document order, so the combined set stays sorted by position.
function fencePanelDecorations(state: EditorView["state"], out: Range<Decoration>[]): void {
  eachBlock(state, (from, to) => {
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(Math.min(to, state.doc.length)).number;
    for (let n = first; n <= last; n += 1) {
      const cls =
        "ledge-code" + (n === first ? " ledge-code-top" : "") + (n === last ? " ledge-code-bottom" : "");
      out.push(Decoration.line({ class: cls }).range(state.doc.line(n).from));
    }
  });
}

function buildDecorations(state: EditorView["state"]): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  fencePanelDecorations(state, ranges);
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
  // Every open note's editor gets every run event (bridge.ts broadcasts to all
  // sinks), so the first question is whether this view is the one that started the
  // run. Only the view that dispatched addRun has the id in its runsField.
  //
  // The state effects below already no-op for a foreign id, but the terminal pool
  // is keyed by run id alone and so is reachable from any view: without this,
  // output would be written once per open editor, and one `echo hi` would print
  // as many lines as you had notes open.
  if (!view.state.field(runsField).some((r) => r.id === id)) return;

  switch (kind) {
    case "started":
      view.dispatch({ effects: setRunState.of({ id, state: "running", exitCode: null }) });
      break;
    case "output": {
      // Write raw bytes to the block's terminal (xterm owns the UTF-8 decode, so a
      // multi-byte character split across chunks is handled). No state effect: the
      // terminal renders incrementally, so output must not rebuild the widget.
      getInlineTerm(id)?.write(bytesFromBase64(String(payload)));
      break;
    }
    case "finished": {
      // null means the shell died with the block still open: no status to show, so
      // the panel says "Session ended" rather than inventing an exit code.
      const code = typeof payload === "number" ? payload : null;
      view.dispatch({
        effects: setRunState.of({ id, state: code === 0 ? "done" : "error", exitCode: code }),
      });
      // Push the final state to the terminal header and shrink it to the used rows.
      const run = view.state.field(runsField).find((r) => r.id === id);
      const it = getInlineTerm(id);
      if (run && it) {
        it.setState(run);
        it.freeze();
      }
      break;
    }
  }
}

export function failAllRuns(view: EditorView): void {
  for (const r of view.state.field(runsField)) {
    if (r.state === "running") {
      view.dispatch({ effects: setRunState.of({ id: r.id, state: "error", exitCode: null }) });
      const it = getInlineTerm(r.id);
      if (it) {
        const updated = view.state.field(runsField).find((x) => x.id === r.id);
        if (updated) it.setState(updated);
        it.freeze();
      }
    }
  }
}

// --- Helpers ---------------------------------------------------------------

// Which fence languages get a Run button is a setting (blocks.runnable). Built
// on first use, then cached: this runs in the decoration pass on every edit,
// and the snapshot never changes after boot (settings apply at launch).
let runnable: Set<string> | null = null;
function isRunnable(lang: string | null): boolean {
  runnable ??= new Set(settings().blocks.runnable);
  return lang != null && runnable.has(lang.toLowerCase());
}

function bytesFromBase64(b64: string): Uint8Array {
  try {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array(0);
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
        key: keyOf("block.runInline")!,
        run: (view) => runBlock(view, view.state.selection.main.head, "inline"),
      },
      {
        key: keyOf("block.runInTerminal")!,
        run: (view) => runBlock(view, view.state.selection.main.head, "terminal"),
      },
    ]),
  ];
}
