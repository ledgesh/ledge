// The inline-terminal pool.
//
// Each inline run renders into a real xterm.js instance instead of an
// ANSI-stripped <pre>, so colour, cursor addressing, spinners, and in-place
// redraws (git paging, claude, python REPLs) look right inline instead of
// collapsing into run-together text. A CodeMirror block widget is rebuilt on
// every change, but an xterm must persist and be written to incrementally, so
// the terminal lives here keyed by run id (mirroring the editor pool) and the
// OutputWidget only re-parents the pooled DOM. The widget owns lifecycle
// (create on first render, dispose when the run is removed); this module owns
// the terminal.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { RunInfo } from "./blocks";
import { copyText, readClipboard } from "../lib/clipboard";
import { settings } from "../lib/settings";
import { isDarkAppearance, onAppearanceChange } from "../lib/theme";

// The tallest an inline run gets. 24 rows (~the classic terminal height) keeps the
// panel about as tall as the old <pre> cap; past that the run scrolls.
//
// A run grows into this rather than starting there. Opening at the full 24 rows
// would punch a screen-high hole in the note for every `echo`, and then collapse
// it when the command finished, which is a lot of movement to say "two lines".
// The exception is a full-screen program (vim, htop, a pager): it asks the tty how
// big it is and draws itself to fit, so it gets the whole grid up front and keeps
// it (see the alternate-buffer pin below).
const RUN_ROWS = 24;
const FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";

// How long after an Escape a second one still reads as "get me out of here".
const ESC_EXIT_MS = 600;

// xterm paints its own opaque background, so these are the one place the card's
// lower half cannot use `--code-panel-bg`: they are that variable pre-composited
// over the note background (0.06 white over #0a0a0b; 0.045 black over white), so
// the terminal zone sits flush with the code above it in the fused card instead
// of reading as a lighter box dropped inside one.
function xtermTheme(dark: boolean) {
  return dark
    ? { background: "#1a1a1c", foreground: "#e8e8ea", cursor: "#e8e8ea", selectionBackground: "#3a3a40" }
    : { background: "#f3f3f3", foreground: "#1d1d1f", cursor: "#1d1d1f", selectionBackground: "#cfe0ff" };
}

// Callbacks the widget wires so the terminal can reach the note's shell and the
// editor. `onResize` reports the live grid so the shell's winsize tracks it;
// `onInput` forwards keystrokes from the running block to the note's inline shell;
// `onHeightChange` asks CodeMirror to re-measure when the panel's height changes
// out of band (freeze/shrink); `onFocusEditor` returns focus to the prose editor
// when the run ends, is dismissed, or the user asks to leave it.
export interface InlineTermOptions {
  onResize?: (cols: number, rows: number) => void;
  onInput?: (data: string) => void;
  onHeightChange?: () => void;
  onFocusEditor?: () => void;
}

export class InlineTerm {
  readonly wrap: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly waiting: HTMLDivElement;
  private readonly host: HTMLDivElement;
  private readonly header: HTMLDivElement;
  private readonly dot: HTMLSpanElement;
  private readonly status: HTMLSpanElement;
  private readonly hostChip: HTMLSpanElement;
  private readonly focusHint: HTMLSpanElement;
  private readonly tapHint: HTMLButtonElement;
  private readonly exitKey: HTMLSpanElement;
  private readonly leaveBtn: HTMLButtonElement;
  private readonly duration: HTMLSpanElement;
  private readonly term: Terminal;
  private readonly fit: FitAddon;
  private readonly ro: ResizeObserver;
  private readonly offAppearance: () => void;
  private shown = false;
  private disposed = false;
  /** A full-screen program took the grid; hold it at RUN_ROWS and stop tracking. */
  private pinned = false;
  /** True while the command is still running (drives grid size / step-2 input). */
  live = true;
  /** A run's pending claim on the keyboard; see claimFocus(). */
  private claim: (() => boolean) | null = null;
  /** When the last Escape landed, for the leave-the-terminal double tap. */
  private lastEscape = 0;

