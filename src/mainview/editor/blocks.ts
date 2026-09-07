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
import { confirmFor, noRun, parseFenceInfo, type ConfirmSpec } from "./fenceInfo";
import { hasTerminal, runsBlocks, softKeyboard } from "../lib/shell";
import { activeConnection, linkState, subscribeConnections } from "../lib/connections";
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
  // The machine this run targets (null = local or undeclared). Shown in the
  // output panel's header, so output from a note with several machines in
  // play says which one produced it.
  host: string | null;
  // "unknown" is a run that was going when the wire dropped: whether it is
  // still running cannot be told from here. It resolves on reconnect, back to
  // "running" for the runs the server still has and to a finish for the ones
  // it does not (bridge.ts reconcileRuns).
  state: "running" | "done" | "error" | "unknown";
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
  // offers to run the block hangs off this.
  closed: boolean;
  // The fence's confirm marker resolved against the note's default, or null
  // when this block runs straight through (editor/fenceInfo.ts).
  confirm: ConfirmSpec | null;
  // Whether the fence is marked `norun`: the block is there to be read or
  // copied, not run from this note (editor/fenceInfo.ts, interactions.md
  // §4e). Everything that offers to run the block hangs off this too.
  norun: boolean;
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
// A no-op effect that nudges the body-parented layers to re-measure.
// Dispatched when a pooled editor is re-parented between panes or tabs, so
// they re-pin or collapse at once.
const pingOverlayEffect = StateEffect.define<null>();

// Force both body-parented layers to re-measure now: this one and the hotspot
// layer in livePreview.ts. Used by the editor pool when an editor's DOM host is
// attached to, or detached from, a visible pane. Neither plugin reads this
// effect by name: each re-measures on any transaction carrying effects. The
// hotspot layer was missing that clause and so never heard a detach, leaving a
// background tab's links clickable over the tab in front (interactions.md §6).
// A new body-parented layer needs the same clause; nothing here enforces that.
export function pingOverlay(view: EditorView): void {
  view.dispatch({ effects: pingOverlayEffect.of(null) });
}

// Whether a run is over. "unknown" is not over: if that run ended, it ended
// where this client could not see it.
function ended(state: RunInfo["state"]): boolean {
  return state === "done" || state === "error";
}

