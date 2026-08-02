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
  editProfile,
  isTerminalBusy,
  notifyUser,
  onTerminalBusyChange,
  resizeInline,
  inputInline,
  requestHostPick,
  requestRunConfirm,
  type RunDestination,
} from "./bridge";
import { confirmFor, parseFenceInfo, type ConfirmSpec } from "./fenceInfo";
import { runsCommands } from "../lib/shell";
import { fenceCloser, fenceOpener } from "./fences";
import { declaredHosts, frontmatterRange, profileChipAnchor } from "./frontmatter";
import { LOCAL_HOST, parseFrontmatter } from "../../shared/frontmatter";
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
  // The machine this run targets (null = local/undeclared). Shown in the
  // output panel's header: with multiple machines in play, output that does
  // not say where it came from is a misread waiting to happen.
  host: string | null;
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
  // Whether a closing fence ends the block (see fenceClosed). Everything that
  // offers to RUN hangs off this.
  closed: boolean;
  // The fence's confirm marker resolved against the note's default, or null
  // when this block runs straight through (editor/fenceInfo.ts).
  confirm: ConfirmSpec | null;
}

// --- Run state -------------------------------------------------------------

const addRun = StateEffect.define<RunInfo>();
const setRunState = StateEffect.define<{ id: string; state: RunInfo["state"]; exitCode: number | null }>();
const removeRun = StateEffect.define<string>();
// A full document replace from native (loading a note) drops all inline output.
// Not dispatched yet (note persistence is unwired); when it is, it must interrupt
// any still-running runs first (see the dismiss button) or it will orphan their
// programs in the note's shells.
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
        // assoc -1, same as `from`: text inserted exactly at the anchor — an
        // agent appending to a note that ENDS with this block puts it right
        // here — must land BELOW the output panel, not push the panel down
        // past itself. The panel hugs its fence; what arrives after follows.
        pos: tr.changes.mapPos(r.pos, -1),
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

// The opening fence line's info string, e.g. `sh confirm` from "```sh confirm".
// Read from the line text rather than Lezer child nodes, whose names/shape are
// less stable; the grammar (and what an attribute means) lives in fenceInfo.ts.
function infoFromFence(state: EditorView["state"], from: number) {
  return parseFenceInfo(state.doc.lineAt(from).text);
}

/**
 * Whether the block's last line is a closing fence.
 *
 * Lezer gives an unterminated block a FencedCode node too — it simply ends on
 * the last BODY line — so the node's shape alone cannot tell "```sh / pwd /
 * ```" from a note that stops mid-block. Nothing downstream can recover the
 * difference either, which is why it is read once, here, off the two fence
 * lines the block claims to have.
 */
function fenceClosed(state: EditorView["state"], from: number, to: number): boolean {
  const openLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(Math.min(to, state.doc.length));
  // A one-line node is the opener alone: it cannot be its own closer.
  if (endLine.number <= openLine.number) return false;
  const f = fenceOpener(openLine.text);
  return !!f && fenceCloser(endLine.text, f.marker);
}

function readBlock(state: EditorView["state"], from: number, to: number): Block {
  const doc = state.doc;
  const openLine = doc.lineAt(from);
  const endLine = doc.lineAt(Math.min(to, doc.length));
  const info = infoFromFence(state, from);
  const lang = info.lang;
  const closed = fenceClosed(state, from, to);

  // Body is the lines strictly between the opening fence and the closing one —
  // or, in an unterminated block, everything after the opener: there the node
  // ends on the last body line, so discounting it would silently eat that line
  // (and, in a one-line block, the entire body). Nothing may RUN from here
  // while `closed` is false (runBlock), but the copy button reads this same
  // body, and copying all-but-the-last-line is its own quiet lie.
  const firstBody = openLine.number + 1;
  const lastBody = closed ? endLine.number - 1 : endLine.number;
  let code = "";
  if (lastBody >= firstBody) {
    code = doc.sliceString(doc.line(firstBody).from, doc.line(lastBody).to);
  }
  return { from, to, lang, code, closed, confirm: confirmFor(info.attrs, noteConfirms(state)) };
}

// Every fenced block in the document, as the facts its chrome is built from.
// An object rather than positional arguments: `asks` and `closed` are both
// booleans, and a transposition there would be invisible at the call site and
// loud on screen.
function eachBlock(
  state: EditorView["state"],
  cb: (b: { from: number; to: number; lang: string | null; asks: boolean; closed: boolean }) => void,
): void {
  const noteDefault = noteConfirms(state);
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "FencedCode") return;
      const info = infoFromFence(state, node.from);
      cb({
        from: node.from,
        to: node.to,
        lang: info.lang,
        asks: confirmFor(info.attrs, noteDefault) !== null,
        closed: fenceClosed(state, node.from, node.to),
      });
    },
  });
}