  constructor(
    private readonly id: string,
    private readonly opts: InlineTermOptions,
  ) {
    this.wrap = document.createElement("div");
    // `live` is on the class as well as in the field below, because the header
    // draws a state from it that also depends on focus (the tap hint), and a
    // class is the only form :focus-within can be combined with.
    this.wrap.className = "ledge-output ledge-term-live";
    this.wrap.contentEditable = "false";
    this.wrap.dataset.ledgeRun = id;

    this.header = document.createElement("div");
    this.header.className = "ledge-output-header";
    this.dot = document.createElement("span");
    this.status = document.createElement("span");
    this.status.className = "ledge-status";
    // Where this run executes, when that is not this machine: with several
    // machines in play, output that does not say whose it is invites misreads.
    this.hostChip = document.createElement("span");
    this.hostChip.className = "ledge-host-chip";
    this.hostChip.style.display = "none";
    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    // Shown (by CSS) only while the panel holds focus. Silent focus movement is
    // the whole hazard being traded here: keystrokes that used to land in the
    // note now land in a program, so the panel has to say so, and say how to
    // get back out (the Escape grammar below).
    this.focusHint = document.createElement("span");
    this.focusHint.className = "ledge-focus-hint";
    this.focusHint.textContent = "typing here";
    // The other half of that sentence, and only a touch client has it: there,
    // a run does NOT take the keyboard (editor/blocks.ts), so a program asking
    // for a password is waiting on a tap nothing else would announce. Shown
    // while the run is live and the keyboard is elsewhere; the line above
    // replaces it the moment the panel has it.
    //
    // A button and not a line of text, though it started as one: words reading
    // "tap to type" next to a terminal are aimed at as well as read, and a
    // finger that lands on them has to be right. Tapping the output still
    // does the same thing, and is what most people do.
    this.tapHint = document.createElement("button");
    this.tapHint.className = "ledge-tap-hint";
    this.tapHint.textContent = "Tap to type";
    // mousedown and preventDefault, like the button below: focus must not rest
    // on the button on its way to the terminal. Taking it here, inside the
    // gesture's own handler, is also what lets iOS raise the keyboard for it.
    this.tapHint.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.focusTerm();
    });
    // The way out, said twice, because the two kinds of client have nothing in
    // common here: one names the keys, the other IS the exit. Both are built
    // and only one is ever shown — the CSS picks by `@media (hover: …)`, so
    // there is no live media query to re-read and no state to keep in step.
    this.exitKey = document.createElement("span");
    this.exitKey.className = "ledge-focus-key";
    // A phone has neither ⌘Escape nor an Escape to press twice, and the way
    // out a Mac never needs — tapping the prose — is exactly what a full-screen
    // program takes away: pinned to 24 rows with the keyboard up, the panel can
    // be the whole screen (interactions.md §6a). So the touch client gets a
    // control, and it is the analogue of ⌘Escape rather than of the double tap:
    // a button is the one form no program can swallow, so it needs no `pinned`
    // case and never changes its label.
    //
    // "Back to note" and not "Done": the run is not done, and must not look
    // like it is being stopped. Leaving is a focus move; the ✕ beside it is the
    // one that interrupts.
    this.leaveBtn = document.createElement("button");
    this.leaveBtn.className = "ledge-term-leave";
    this.leaveBtn.textContent = "Back to note";
    // mousedown, like every other button in the editor's chrome (blocks.ts
    // iconButton), and preventDefault so focus never lands on the button on the
    // way past. On a phone that is not a nicety: focus moving textarea → button
    // → editor puts the software keyboard away and brings it back, and the
    // point of leaving is to carry on typing.
    this.leaveBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.leave();
    });
    this.setFocusHint();
    this.duration = document.createElement("span");
    this.duration.className = "ledge-duration";
    // Reserved for the copy and dismiss buttons, which are drawn in the body
    // overlay rather than in here (blocks.ts) and so take no space of their
    // own. Wider on touch, where what sits to the left of them is a 44-point
    // control and not a line of 10px text: the gap is the separation between
    // "give the keyboard back" and "interrupt this run".
    const gap = document.createElement("span");
    gap.className = "ledge-term-gap";
    this.header.append(
      this.dot,
      this.status,
      this.hostChip,
      spacer,
      this.tapHint,
      this.focusHint,
      this.exitKey,
      this.leaveBtn,
      this.duration,
      gap,
    );
    this.wrap.appendChild(this.header);

    this.body = document.createElement("div");
    this.body.className = "ledge-term-body";
    // Until the first byte arrives the panel is a header over nothing, which
    // reads as a hang — and some runs are honestly silent for a long time
    // (`claude -p` says nothing until it is done). Name the state instead.
    // CSS keeps this invisible for the first beat, so quick commands never
    // flash it; removed on the first byte (write) or at freeze.
    this.waiting = document.createElement("div");
    this.waiting.className = "ledge-term-waiting";
    this.waiting.textContent = "running, no output yet";
    this.body.appendChild(this.waiting);
    this.host = document.createElement("div");
    // Present but not shown until the first byte. Not `display: none`, which is
    // what this was: an unlaid-out element has no width, so the fit below bailed
    // and no winsize ever reached the shell before the command ran — it executed
    // believing the pty's default width, and anything that lays out to COLUMNS
    // (zsh's own prompt padding included) got it wrong. Zero-height and clipped
    // keeps the width measurable while still not opening an empty terminal row
    // under the placeholder.
    this.host.className = "ledge-term-host ledge-term-unshown";
    this.body.appendChild(this.host);
    this.wrap.appendChild(this.body);

    this.term = new Terminal({
      fontFamily: FONT,
      fontSize: settings().terminal.fontSize,
      // Start at one row and grow with the output. xterm's default is 24, and
      // liveRows() never shrinks a running grid, so the starting size is the
      // smallest the panel can ever be.
      rows: 1,
      // And at the narrowest grid xterm allows, for a sharper version of the
      // same reason: the panel has no width of its own. It fills the editor's
      // content, and the editor's content is as wide as its widest thing — so
      // an xterm that opens at the default 80 columns PUSHES the content out to
      // 80 columns, and the re-fit then measures that and agrees with it. A
      // stable wrong answer, invisible on a Mac (605 points inside a 1005-point
      // editor) and the whole panel on a phone: 605 inside 370, so the note
      // scrolled sideways and the run's own header ran off the screen. Opening
      // at 2 leaves nothing to push with, and the first re-fit grows the grid to
      // whatever the editor actually is.
      cols: 2,
      theme: xtermTheme(isDarkAppearance()),
      cursorBlink: false,
      allowProposedApi: true,
      // Extra scrollback so long output stays reachable once the grid shrinks.
      scrollback: 5000,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.host);

    // Keystrokes / pasted text -> the note's inline shell, but only while the
    // block's command is running: a frozen terminal is read-only output (its text
    // stays selectable for copy).
    this.term.onData((data) => {
      if (this.live) this.opts.onInput?.(data);
    });

    // Clipboard, matching a normal terminal (and the drawer): xterm draws its own
    // selection and the WebView's native copy/paste do not fire reliably, so Cmd+C
    // / Cmd+V / Cmd+A go through the Bun clipboard. Ctrl+C is left alone so it still
    // sends SIGINT to an inline program. Returning false consumes the key so the
    // unhandled Cmd chord does not ring the system alert.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const cmd = e.metaKey && !e.ctrlKey && !e.altKey;
      // The way back to the prose, for a run that took focus on its own (see
      // claimFocus). Deliberately never WITHHELD from the program: the bare
      // form acts on the second Escape, so the first one has already gone
      // through, and a full-screen program keeps both (⌘Escape is its exit) —
      // vim's habitual double tap must not eject you from vim.
      if (e.key === "Escape") {
        const since = Date.now() - this.lastEscape;
        this.lastEscape = cmd ? 0 : Date.now();
        if (!escapeLeaves({ meta: cmd, pinned: this.pinned, sinceLastEscMs: since })) return true;
        if (cmd) e.preventDefault();
        this.leave();
        return !cmd;
      }
      if (cmd && (e.key === "c" || e.key === "C") && this.term.hasSelection()) {
        e.preventDefault();
        copyText(this.term.getSelection());
        return false;
      }
      if (cmd && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        if (this.live) void readClipboard().then((text) => text && this.term.paste(text));
        return false;
      }
      if (cmd && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        this.term.selectAll();
        return false;
      }
      return true;
    });

    // A program switching to the alternate buffer is a full-screen one starting up
    // (vim, htop, less all do this before they draw). Growing a row at a time under
    // it is wrong: it sized itself to the tty, so give it the full grid at once and
    // stop tracking content, which for a screen it redraws in place means nothing.
    this.term.buffer.onBufferChange(() => {
      if (this.disposed || this.term.buffer.active.type !== "alternate") return;
      this.pinned = true;
      this.setFocusHint();
      this.refit();
      this.opts.onHeightChange?.();
    });

    // A "system" appearance still moves under a frozen panel (lib/theme.ts);
    // a pinned theme simply never fires this.
    this.offAppearance = onAppearanceChange((a) => (this.term.options.theme = xtermTheme(a === "dark")));

    // The panel width follows the editor content width; re-fit cols when it
    // changes (pane resize, terminal drawer opening, window resize).
    this.ro = new ResizeObserver(() => this.refit());
    this.ro.observe(this.host);
  }

  // Sync the header chrome (dot colour, status text, duration) from the latest
  // run info. Called imperatively so the persistent terminal never has to be
  // rebuilt to reflect a state change.
  setState(run: RunInfo): void {
    this.dot.className = `ledge-dot ledge-dot-${run.state}`;
    this.status.textContent = statusText(run);
    // "local" is the reserved frontmatter word, not a place worth labeling.
    const remote = run.host && run.host !== "local" ? run.host : null;
    this.hostChip.textContent = remote ?? "";
    this.hostChip.style.display = remote ? "" : "none";
    this.duration.textContent = run.durationMs != null ? formatDuration(run.durationMs) : "";
  }

  // A run asks for the keyboard. The claim is not honored until the terminal is
  // actually on screen (an unrevealed host cannot take focus anyway), which is
  // also the moment worth stealing focus AT: the first byte is where a
  // "Password:" or a "[y/N]" appears, and until then there is nothing to answer.
  //
  // `stillWanted` is the staleness test, evaluated at that moment rather than
  // now: a claim from a run whose user has gone back to typing in the note (or
  // clicked away entirely) lapses instead of yanking focus mid-sentence, which
  // is the one thing this feature must not do.
  claimFocus(stillWanted: () => boolean): void {
    if (this.disposed || !this.live) return;
    this.claim = stillWanted;
    if (this.shown) this.honorClaim();
  }

  private honorClaim(): void {
    const claim = this.claim;
    this.claim = null;
    if (!claim || this.disposed || !this.live) return;
    if (!this.host.isConnected || !claim()) return;
    this.focusTerm();
  }

  /** Put the keyboard in the terminal: an honored claim, or a tap on the
   * invitation in the header.
   *
   * preventScroll because the panel is already in view either way — it sits
   * under the block the caret was in, or it is the thing that was just tapped —
   * and without it focusing scrolls the widget to the top of the viewport,
   * moving the note under the user. */
  private focusTerm(): void {
    this.term.textarea?.focus({ preventScroll: true });
  }

  /** Hand the keyboard back to the prose editor (Escape grammar, dismiss, freeze). */
  private leave(): void {
    this.lastEscape = 0;
    this.term.blur();
    this.opts.onFocusEditor?.();
  }

  /** Whether the keyboard is over this run. Public because the pool answers
   * `sendRunKey` with it: one page has many panels and at most one of them is
   * what a key was pressed at. */
  hasFocus(): boolean {
    return this.host.contains(document.activeElement);
  }

  /**
   * One press on the keyboard a RUNNING block needs (ios.md §7, `RUN_KEYS`).
   *
   * Not typed and therefore not xterm's to encode: these arrive as a name from
   * a bar that has no key event behind it, so the bytes are chosen here and
   * handed to the shell the way `onData` hands over what was typed. The one
   * thing that has to be asked of xterm is which cursor-key mode the program
   * put the terminal in, because the answer changes what an arrow IS.
   *
   * `leave` is the member that sends nothing: it is the way back to the note,
   * which on a Mac is ⌘Escape and on a phone has to be a control.
   */
  sendKey(key: RunKey): boolean {
    if (this.disposed) return false;
    if (key === "leave") {
      this.leave();
      return true;
    }
    // A frozen panel is output, not a program: its shell has already gone, and
    // a key sent into it would be typing at nothing.
    if (!this.live) return false;
    this.opts.onInput?.(runKeyBytes(key, this.term.modes.applicationCursorKeysMode));
    return true;
  }

  private setFocusHint(): void {
    this.exitKey.textContent = this.pinned ? "· ⌘esc to exit" : "· esc esc to exit";
  }

  write(bytes: Uint8Array): void {
    if (this.disposed) return;
    if (!this.shown) {
      this.shown = true;
      this.waiting.remove();
      this.host.classList.remove("ledge-term-unshown");
      this.refit();
      this.opts.onHeightChange?.();
      this.honorClaim();
    }
    // Grow on the write's callback, not now: xterm parses on its own queue, so the
    // rows this output needs are not known until it has drained.
    this.term.write(bytes, () => this.grow());
  }

  // Track the grid to the output as it arrives, up to RUN_ROWS. Growth only: a
  // program that clears the screen mid-run must not collapse the panel under it,
  // and freeze() does the one honest shrink at the end.
  private grow(): void {
    if (this.disposed || !this.shown || this.pinned) return;
    // Nothing to do once the grid is full, and this is the hot path for streaming
    // output: bail before measuring, since contentRows() would then be walking
    // scrollback (up to 5000 lines) on every chunk.
    if (this.term.rows >= RUN_ROWS) return;
    const rows = Math.min(this.neededRows(), RUN_ROWS);
    if (rows <= this.term.rows) return;
    this.term.resize(this.term.cols, rows);
    if (this.live) this.opts.onResize?.(this.term.cols, rows);
    this.opts.onHeightChange?.();
  }

  // The command finished: stop tracking the live grid and shrink to the used
  // rows so a short run does not leave a tall blank terminal.
  freeze(): void {
    if (this.disposed) return;
    this.live = false;
    this.wrap.classList.remove("ledge-term-live");
    // A run that is over asks for nothing: a claim that never came due (a
    // silent command that finished before its first byte) dies with it.
    this.claim = null;
    // A run that finished without a byte keeps its header ("Done") and drops
    // the placeholder: "no output yet" would be a lie, and "no output" is
    // what a collapsed body already says.
    this.waiting.remove();
    // The full-screen program that claimed the grid has exited with the block, and
    // its screen went with it, so the pin has nothing left to protect. Cleared here
    // or freeze's shrink would be undone by the next re-fit.
    this.pinned = false;
    this.setFocusHint();
    this.term.options.cursorBlink = false;
    // If the finished terminal held focus (the user was typing into the program),
    // hand focus back to the prose editor so keystrokes do not fall into a now
    // read-only terminal.
    if (this.hasFocus()) this.leave();
    if (!this.shown) return; // no output at all; nothing to render
    // xterm parses writes on its own async queue, so the final output bytes may not
    // be in the buffer yet; the empty write's callback runs once the queue drains,
    // so usedRows() measures the settled buffer.
    this.term.write("", () => {
      if (this.disposed) return;
      const needed = this.neededRows();
      const rows = Math.min(needed, RUN_ROWS);
      if (rows !== this.term.rows) this.term.resize(this.term.cols, rows);
      // Stay where the output left off. A run that fits sizes its grid to hold
      // everything, so this is a no-op for it; a run taller than the grid clamps
      // and keeps its scrollbar, and the end is the half of that output worth
      // landing on — the last thing a build said, the error that stopped it.
      // Rewinding to the top instead makes every long run open on `Line 1` and
      // reads as though it never got past the beginning.
      this.term.scrollToBottom();
      this.wrap.classList.toggle("ledge-term-clamped", needed > RUN_ROWS);
      this.opts.onHeightChange?.();
    });
  }

  // Plain text of the current buffer, for the copy button (xterm renders the
  // colour; the clipboard gets clean text).
  plainText(): string {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    return lines.join("\n");
  }

  dispose(): void {
    if (this.disposed) return;
    // Dismissed (or its block deleted) while it held the keyboard: the DOM about
    // to be torn out is where focus lives, and losing it to <body> would leave
    // the next keystroke going nowhere. Hand it back first.
    const held = this.hasFocus();
    this.disposed = true;
    if (held) this.opts.onFocusEditor?.();
    this.ro.disconnect();
    this.offAppearance();
    this.term.dispose();
  }

  // Rows for a run still in flight: never fewer than it already has, so a re-fit
  // for some unrelated reason (a pane resize) cannot yank the grid out from under
  // a running program.
  private liveRows(): number {
    return liveRows(this.term.rows, this.neededRows(), this.pinned);
  }

  // Fit cols to the host width; rows follow the run's own rules. FitAddon's
  // proposed rows are ignored: they would derive from the host height, which is
  // itself driven by the row count, so we set rows ourselves.
  private refit(): void {
    if (this.disposed || !this.host.isConnected || this.host.clientWidth === 0) return;
    const dims = this.fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || dims.cols < 2) return;
    const rows = this.live ? this.liveRows() : Math.min(this.neededRows(), RUN_ROWS);
    if (dims.cols !== this.term.cols || rows !== this.term.rows) {
      this.term.resize(dims.cols, rows);
      if (this.live) this.opts.onResize?.(dims.cols, rows);
    }
  }

  // Rows this run wants once it is finished, before the RUN_ROWS cap.
  private neededRows(): number {
    const buf = this.term.buffer.active;
    return neededRows(this.contentRows(), buf.baseY + buf.cursorY);
  }

  // The number of rows up to and including the last non-empty line (>= 1). Not
  // clamped, so freeze() can tell "fits" from "taller than the grid".
  private contentRows(): number {
    const buf = this.term.buffer.active;
    let last = 0;
    for (let i = 0; i < buf.length; i++) {
      if ((buf.getLine(i)?.translateToString(true) ?? "").trim() !== "") last = i + 1;
    }
    return Math.max(1, last);
  }
}