const runsField = StateField.define<RunInfo[]>({
  create: () => [],
  update(runs, tr) {
    let next = runs;
    if (tr.docChanged) {
      next = next.map((r) => ({
        ...r,
        from: tr.changes.mapPos(r.from, -1),
        // assoc -1, same as `from`, so text inserted exactly at the anchor
        // lands below the output panel rather than pushing the panel down past
        // it. An agent appending to a note that ends with this block inserts
        // right here.
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
            ? {
                ...r,
                state: e.value.state,
                exitCode: e.value.exitCode,
                // Only an ending stamps a duration. The other two transitions
                // are a run confirmed started and a run losing its machine,
                // and neither is a length of time. Stamping those produced
                // headers reading "Running 0 ms".
                durationMs: ended(e.value.state)
                  ? r.startedAt
                    ? Date.now() - r.startedAt
                    : null
                  : r.durationMs,
              }
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
  // the iterate() callback, and TS control-flow analysis cannot see that the
  // callback runs. A local would stay narrowed to `null` after the call, and
  // the reads below would not typecheck.
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
// Read from the line text rather than from Lezer child nodes, whose names and
// shape are less stable. The grammar, and what an attribute means, lives in
// fenceInfo.ts.
function infoFromFence(state: EditorView["state"], from: number) {
  return parseFenceInfo(state.doc.lineAt(from).text);
}

/**
 * Whether the block's last line is a closing fence.
 *
 * Lezer gives an unterminated block a FencedCode node too, ending it on the
 * last body line, so the node's shape alone cannot tell a closed block from a
 * note that stops mid-block. Nothing downstream can recover the difference, so
 * it is read here, off the block's first and last lines.
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

  // Body is the lines strictly between the opening fence and the closing one.
  // In an unterminated block it is everything after the opener, because the
  // node ends on the last body line: discounting that line would drop it, and
  // in a one-line block the whole body with it. Nothing runs while `closed` is
  // false (runBlock), but the copy button reads this same body, and copying
  // every line but the last hands back text the block does not contain.
  const firstBody = openLine.number + 1;
  const lastBody = closed ? endLine.number - 1 : endLine.number;
  let code = "";
  if (lastBody >= firstBody) {
    code = doc.sliceString(doc.line(firstBody).from, doc.line(lastBody).to);
  }
  return { from, to, lang, code, closed, confirm: confirmFor(info.attrs, noteConfirms(state)), norun: noRun(info.attrs) };
}

// Every fenced block in the document, as the facts its chrome is built from.
// The callback takes an object rather than positional arguments: `asks`,
// `closed` and `norun` are all booleans, and swapping two at a call site would
// not show up until the chrome drew wrong.
function eachBlock(
  state: EditorView["state"],
  cb: (b: { from: number; to: number; lang: string | null; asks: boolean; closed: boolean; norun: boolean }) => void,
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
        norun: noRun(info.attrs),
      });
    },
  });
}

// --- Running ---------------------------------------------------------------

// A run id is a per-page nonce plus a counter, unique across every page a
// server is serving. The pool keys its overflow shells and its stashed resizes
// by run id and files each run under the client that asked (bun/inlinePool.ts),
// so two pages minting the same id would drive each other's shells. Two pages
// means a Mac and a phone on one server, and also this page before and after a
// reload, whose runs keep executing until the claim collects them. A clock
// cannot do this job: two pages opened in the same millisecond both start at 1.
const PAGE = Math.random().toString(36).slice(2, 8);
let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `web-${PAGE}-${idCounter}`;
}

// Whether one of this block's own runs is still going. Inline concurrency is
// per block, not per note: a run that lands on a busy note shell gets a fresh
// overflow shell (bun/inlinePool.ts). Within one block, addRun replaces any
// earlier run anchored inside it, and replacing a live run's panel would leave
// its process running with nothing on screen to show or stop it. So one live
// run per block, and re-running waits for the current one or dismisses it.
//
// An "unknown" run counts, because it may still be executing on the machine
// that went away. Starting a second one is the double-run this gate prevents.
// The block frees up when the reconnect settles which it was (editor/bridge.ts
// reconcileRuns).
export function isBlockRunning(state: EditorState, from: number, to: number): boolean {
  const end = state.doc.lineAt(Math.min(to, state.doc.length)).to;
  return state
    .field(runsField)
    .some((r) => (r.state === "running" || r.state === "unknown") && r.pos >= from && r.pos <= end);
}

// Whether `pos` sits in a block the run verbs would accept: a fenced block
// whose language is runnable, whose closing fence is present, and which is not
// marked `norun`. The editor's context menu asks before offering Run Block
// Inline (interactions.md §11): an unterminated fence (§4c) and a marked one
// (§4e) get no run entry rather than one that answers with a notice.
export function runnableBlockAt(state: EditorState, pos: number): boolean {
  const block = blockAt(state, pos);
  return !!block && block.closed && !block.norun && isRunnable(block.lang);
}

/**
 * Whether this client has given up on the machine the note lives on
 * (remote.md §7).
 *
 * A run cannot report its own failure. The request returns nothing and the
 * panel waits for output to arrive on its own, so a run asked for at a server
 * this client has stopped reaching leaves a panel reading "Running" for as
 * long as the note stays open. Predicting the failure is the only way to
 * report it, which makes this the app's only such gate: every other verb sends
 * the request and shows what came back (interactions.md §4d).
 *
 * The gate is on "lost", not on "reconnecting". Mid-ladder a request is held
 * and replayed when the wire comes back (shared/transport.ts), so a run asked
 * for then really does start, seconds late. If the ladder runs out instead,
 * the `lost` that ends it marks the panel unknown on the way past
 * (setRunsLink). Gating the ladder would refuse a run that was going to work.
 */
function linkDown(): boolean {
  return linkState().state === "lost";
}

// Whether a block can be sent to `destination` right now. The terminal drawer
// is one serial shell per note, and a block sent while it is busy queues
// invisibly, so that gate is note-wide. Inline runs gate per block (above).
// Neither gate reaches across notes: runs live in the editor, which is per
// note, and terminal busy is keyed by the note's session.
export function canRun(view: EditorView, block: { from: number; to: number }, destination: RunDestination): boolean {
  if (linkDown()) return false;
  return destination === "terminal"
    ? !isTerminalBusy(view.state.facet(sessionIdFacet))
    : !isBlockRunning(view.state, block.from, block.to);
}

// Whether this editor's note is locked: its frontmatter carries the crypto
// header. The doc holds decrypted plaintext, but the note's contract still
// applies. Reads the head of the document only, like every frontmatter
// question, so it stays cheap to ask often.
function noteLocked(state: EditorState): boolean {
  return parseFrontmatter(state.sliceDoc(0, Math.min(4096, state.doc.length))).params.locked !== null;
}

// Whether this note declares `confirm: true`. Every runnable block then asks
// first, unless its own fence says otherwise. Same cheap head read.
function noteConfirms(state: EditorState): boolean {
  return parseFrontmatter(state.sliceDoc(0, Math.min(4096, state.doc.length))).params.confirm;
}

export function runBlock(view: EditorView, pos: number, destination: RunDestination): boolean {
  const block = blockAt(view.state, pos);
  if (!block || !isRunnable(block.lang)) return false;
  // An unterminated fence has no agreed end, so there is nothing to run
  // (interactions.md §4c). Lezer ends the node on the last body line, and
  // running that guess can send an empty body to a shell that then exits 0
  // having run nothing. The buttons are absent here (rebuild), so only the
  // chord and the palette reach this. They answer with a notice rather than
  // returning false, because a key that does nothing reads as broken.
  if (!block.closed) {
    notifyUser(BLOCK_UNCLOSED);
    return true;
  }
  // A fence marked `norun` is not to be run from this note (interactions.md
  // §4e). The buttons are absent, and the chord and the palette answer with a
  // notice, the same shape as the unclosed case above.
  if (block.norun) {
    notifyUser(BLOCK_NORUN);
    return true;
  }
  // A ```prompt fence pipes its body to the agent CLI, so in a locked note it
  // does not run, to either destination (locking.md §8: the send-direction
  // half of the no-agents invariant, which Bun re-validates behind this UI
  // check). The chord answers with the notice strip and returns true, so it
  // reads as understood and refused rather than unclaimed. Other languages
  // stay runnable: a locked ops note's commands are the user's own compute.
  if (block.lang === "prompt" && noteLocked(view.state)) {
    notifyUser(PROMPT_SEALED);
    return true;
  }
  // Checked before canRun rather than inside it, for the same reason the
  // unclosed fence is: canRun refuses silently and the chord must not. A run
  // offered at a machine that cannot be reached needs a refusal the user can
  // read (interactions.md §4d).
  if (linkDown()) {
    notifyUser(runOffline());
    return true;
  }
  // Checked here rather than only on the buttons, so the keymap and the
  // palette follow the same rule. A disabled-looking button beside a live
  // ⌘↩ would only move the invisible queue somewhere else.
  if (!canRun(view, block, destination)) return false;

  // This note's id, so the run reaches this note's own shell (see bridge.ts).
  const sessionId = view.state.facet(sessionIdFacet);
  const hosts = declaredHosts(view.state);

  if (destination === "terminal") {
    // Output goes to the drawer, so no inline panel is created here. The
    // declared host list is sent un-picked: the drawer is one shell with one
    // host for its whole life, so App decides whether a picker applies at all
    // (only when this paste is what spawns the shell). The confirm marker is
    // sent for the same reason. The dialog comes after the machine is
    // settled, and App is where that happens.
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

  // More than one declared host: nothing runs until the user names the
  // machine, on every run (interactions.md §4a). A prod/staging list must not
  // run on a remembered default, so the remembered pick only preselects a row.
  //
  // The confirm dialog comes after the pick, never before, so the question can
  // name the machine it is about. Cancelling the dialog spends the pick and
  // runs nothing, and the next run asks again.
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

// Show the confirmation when the block asks for one, then run. The only place
// an inline run is gated, so the chord, the palette, and the run button cannot
// diverge into an unconfirmed path (interactions.md §4b). The terminal
// destination is gated in App, after its own host question settles.
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

// Where the host picker opens: at the block's control corner. A click on the
// run button is already there, and a chord comes from the block the caret is
// in.
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
  // Re-checked because the answer arrives asynchronously. An earlier run of
  // this block may have started (double ⌘↵) while the picker or the
  // confirmation was open.
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
  // Hand the keyboard to the run once it starts printing, so a command that
  // asks for something (a sudo password, a y/N) is answered by typing rather
  // than into the note. claimFocus takes focus only if this editor still has
  // it and the caret has not moved. Skipped where the keyboard is on screen:
  // that test is always true on a phone (interactions.md §6a).
  if (!softKeyboard()) {
    const head = view.state.selection.main.head;
    getInlineTerm(id)?.claimFocus(() => view.hasFocus && view.state.selection.main.head === head);
  }
  return true;
}

// --- Output widget ---------------------------------------------------------
//
// The output panel is a block widget, the one kind that reserves vertical
// space and pushes the following text down. It renders the run through an
// xterm.js terminal pooled by run id (inlineTerm.ts), because the widget is
// rebuilt on every change and a terminal has to persist and take bytes
// incrementally.
//
// The widget only re-parents that pooled DOM. handleRunEvent writes the bytes
// and updates the header, so `eq` compares id alone and CodeMirror keeps the
// terminal mounted across state and duration changes.
//
// Full-screen and interactive programs (vim, claude, a REPL) render and are
// driven inline; the block's terminal button is still the way to the full
// drawer. The dismiss and copy buttons live in the overlay layer
// (`overlayPlugin`), outside the editable surface, where the browser honours
// `cursor: pointer`.

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

// Why a run button is off, spelled out on the button itself. A gray button
// with no reason on it leaves the user with "nothing happened when I clicked".
const INLINE_BUSY = "This block is still running";
const TERM_BUSY = "This note's terminal is busy";
// Why a prompt fence does not run in a locked note. One sentence for both the
// button tooltip and the chord's notice (bridge notifyUser), so the two cannot
// drift.
const PROMPT_SEALED =
  "Prompt blocks can't be run in locked notes. AI agents aren't allowed to read locked notes.";
// The chord's answer for a fence with no closing line. Only the chord and the
// palette can reach it: an unclosed block never draws the buttons.
const BLOCK_UNCLOSED = "This code block has no closing fence, so there is nothing to run yet.";
// The chord's answer for a fence marked `norun`. Says what the mark is for,
// because the person pressing ⌘↩ on it is usually the reader of a note that
// someone else (the manual, say) marked, not its author.
const BLOCK_NORUN = "This block is marked norun: it is here to read or copy, not to run from this note.";
// The button tooltip and the chord's notice for a machine that cannot be
// reached (linkDown). It names the machine, because a client with several
// servers needs to know which one went. The connection bar shows that same
// name, so a tooltip saying "the server" would leave the reader to match the
// two up.
const runOffline = (): string =>
  `Not connected to ${activeConnection().name}, so there is nowhere to run this.`;

// Gray out a run button while its shell cannot take a block. The native
// `disabled` stops the mousedown, so the click cannot queue anything and there
// is no second code path to keep in step with the CSS.
//
// `hostHint` names the target machine where no picker will interrupt: a
// single-host note runs on that host silently, so the tooltip is the one place
// that says so before the click. `asks` says the click opens the confirmation
// rather than running (interactions.md §4b). The fence's own `confirm` word
// discloses that in the note; this is the disclosure on the button.
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
// All clickable chrome (run, terminal and copy per block, dismiss per output)
// is drawn here, in a layer parented to <body> rather than to the editor. It is
// a fixed box pinned over the editor's rect, re-measured on edit, geometry
// change and scroll, so each control stays on its block. Outside `.cm-editor`
// the buttons honour `cursor: pointer`; inside it WebKit forces the text I-beam
// whatever the CSS says.
//
// Known gap: the dismiss button sits over the output panel, a block widget
// inside `.cm-editor`, and WebKit's cursor hit-test reaches the panel through
// the overlay, so that one button still shows the I-beam. The run and copy
// controls sit over plain lines and render the pointer correctly. Unsolved.

interface ControlSpec {
  from: number;
  lang: string | null;
  top: number;
  right: number;
  caret: boolean;
  // Two flags, one per destination: the shells are independent, so a block
  // running inline is still free to go to the drawer. runBusy is per block as
  // well, since concurrent inline runs each get their own shell. Only the
  // block's own live run gates it.
  runBusy: boolean;
  termBusy: boolean;
  // Whether the fence is terminated. An unclosed one gets no run pair at all
  // (rebuild), so `closed` rides in the signature below. The buttons appear as
  // soon as the closing fence is typed.
  closed: boolean;
  // Whether the fence is marked `norun`. It gets no run pair either, and rides
  // in the signature for the same reason: the pair has to go as soon as the
  // word is typed.
  norun: boolean;
  // Whether a click opens the confirmation first. The tooltip says so next to
  // the host hint, so where a run will happen and whether it stops to ask both
  // read before the click.
  asks: boolean;
}
interface CloseSpec {
  id: string;
  top: number;
  right: number;
  // The header's measured height, given to the wrapper so flexbox centres the
  // pair in it. Both sizes vary: the header is 24 points on a pointer client
  // and 48 on a touch one, and the buttons inside are 22 or 44 (index.css).
  // Computing an offset here would have to know both.
  height: number;
}
// The frontmatter profile's edit button, anchored just past the value's last
// glyph. It lives in this layer rather than in the text for the reason every
// other button does: outside `.cm-editor` it gets a real pointer cursor and a
// visible click target. The in-text ⌘-click (editor/frontmatter.ts) stays as
// the accelerator, and WebKit pins the I-beam over it.
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
  // for a single declared host) or that it will ask ("choose machine…").
  // Note-level rather than per block, since the frontmatter declares once.
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
    offLink: () => void;

    constructor(readonly view: EditorView) {
      this.layer = document.createElement("div");
      this.layer.className = "ledge-overlay";
      // Parent to <body> rather than to the editor. WebKit forces the text
      // I-beam over any element inside the `.cm-editor` editing context,
      // whatever its `cursor`, `contenteditable`, or pointer-events; only
      // elements outside that subtree honour `cursor: pointer`. The layer is a
      // fixed box re-pinned over the editor's rect on every measure, so the
      // buttons still track their blocks.
      document.body.appendChild(this.layer);

      this.onMove = (e) => this.updateHover(e.clientX, e.clientY);
      this.onScroll = () => this.schedule();
      // Cmd+C over a selection inside an output panel. The panel is a
      // contenteditable=false widget whose text the WebView's native copy does
      // not put on the clipboard, so copy it explicitly. Capture phase, ahead
      // of CodeMirror's own key handling, and scoped to this editor's panels so
      // that among pooled editors only the one holding the selection acts.
      this.onKeyDown = (e) => this.handleCopyKey(e);
      // The editor's own update cycle does not see the terminal drawer's shell
      // go busy or idle (no doc, geometry, or run-state change), so this
      // subscription tells the chrome. Every editor subscribes, and read()
      // filters by its own note's session.
      this.offBusy = onTerminalBusyChange(() => this.schedule());
      // The same for the connection: a dropped wire grays every run button in
      // the note, and the editor's update cycle does not see that either. Kept
      // apart from offBusy because the two unsubscribe separately.
      this.offLink = subscribeConnections(() => this.schedule());
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
      // A pooled editor for an inactive tab is detached from the DOM and kept
      // alive off-screen (workspace/editorPool.ts). Measuring it would strand
      // the last set of floating buttons on screen, so collapse the overlay
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

      // The card's right border, measured rather than assumed. A block's card
      // is a line decoration, so it spans `.cm-content`'s content box, and that
      // box narrows by the scrollbar's width once a note is long enough to
      // scroll. Deriving the inset from the editor's outer rect instead would
      // leave the buttons where the card used to end, past its edge.
      const content = view.contentDOM.getBoundingClientRect();
      const padRight = parseFloat(getComputedStyle(view.contentDOM).paddingRight) || 0;
      const cardInset = base.right - (content.right - padRight);

      // The drawer shell is per note, so its busy state is the same for every
      // block in this editor. Inline runs are per block (each gets its own
      // shell), so that gate is measured inside the loop.
      const termBusy = isTerminalBusy(view.state.facet(sessionIdFacet));

      const controls: ControlSpec[] = [];
      eachBlock(view.state, ({ from, to, lang, asks, closed, norun }) => {
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
          norun,
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
        // Measured rather than assumed: the header is 24 points on a pointer
        // client and 48 on a touch one, where it holds 44-point controls
        // (index.css, interactions.md §6a). The wrapper gets that height and
        // sits on the panel's first inner pixel, which leaves the centring to
        // the CSS that also sets the button sizes.
        const headerH =
          panel.querySelector(".ledge-output-header")?.getBoundingClientRect().height ?? 24;
        closes.push({
          id: run.id,
          top: r.top - base.top + 1,
          height: headerH,
          // Column-aligned with the block's own controls above. Those sit at
          // `cardInset + 10` inside a group with 2px padding and a 1px border,
          // so their glyphs land 13px in from the card edge. This wrapper has
          // neither padding nor border, and the panel is flush to the card, so
          // 13 puts the two clusters in one column.
          right: cardInset + 13,
        });
      }

      // The frontmatter profile's edit button (see ProfileSpec). Same reveal
      // grammar as the block controls: visible while the pointer or the caret
      // is in the block. Centered on the line's glyph box, because the compact
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
        controls.map((c) => `${c.from}:${c.lang}:${c.closed ? "closed" : "open"}:${c.norun ? "norun" : "runs"}`).join("|") +
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
      // A prompt fence in a locked note gets the busy-button grammar on every
      // write pass: disabled, with the reason as its tooltip (setBusy, above).
      // Disabled rather than removed, so the reason reads beside the live pair
      // on an `sh` fence in the same note. runBlock refuses the chords with the
      // same sentence, and Bun re-validates behind both.
      const sealedNote = noteLocked(this.view.state);
      // Asked once for the whole layer: it is one fact about the connection,
      // not a fact about any block.
      const offline = linkDown();
      const why = offline ? runOffline() : "";
      for (const c of m.controls) {
        const el = this.layer.querySelector<HTMLElement>(`.ledge-ctl-group[data-block="${c.from}"]`);
        if (!el) continue;
        el.style.top = `${c.top}px`;
        el.style.right = `${c.right}px`;
        el.classList.toggle("caret", c.caret);
        const sealed = c.lang === "prompt" && sealedNote;
        // Sealed outranks offline: a prompt fence in a locked note will not run
        // when the wire comes back either, and the permanent reason is the more
        // useful one to read.
        setBusy(el.querySelector('[data-act="run"]'), c.runBusy || sealed || offline, "block.runInline", sealed ? PROMPT_SEALED : why || INLINE_BUSY, m.hostHint, c.asks);
        setBusy(el.querySelector('[data-act="term"]'), c.termBusy || sealed || offline, "block.runInTerminal", sealed ? PROMPT_SEALED : why || TERM_BUSY, m.hostHint, c.asks);
      }
      for (const c of m.closes) {
        const el = this.layer.querySelector<HTMLElement>(`.ledge-close-wrap[data-close="${c.id}"]`);
        if (!el) continue;
        el.style.top = `${c.top}px`;
        el.style.right = `${c.right}px`;
        el.style.height = `${c.height}px`;
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
        // Every runnable fence gets its run pair, a prompt fence in a locked
        // note included: the setBusy pass right after this rebuild disables
        // that pair with the sealed reason as its tooltip, so the buttons are
        // born gray and never live.
        //
        // Three cases get no pair at all. A fence marked `norun` and an
        // unclosed fence are each absent rather than disabled for their own
        // reason, and each pair returns when the mark is deleted or the fence
        // is closed (interactions.md §4e and §4c). A client that does not run
        // blocks draws no ▶, and one with no drawer draws no terminal button:
        // those are permanent limits, not conditions that end (ios.md §8,
        // lib/shell.ts). The copy button below stays: copying is not running.
        //
        // The two client flags are read separately because the pair is not a
        // unit: a phone runs blocks and has no drawer, so there the ▶ is the
        // whole group.
        const runnable = isRunnable(c.lang) && c.closed && !c.norun;
        if (runnable && runsBlocks()) {
          const runBtn = iconButton(PLAY_ICON, tooltip("block.runInline"), (e) => {
            e.preventDefault();
            runBlock(this.view, c.from, "inline");
          });
          runBtn.dataset.act = "run";
          group.appendChild(runBtn);
        }
        if (runnable && runsBlocks() && hasTerminal()) {
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
            // Interrupt a still-running block on the way out: with the panel
            // gone, nothing on screen shows its process or stops it. The cancel
            // names the run id, so it reaches this run's shell and no other
            // block's. The state check keeps dismissing an old finished panel
            // from touching anything.
            //
            // An "unknown" run is dismissible too. Its cancel goes nowhere
            // while the wire is down, but dropping the panel drops the id from
            // the claim this client makes when it comes back, and the server
            // interrupts every run the claim leaves out (bridge.ts
            // reconcileRuns).
            const run = this.view.state.field(runsField).find((r) => r.id === c.id);
            if (run?.state === "running" || run?.state === "unknown") cancelRun(this.view.state.facet(sessionIdFacet), c.id);
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
      // Keep the hovered block's controls visible across a rebuild.
      if (this.hovered != null) {
        const g = this.layer.querySelector<HTMLElement>(`.ledge-ctl-group[data-block="${this.hovered}"]`);
        g?.classList.add("hover");
      }
    }

    destroy() {
      this.offBusy();
      this.offLink();
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
// A block with a run attached closes differently. Its closing fence must leave
// the card open: no bottom border, no bottom radius, and the seam left to the
// panel header's top border. That fuses the output panel to the card
// (index.css, `.ledge-code-attached + .ledge-output`), so the two read as one
// object rather than a micro-terminal parked underneath. The CSS pairs on the
// sibling combinator, so it cannot drift from the class emitted here. A panel
// whose block was deleted out from under it finds no `.ledge-code-attached`
// before it and keeps the free-standing styling.
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
  // Drop events for runs this view did not start. Every open note's editor
  // registers a sink (workspace/editorPool.ts), including the ones detached
  // off-screen for a background tab, and only the view that dispatched addRun
  // has the id in its runsField.
  //
  // The state effects below already no-op for a foreign id, but the inline
  // terminal pool is keyed by run id alone and so is reachable from any view.
  // Without this check, one `echo hi` would be written into its panel once per
  // open note.
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

/**
 * The runs this editor still shows as going: what the client claims when it
 * lines itself up with the server (bridge.ts reconcileRuns).
 *
 * Panels are the only record a run has on this side. An editor destroyed by a
 * relock, a tab that closed, a page that reloaded all take theirs with them,
 * and a run this returns nothing for is one nobody here can see or stop.
 *
 * "unknown" is in the answer alongside "running" because the outage this
 * question follows is what made those runs unknown. A filter on "running"
 * alone would name none of them, and the server interrupts every run a claim
 * leaves out.
 */
export function runningRunIds(state: EditorState): string[] {
  return state
    .field(runsField)
    .filter((r) => r.state === "running" || r.state === "unknown")
    .map((r) => r.id);
}

/**
 * The machine these runs are on became unreachable, or reachable again
 * (mainview/boot.tsx connectionState).
 *
 * Down, a run that was going becomes "unknown". Nothing about the run itself
 * changed, which is why this is not the `failAllRuns` that used to be here: a
 * panel that answers a dropped wire by saying the run ended invents an ending,
 * and that run may be four minutes into a deploy. The panel keeps its output,
 * keeps its block gated, and says that it does not know.
 *
 * Up, every unknown run goes back to "running", and reconcileRuns settles a
 * beat later which of them that was true of. Until the server replies, a run
 * that survived the outage and a run that died in it look identical from here,
 * and "running" is the guess that needs no undoing when it is right.
 */
export function setRunsLink(view: EditorView, up: boolean): void {
  const was = up ? "unknown" : "running";
  const now = up ? "running" : "unknown";
  for (const r of view.state.field(runsField)) {
    if (r.state !== was) continue;
    view.dispatch({ effects: setRunState.of({ id: r.id, state: now, exitCode: null }) });
    // Not frozen in either direction: freezing is for a run that has finished,
    // and this run has not been seen to finish.
    const updated = view.state.field(runsField).find((x) => x.id === r.id);
    if (updated) getInlineTerm(r.id)?.setState(updated);
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
    // The chords, gated by the same client facts as the buttons above
    // (lib/shell.ts). A client that does not run blocks must not run one from a
    // paired hardware keyboard either. Gated one chord at a time, because a
    // client can run blocks and still have nowhere to put one in a terminal.
    keymap.of([
      ...(runsBlocks()
        ? [
            {
              key: keyOf("block.runInline")!,
              run: (view: EditorView) =>
                runBlock(view, view.state.selection.main.head, "inline"),
            },
          ]
        : []),
      ...(runsBlocks() && hasTerminal()
        ? [
            {
              key: keyOf("block.runInTerminal")!,
              run: (view: EditorView) =>
                runBlock(view, view.state.selection.main.head, "terminal"),
            },
          ]
        : []),
    ]),
  ];
}