// --- Running ---------------------------------------------------------------

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `web-${idCounter}-${Date.now()}`;
}

// Whether one of THIS block's runs is still going. Inline concurrency is per
// block, not per note: each run gets its own shell on the Bun side (a busy note
// shell diverts the run to a fresh overflow shell; see bun/inlinePool.ts), so
// another block running is no reason to gate this one. The same block is
// different: addRun replaces any earlier run anchored inside it, and replacing a
// live run's panel would orphan its process — still running, nothing on screen
// to show or stop it. So one live run per block; re-running waits for (or
// dismisses) the current one.
export function isBlockRunning(state: EditorState, from: number, to: number): boolean {
  const end = state.doc.lineAt(Math.min(to, state.doc.length)).to;
  return state.field(runsField).some((r) => r.state === "running" && r.pos >= from && r.pos <= end);
}

// Whether a block can be sent to `destination` right now. The terminal drawer is
// one serial shell per note — a block sent while it is busy queues invisibly, so
// that gate is note-wide. Inline runs gate per block (above).
//
// Runs are per editor and an editor is per note, and terminal busy is keyed by
// the note's session, so neither rule reaches across notes: their shells are
// separate and so is their state.
export function canRun(view: EditorView, block: { from: number; to: number }, destination: RunDestination): boolean {
  return destination === "terminal"
    ? !isTerminalBusy(view.state.facet(sessionIdFacet))
    : !isBlockRunning(view.state, block.from, block.to);
}

// Whether this editor's note is LOCKED (its frontmatter carries the crypto
// header — the doc is decrypted plaintext, but the note's contract holds).
// A head read like every frontmatter question: `when`-cheap.
function noteLocked(state: EditorState): boolean {
  return parseFrontmatter(state.sliceDoc(0, Math.min(4096, state.doc.length))).params.locked !== null;
}

// Whether this note declares `confirm: true` — every runnable block asks
// first, unless its own fence says otherwise. Same cheap head read.
function noteConfirms(state: EditorState): boolean {
  return parseFrontmatter(state.sliceDoc(0, Math.min(4096, state.doc.length))).params.confirm;
}

export function runBlock(view: EditorView, pos: number, destination: RunDestination): boolean {
  const block = blockAt(view.state, pos);
  if (!block || !isRunnable(block.lang)) return false;
  // An unterminated fence has no agreed end, so there is nothing honest to
  // run: what the block "contains" is decided by whatever closer turns up
  // below it, and until one does, Lezer ends the node on the last body line.
  // Sending that guess to a shell is how an empty body reaches `source` and
  // reports a cheerful exit 0 having run nothing at all.
  //
  // The buttons are simply absent for this (rebuild), so this is the chord's
  // and the palette's half — and it answers rather than returning false,
  // because a key that does nothing reads as a broken key.
  if (!block.closed) {
    notifyUser(BLOCK_UNCLOSED);
    return true;
  }
  // A ```prompt fence's contract is "pipe this body to the agent CLI" — in a
  // locked note it does not run, either destination (locking.md §8: the
  // send-direction half of the no-agents invariant; Bun re-validates, this is
  // the UI half). The chord answers with the notice strip, not silence, and
  // returns true: the chord was understood and refused, not unclaimed.
  // Other languages stay runnable — a locked ops note's commands are the
  // user's own compute, and running them may be the point.
  if (block.lang === "prompt" && noteLocked(view.state)) {
    notifyUser(PROMPT_SEALED);
    return true;
  }
  // Checked here rather than only on the buttons, so the keymap and the palette
  // are held to the same rule: a disabled-looking button and a live Cmd+Enter
  // would just move the invisible queue somewhere else.
  if (!canRun(view, block, destination)) return false;

  // This note's id, so the run reaches this note's own shell (see bridge.ts).
  const sessionId = view.state.facet(sessionIdFacet);
  const hosts = declaredHosts(view.state);

  if (destination === "terminal") {
    // Output goes to the drawer; no inline panel is created here. The declared
    // list rides along un-picked: the drawer is one shell with one host for
    // its whole life, so whether a picker is even meaningful (only when this
    // paste is what spawns the shell) is App's call, not per-block ours. The
    // confirm marker rides along for the same reason — the dialog belongs
    // after the machine is settled, and App is where that happens.
    toNative({
      type: "run",
      sessionId,
      code: block.code,
      language: block.lang,
      destination: "terminal",
      hosts,
      anchor: pickerAnchor(view, block.from),
      confirm: block.confirm,
    });
    return true;
  }

  // More than one declared host: nothing executes until the user names the
  // machine — every run, deliberately (a prod/staging list must never run on
  // a remembered default; the remembered pick is only the preselection).
  //
  // The confirm dialog comes AFTER the pick, never before: on a multi-host
  // note the frightening part of "run this" is WHICH MACHINE, so the question
  // has to be able to name it. Cancelling the dialog leaves the pick spent
  // and nothing run, which is the correct shape — the next run asks again.
  if (hosts.length > 1) {
    requestHostPick(sessionId, {
      hosts,
      anchor: pickerAnchor(view, block.from),
      onPick: (host) => confirmThen(block, host, () => startInlineRun(view, sessionId, block, host)),
    });
    return true;
  }
  const host = hosts[0] ?? null;
  confirmThen(block, host, () => startInlineRun(view, sessionId, block, host));
  return true;
}