// --- the leave-the-terminal rule --------------------------------------------

// Whether an Escape keydown in a focused inline terminal means "give the
// keyboard back to the note" (interactions.md §6).
//
// ⌘Escape always does, and is the only form a full-screen program cannot
// swallow — which is why it, not the bare key, is the exit while one owns the
// screen (`pinned`): vim users double-tap Escape as a matter of habit, and
// being ejected from vim for it would be a worse bug than the one this fixes.
// Everywhere else the bare double tap works, because mashing Escape is what
// someone stuck in a box actually does.
export function escapeLeaves(o: { meta: boolean; pinned: boolean; sinceLastEscMs: number }): boolean {
  if (o.meta) return true;
  if (o.pinned) return false;
  return o.sinceLastEscMs <= ESC_EXIT_MS;
}

// --- the keyboard a running block needs -------------------------------------
//
// A software keyboard has no Ctrl, no Escape and no arrows, so a phone can
// answer a `sudo` password or a `[y/N]` by typing and has no key at all for the
// program that wants one of these (ios.md §7, §14). They arrive by NAME from
// the accessory bar's second face, which is a native surface that knows nothing
// about terminals — exactly as the first face names commands and knows nothing
// about the editor.
//
// Seven of them, and they are the four things that phase named: interrupt,
// end-of-file, Escape, and an arrow in each direction. `leave` is the eighth
// and is not a key the program sees; it is the ⌘Escape a phone cannot press,
// on the bar because the panel's own Back to note button rides the note's
// scroller and a run pinned to 24 rows can put it off the top of the screen.
//
// Deliberately NOT a modifier that arms the next letter, which is how a
// terminal app on iOS usually gets at Ctrl-anything: an armed modifier is state
// on this end that a native button has to be told about to draw, and the two
// would drift the first time a run ended with it still held.
export const RUN_KEYS = ["ctrlC", "ctrlD", "escape", "up", "down", "left", "right", "leave"] as const;

export type RunKey = (typeof RUN_KEYS)[number];

/** Whether `name` is one of them, for the bar's tap arriving as a bare string. */
export function isRunKey(name: string): name is RunKey {
  return (RUN_KEYS as readonly string[]).includes(name);
}

/**
 * What a key sends to the shell — "" for `leave`, which sends nothing.
 *
 * `applicationCursor` is DECCKM, which vim, less and every ncurses program turn
 * on while they own the screen: an arrow is `ESC O A` there and `ESC [ A`
 * everywhere else. Sending the wrong one is not a crash, it is an arrow that
 * does nothing in the one place arrows are the whole interface, so the mode is
 * asked of the live terminal (xterm's `modes`) rather than assumed.
 */
export function runKeyBytes(key: RunKey, applicationCursor: boolean): string {
  const cursor = applicationCursor ? "\x1bO" : "\x1b[";
  switch (key) {
    case "ctrlC":
      return "\x03";
    case "ctrlD":
      return "\x04";
    case "escape":
      return "\x1b";
    case "up":
      return `${cursor}A`;
    case "down":
      return `${cursor}B`;
    case "right":
      return `${cursor}C`;
    case "left":
      return `${cursor}D`;
    case "leave":
      return "";
  }
}

// --- row maths --------------------------------------------------------------