// Interpose the confirmation when the block asked for one, then run. The one
// place an INLINE run can be gated, so the chord, the palette, and the run
// button cannot diverge into an unconfirmed path (interactions.md §4). The
// terminal destination is gated in App, after its own host question settles.
function confirmThen(block: Block, host: string | null, proceed: () => void): void {
  if (!block.confirm) {
    proceed();
    return;
  }
  requestRunConfirm({
    message: block.confirm.message,
    code: block.code,
    lang: block.lang,
    host,
    destination: "inline",
    onConfirm: proceed,
  });
}

// Where the host picker opens: at the block's control corner, which is where
// the click that asked for it (or the block the caret is in) already is.
function pickerAnchor(view: EditorView, from: number): { x: number; y: number } {
  const base = view.dom.getBoundingClientRect();
  let y = base.top + 40;
  try {
    const c = view.coordsAtPos(view.state.doc.lineAt(from).from);
    if (c) y = c.bottom + 4;
  } catch {
    // block scrolled out of the rendered viewport; the fallback y is fine
  }
  return { x: base.right - 240, y };
}

function startInlineRun(
  view: EditorView,
  sessionId: string,
  block: Block,
  host: string | null,
): boolean {
  // Re-checked when the answer comes back asynchronously: the block's earlier
  // run may have started (double ⌘↵) while the picker or the confirmation was
  // open.
  if (isBlockRunning(view.state, block.from, block.to)) return false;
  const id = nextId();
  view.dispatch({
    effects: addRun.of({
      id,
      from: block.from,
      pos: view.state.doc.lineAt(block.to).to,
      lang: block.lang,
      host,
      state: "running",
      exitCode: null,
      startedAt: Date.now(),
      durationMs: null,
    }),
  });
  toNative({ type: "run", sessionId, id, code: block.code, language: block.lang, destination: "inline", host });
  // Hand the keyboard to the run when it starts talking, so an inline command
  // that asks something (a sudo password, a y/N) can be answered by typing —
  // the old behavior left focus in the prose and typed the answer into the
  // note, which for a password meant writing a secret to disk.
  //
  // The claim lapses unless this editor still has focus and the caret has not
  // moved when the first byte lands (inlineTerm.claimFocus): pressing ⌘↩ and
  // going back to writing is a common flow, and a build that prints its first
  // line thirty seconds later must not swallow the sentence in progress.
  //
  // The test is deliberately taken THEN and not now: a run started from the
  // host picker (or a run button) leaves focus on the popover for a beat, and
  // the question that matters is where the user is when the answer is wanted.
  const head = view.state.selection.main.head;
  getInlineTerm(id)?.claimFocus(() => view.hasFocus && view.state.selection.main.head === head);
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
      // Keep the run's shell winsize matched to the rendered grid, so
      // size-aware programs lay out correctly inline.
      onResize: (cols, rows) => resizeInline(sessionId, this.run.id, cols, rows),
      // Keystrokes from the live block go to the run's shell, so an
      // interactive program running inline can be typed into.
      onInput: (data) => inputInline(sessionId, this.run.id, data),
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
const KEY_ICON = svg('<circle cx="5" cy="11" r="2.7"/><path d="M7 9l6.5-6.5"/><path d="M10.5 5.5l2.2 2.2"/>');
const CLOSE_ICON = svg('<path d="M4 4l8 8M12 4l-8 8"/>');

// Why a run button is off. Worth spelling out on the button itself: "nothing
// happened when I clicked" is the problem we are fixing, and a gray button with no
// reason is a quieter version of the same mystery.
const INLINE_BUSY = "This block is still running";
const TERM_BUSY = "This note's terminal is busy";
// A prompt fence's why in a locked note — one sentence for the button
// tooltip AND the chord's notice (bridge notifyUser), so they cannot drift.
const PROMPT_SEALED =
  "Prompt blocks can't be run in locked notes. AI agents aren't allowed to read locked notes.";
// The chord's answer for a fence with no closing line. Only the chord and the
// palette can reach it: an unclosed block never draws the buttons.
const BLOCK_UNCLOSED = "This code block has no closing fence, so there is nothing to run yet.";

// Gray out a run button while its shell cannot take a block. The native `disabled`
// does the work: it stops the mousedown, so the click cannot queue anything, and
// there is no second code path to keep in step with the CSS.
// `hostHint` keeps the target machine visible where no picker will interrupt:
// a single-host note runs on that host silently, so the tooltip is the one
// place that says so before the click. `asks` says the click opens the
// confirmation rather than executing (interactions.md §4b) — the fence's own
// `confirm` word is the loud disclosure, this is the one on the button.
function setBusy(
  btn: HTMLButtonElement | null,
  busy: boolean,
  id: CommandId,
  why: string,
  hostHint: string | null,
  asks: boolean,
): void {
  if (!btn) return;
  btn.disabled = busy;
  const hints = [hostHint, asks ? "asks first" : null].filter(Boolean);
  btn.title = busy ? why : hints.length ? `${tooltip(id)}: ${hints.join(", ")}` : tooltip(id);
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
  // Per destination, because the shells are independent: a block can be running
  // inline and still free to send to the drawer. runBusy is also per BLOCK —
  // concurrent inline runs each get their own shell, so only the block's own
  // live run gates it.
  runBusy: boolean;
  termBusy: boolean;
  // Whether the fence is terminated. An unclosed one gets no run pair at all
  // (rebuild), so this rides in the signature below: the buttons have to
  // appear the moment the closing fence is typed.
  closed: boolean;
  // Whether a click here opens the confirmation first. Said on the button, in
  // the same breath as the host: where a run will happen and whether it will
  // stop to ask are the two things worth knowing BEFORE the click.
  asks: boolean;
}
interface CloseSpec {
  id: string;
  top: number;
  right: number;
}
// The frontmatter profile's edit button, anchored just past the value's last
// glyph. It lives in this layer, not in the text, for the same reason every
// other button does: out here it gets a real pointer cursor and an obvious
// click target, which the in-text ⌘-click (editor/frontmatter.ts) — kept as
// the accelerator — cannot offer while WebKit pins the I-beam.
interface ProfileSpec {
  name: string;
  top: number;
  left: number;
  caret: boolean;
}
// The compact chip's rendered height (button 16 + padding 2 + border 2), used
// to center it on the profile line. Must match .ledge-fm-chip in index.css.
const FM_CHIP_H = 20;
interface Measured {
  rect: { top: number; left: number; width: number; height: number };
  controls: ControlSpec[];
  closes: CloseSpec[];
  profile: ProfileSpec | null;
  // Tooltip suffix for the run buttons: where a click will execute ("on web1"
  // for the single declared host) or that it will ask ("choose machine…").
  // Note-level, not per block — the frontmatter is one declaration.
  hostHint: string | null;
  sig: string;
}

const overlayPlugin = ViewPlugin.fromClass(
  class {
    layer: HTMLDivElement;
    sig = "";
    // The hovered block's key: a code block's `from` as a string, or "fm" for
    // the frontmatter block.
    hovered: string | null = null;
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
    // to the block line underneath, so the group stays lit. The frontmatter
    // block participates under the key "fm": its edit button reveals on hover
    // anywhere in the block, same grammar as code blocks.
    updateHover(x: number, y: number) {
      const pos = this.view.posAtCoords({ x, y });
      let key: string | null = null;
      if (pos != null) {
        const b = blockAt(this.view.state, pos);
        if (b) key = String(b.from);
        else {
          const fm = frontmatterRange(this.view.state);
          if (fm && pos >= fm.from && pos <= fm.to) key = "fm";
        }
      }
      if (key === this.hovered) return;
      this.hovered = key;
      for (const g of Array.from(this.layer.querySelectorAll<HTMLElement>(".ledge-ctl-group"))) {
        g.classList.toggle("hover", key != null && g.dataset.block === key);
      }
    }

    read(): Measured {
      const view = this.view;
      // A pooled editor for an inactive tab is detached from the DOM (kept alive
      // off-screen; see editorPool.ts). Measuring it would leave the last set of
      // floating buttons stranded on screen, so collapse the overlay entirely
      // until its host is re-parented into a visible pane.
      if (!view.dom.isConnected) {
        return {
          rect: { top: 0, left: 0, width: 0, height: 0 },
          controls: [],
          closes: [],
          profile: null,
          hostHint: null,
          sig: "detached",
        };
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

      // The drawer shell is per note, so its busy state is the same for every
      // block in this editor. Inline runs are per block (each gets its own
      // shell), so that gate is measured inside the loop.
      const termBusy = isTerminalBusy(view.state.facet(sessionIdFacet));

      const controls: ControlSpec[] = [];
      eachBlock(view.state, ({ from, to, lang, asks, closed }) => {
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
          runBusy: isBlockRunning(view.state, from, to),
          termBusy,
          asks,
          closed,
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
          // Column-aligned with the block's own controls above. Those sit at
          // `cardInset + 10` inside a group with 2px padding and a 1px border,
          // so their glyphs land 13px in from the card edge; this wrapper has
          // neither, and the panel is now flush to the card, so 13 puts the two
          // clusters on one line — which is the point of fusing them into one
          // card in the first place.
          right: cardInset + 13,
        });
      }

      // The frontmatter profile's edit button (see ProfileSpec). Same
      // reveal grammar as block controls: visible while the pointer or the
      // caret is in the block. Centered on the line's glyph box — the compact
      // chip sits beside one small text line, not in a card's padded corner.
      let profile: ProfileSpec | null = null;
      const anchor = profileChipAnchor(view.state);
      if (anchor) {
        let pc: { top: number; bottom: number; right: number } | null = null;
        try {
          pc = view.coordsAtPos(anchor.pos);
        } catch {
          pc = null; // scrolled out of the rendered viewport
        }
        if (pc) {
          const fm = frontmatterRange(view.state);
          profile = {
            name: anchor.name,
            top: (pc.top + pc.bottom) / 2 - base.top - FM_CHIP_H / 2,
            left: pc.right - base.left + 6,
            caret: !!fm && head >= fm.from && head <= fm.to,
          };
        }
      }

      const hosts = declaredHosts(view.state);
      const hostHint =
        hosts.length > 1
          ? "choose machine…"
          : hosts.length === 1 && hosts[0] !== LOCAL_HOST
            ? `on ${hosts[0]}`
            : null;

      const sig =
        controls.map((c) => `${c.from}:${c.lang}:${c.closed ? "closed" : "open"}`).join("|") +
        "#" +
        closes.map((c) => c.id).join("|") +
        "#fm:" +
        (profile?.name ?? "");
      const rect = { top: base.top, left: base.left, width: base.width, height: base.height };
      return { rect, controls, closes, profile, hostHint, sig };
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
      // A prompt fence in a locked note wears the busy-button grammar
      // PERMANENTLY: disabled, with the reason as the tooltip. A gray button
      // with no reason is a mystery (the setBusy comment above), and a
      // missing button beside the sh fence's live pair is the same mystery,
      // quieter. runBlock refuses the chords with the same sentence, and Bun
      // re-validates behind both.
      const sealedNote = noteLocked(this.view.state);
      for (const c of m.controls) {
        const el = this.layer.querySelector<HTMLElement>(`.ledge-ctl-group[data-block="${c.from}"]`);
        if (!el) continue;
        el.style.top = `${c.top}px`;
        el.style.right = `${c.right}px`;
        el.classList.toggle("caret", c.caret);
        const sealed = c.lang === "prompt" && sealedNote;
        setBusy(el.querySelector('[data-act="run"]'), c.runBusy || sealed, "block.runInline", sealed ? PROMPT_SEALED : INLINE_BUSY, m.hostHint, c.asks);
        setBusy(el.querySelector('[data-act="term"]'), c.termBusy || sealed, "block.runInTerminal", sealed ? PROMPT_SEALED : TERM_BUSY, m.hostHint, c.asks);
      }
      for (const c of m.closes) {
        const el = this.layer.querySelector<HTMLElement>(`.ledge-close-wrap[data-close="${c.id}"]`);
        if (!el) continue;
        el.style.top = `${c.top}px`;
        el.style.right = `${c.right}px`;
      }
      if (m.profile) {
        const el = this.layer.querySelector<HTMLElement>(`.ledge-ctl-group[data-block="fm"]`);
        if (el) {
          el.style.top = `${m.profile.top}px`;
          el.style.left = `${m.profile.left}px`;
          el.classList.toggle("caret", m.profile.caret);
        }
      }
    }

    rebuild(m: Measured) {
      this.layer.textContent = "";
      for (const c of m.controls) {
        const group = document.createElement("div");
        group.className = "ledge-ctl-group";
        group.dataset.block = String(c.from);
        // Every runnable fence gets its buttons — a prompt fence in a locked
        // note included: the update pass right after this rebuild disables
        // its pair with the sealed reason as tooltip (see the comment there),
        // so the buttons are born gray, never live.
        //
        // An UNCLOSED fence is the one case that gets no pair at all, rather
        // than a disabled one with a reason. The usual argument for the gray
        // button (a missing control is a mystery) does not apply: this block
        // has no end yet because it is still being typed, and a run pair that
        // blinks into existence on the fence line the user is halfway through
        // writing is noise, not an affordance. It appears when the block does.
        // `runsCommands` alongside the language test: a client that does not
        // run blocks must not draw the button that runs one (ios.md §8). Absent
        // rather than disabled — the gray-button argument is for a control that
        // could work in another moment, and this one never can on this client —
        // and the copy button below stays, because copying is not running.
        if (runsCommands() && isRunnable(c.lang) && c.closed) {
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
            // Dismissing a still-running block must not orphan its process: with
            // the panel gone there is nothing on screen to show it or stop it, so
            // interrupt it on the way out. The cancel is addressed by run id, so
            // it reaches exactly this run's shell and no other block's; the state
            // check keeps dismissing an old finished panel from touching anything.
            const run = this.view.state.field(runsField).find((r) => r.id === c.id);
            if (run?.state === "running") cancelRun(this.view.state.facet(sessionIdFacet), c.id);
            this.view.dispatch({ effects: removeRun.of(c.id) });
          }),
        );
        this.layer.appendChild(wrap);
      }
      if (m.profile) {
        const name = m.profile.name;
        const wrap = document.createElement("div");
        wrap.className = "ledge-ctl-group ledge-fm-chip";
        wrap.dataset.block = "fm";
        wrap.appendChild(
          iconButton(KEY_ICON, tooltip("profile.open"), (e) => {
            e.preventDefault();
            editProfile(name);
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
//
// A block with a run attached closes differently: its output panel is fused to
// the card (index.css, `.ledge-code-attached + .ledge-output`) so the two read as
// one object rather than a micro-terminal parked underneath, which means the
// closing fence must leave the card OPEN — no bottom border, no bottom radius.
// The seam is the panel header's top border. The CSS pairing is the sibling
// combinator, so it cannot drift from this class: a panel orphaned by having its
// block deleted out from under it finds no `.ledge-code-attached` before it and
// keeps the free-standing styling.
function fencePanelDecorations(state: EditorView["state"], out: Range<Decoration>[]): void {
  const runs = state.field(runsField);
  eachBlock(state, ({ from, to }) => {
    const first = state.doc.lineAt(from).number;
    const lastLine = state.doc.lineAt(Math.min(to, state.doc.length));
    const last = lastLine.number;
    // Same containment test as isBlockRunning, but state-blind: a finished run
    // still has a panel, and the card has to stay open under it.
    const attached = runs.some((r) => r.pos >= from && r.pos <= lastLine.to);
    for (let n = first; n <= last; n += 1) {
      const cls =
        "ledge-code" +
        (n === first ? " ledge-code-top" : "") +
        (n === last ? (attached ? " ledge-code-attached" : " ledge-code-bottom") : "");
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
    // The chords, on a client that has them. Withheld with the buttons rather
    // than left live: a phone reached by a paired hardware keyboard would
    // otherwise be the one way to run a block on a client whose whole story is
    // that it does not.
    keymap.of(
      runsCommands()
        ? [
            {
              key: keyOf("block.runInline")!,
              run: (view: EditorView) =>
                runBlock(view, view.state.selection.main.head, "inline"),
            },
            {
              key: keyOf("block.runInTerminal")!,
              run: (view: EditorView) =>
                runBlock(view, view.state.selection.main.head, "terminal"),
            },
          ]
        : [],
    ),
  ];
}