// How many rows a finished run needs, given its output and where its cursor
// ended up (both absolute buffer rows, cursor 0-based).
//
// The cursor's own line counts, even when it is blank. xterm will not shrink the
// grid past the cursor: asked for fewer rows than that, it stops discarding blank
// lines and scrolls instead, pushing the top of the output into scrollback (see
// Buffer.resize). The run then shows a scrollbar and opens on its second line,
// which is exactly the wrong shape for output that fits.
//
// A shell leaves the cursor one line below the last output (the trailing newline
// of the final command), so this usually means one blank row at the bottom, which
// is what a terminal looks like anyway. A program that ends without a newline
// leaves the cursor on the last line and costs nothing.
export function neededRows(contentRows: number, cursorRow: number): number {
  return Math.max(contentRows, cursorRow + 1);
}

// Rows for a run still in flight, given the grid it has now and what its output
// wants. Grows toward RUN_ROWS and never shrinks: mid-run is the one time the
// panel's height must not react to the output, because a program that clears the
// screen would otherwise collapse the box it is drawing into. `pinned` is a
// full-screen program holding the whole grid regardless of what it has drawn.
export function liveRows(currentRows: number, needed: number, pinned: boolean): number {
  if (pinned) return RUN_ROWS;
  return Math.max(currentRows, Math.min(needed, RUN_ROWS));
}

// --- pool ------------------------------------------------------------------

const pool = new Map<string, InlineTerm>();

export function acquireInlineTerm(id: string, opts: InlineTermOptions): InlineTerm {
  let it = pool.get(id);
  if (!it) {
    it = new InlineTerm(id, opts);
    pool.set(id, it);
  }
  return it;
}

export function getInlineTerm(id: string): InlineTerm | undefined {
  return pool.get(id);
}

export function releaseInlineTerm(id: string): void {
  const it = pool.get(id);
  if (!it) return;
  it.dispose();
  pool.delete(id);
}

/**
 * A press on the run's own keyboard, addressed to whichever panel has focus
 * (ios.md §7). False when the name is not one of `RUN_KEYS`, or when nothing is
 * focused to press it at.
 *
 * The focused panel and not a run id, because the bar over the keyboard has no
 * id to send: it appears BECAUSE a run took the keyboard, and the panel that
 * took it is the one the user is looking at. A page holds one focus, so this
 * asks the pool the same question the browser already answered.
 *
 * A string rather than a `RunKey` at the door, for the reason the verb path
 * takes a bare command id (lib/menu.ts): the caller is a native bar whose
 * buttons are strings, and a name this page does not know must fail visibly
 * here rather than be typed into somewhere by accident.
 */
export function sendRunKey(name: string): boolean {
  if (!isRunKey(name)) {
    console.warn(`[run] no such key: ${name}`);
    return false;
  }
  for (const it of pool.values()) {
    if (it.hasFocus()) return it.sendKey(name);
  }
  return false;
}

// --- header formatting (kept local so the pool stands alone) ----------------

function statusText(run: RunInfo): string {
  if (run.state === "running") return "Running";
  // Deliberately not "Stopped" or "Ended": this client cannot see the machine,
  // so what it knows is about the connection and not about the program. The
  // panel keeps whatever output it had, and the word says why no more is
  // arriving (blocks.ts setRunsLink).
  if (run.state === "unknown") return "Disconnected";
  if (run.state === "error") {
    // 128 + SIGINT: the shell's way of saying the block was Ctrl-C'd. Worth naming,
    // because it is the one non-zero status the user asked for on purpose.
    if (run.exitCode === 130) return "Interrupted";
    return run.exitCode != null ? `Exited ${run.exitCode}` : "Session ended";
  }
  return "Done";
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
