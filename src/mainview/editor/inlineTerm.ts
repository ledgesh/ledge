// The inline-terminal pool.
//
// Each inline run renders into a real xterm.js instance rather than an
// ANSI-stripped <pre>. Colour, cursor addressing, spinners, and in-place
// redraws (git paging, claude, python REPLs) come out right instead of
// collapsing into run-together text.
//
// A CodeMirror block widget is rebuilt on every change, but an xterm must
// persist and take writes incrementally. So the terminal lives here keyed by
// run id (mirroring the editor pool), and the OutputWidget only re-parents the
// pooled DOM. The widget owns lifecycle (create on first render, dispose when
// the run is removed); this module owns the terminal.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { RunInfo } from "./blocks";
import { copyText, readClipboard } from "../lib/clipboard";
import { settings } from "../lib/settings";
import { isDarkAppearance, onAppearanceChange } from "../lib/theme";

// The tallest an inline run gets: 24 rows, about the classic terminal height.
// That keeps the panel about as tall as the old <pre> cap. Past that the run
// scrolls.
//
// A run grows into this rather than starting there, so a one-line `echo` does
// not open a screen-high panel in the note and then collapse it when the
// command finishes. A full-screen program (vim, htop, a pager) sizes itself to
// the tty, so it gets the whole grid up front and keeps it (the
// alternate-buffer pin below).
const RUN_ROWS = 24;
const FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";

// How long after an Escape a second Escape still counts as the leave gesture.
const ESC_EXIT_MS = 600;

// xterm paints its own opaque background, so the card's lower half cannot use
// `--code-panel-bg` here. These colours are that variable pre-composited over
// the note background (0.06 white over #0a0a0b; 0.045 black over white), which
// keeps the terminal zone flush with the code above it instead of reading as a
// lighter box inside the card.
function xtermTheme(dark: boolean) {
  return dark
    ? { background: "#1a1a1c", foreground: "#e8e8ea", cursor: "#e8e8ea", selectionBackground: "#3a3a40" }
    : { background: "#f3f3f3", foreground: "#1d1d1f", cursor: "#1d1d1f", selectionBackground: "#cfe0ff" };
}

// Callbacks the widget wires so the terminal can reach the note's shell and
// the editor. `onResize` reports the live grid so the shell's winsize tracks
// it. `onInput` forwards keystrokes from the running block to the note's
// inline shell. `onHeightChange` asks CodeMirror to re-measure when the
// panel's height changes out of band (freeze, shrink). `onFocusEditor` returns
// focus to the prose editor when the run ends, is dismissed, or the user asks
// to leave it.
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
  /** True while the command is still running. Drives the grid size and the
   * input gate (`accepts`). */
  live = true;
  /** The machine this run is on has gone (RunInfo "unknown", blocks.ts
   * setRunsLink). Separate from `live` because a frozen panel never takes
   * input again, while this one takes it again as soon as the connection
   * comes back. Derived in setState. */
  private unreachable = false;
  /** A run's pending claim on the keyboard; see claimFocus(). */
  private claim: (() => boolean) | null = null;
  /** When the last Escape landed, for the leave-the-terminal double tap. */
  private lastEscape = 0;

  constructor(
    private readonly id: string,
    private readonly opts: InlineTermOptions,
  ) {
    this.wrap = document.createElement("div");
    // The live state is a class as well as a field, because the header draws
    // the tap hint from it combined with focus, and :focus-within can only be
    // combined with a class.
    this.wrap.className = "ledge-output ledge-term-live";
    this.wrap.contentEditable = "false";
    this.wrap.dataset.ledgeRun = id;

    this.header = document.createElement("div");
    this.header.className = "ledge-output-header";
    this.dot = document.createElement("span");
    this.status = document.createElement("span");
    this.status.className = "ledge-status";
    // Where this run executes, when that is not this machine. With several
    // machines in play, output that does not name its host is easy to misread.
    this.hostChip = document.createElement("span");
    this.hostChip.className = "ledge-host-chip";
    this.hostChip.style.display = "none";
    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    // Shown (by CSS) only while the panel holds focus. Nothing else announces
    // that focus moved. Keystrokes that used to land in the note now land in a
    // program, so the panel names that state and names the way back out (the
    // Escape grammar below).
    this.focusHint = document.createElement("span");
    this.focusHint.className = "ledge-focus-hint";
    // The opposite state, which only a touch client has. A run there does not
    // take the keyboard (editor/blocks.ts), so a program asking for a password
    // waits on a tap that nothing else would announce. Shown while the run is
    // live and the keyboard is elsewhere; the hint above replaces it once the
    // panel has focus.
    //
    // A button rather than a line of text, because a finger aims at these
    // words as well as reading them. Tapping the output still does the same
    // thing, and is what most people do (interactions.md §6a: the second way
    // in, not the replacement).
    this.tapHint = document.createElement("button");
    this.tapHint.className = "ledge-tap-hint";
    this.tapHint.textContent = "Tap to type";
    // mousedown and preventDefault, like the button below, so focus does not
    // rest on the button on its way to the terminal. Taking focus here, inside
    // the gesture's own handler, is also what lets iOS raise the keyboard.
    this.tapHint.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.focusTerm();
    });
    // The way out, said twice, because the two kinds of client share nothing
    // here: this span names the keys, the button below is itself the exit.
    // Both are built and CSS shows one, picking by `@media (hover: …)`, so
    // there is no live media query to re-read and no state to keep in step.
    this.exitKey = document.createElement("span");
    this.exitKey.className = "ledge-focus-key";
    // The touch client's way out. A phone has no ⌘Escape and no Escape to
    // press twice, and tapping the prose stops working under a full-screen
    // program: pinned to 24 rows with the keyboard up, the panel can fill the
    // screen (interactions.md §6a). This control is the analogue of ⌘Escape
    // rather than of the double tap. No program can swallow a button, so it
    // needs no `pinned` case and never changes its label.
    //
    // "Back to note" and not "Done": the run is not done and must not look
    // like it is being stopped. Leaving moves focus; the ✕ beside it is the
    // one that interrupts.
    this.leaveBtn = document.createElement("button");
    this.leaveBtn.className = "ledge-term-leave";
    this.leaveBtn.textContent = "Back to note";
    // mousedown, like every other button in the editor's chrome (blocks.ts
    // iconButton), with preventDefault so focus never lands on the button on
    // the way past. On a phone, focus moving from textarea to button to editor
    // puts the software keyboard away and brings it back, and the point of
    // leaving is to carry on typing.
    this.leaveBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.leave();
    });
    this.setFocusHint();
    this.duration = document.createElement("span");
    this.duration.className = "ledge-duration";
    // Reserved for the copy and dismiss buttons. They are drawn in the body
    // overlay rather than in the header (blocks.ts), so they take no space of
    // their own. Wider on touch, where a 44-point control sits to their left
    // rather than a line of 10px text: the gap separates handing the keyboard
    // back from interrupting the run.
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
    // reads as a hang, and some runs are silent for a long time (`claude -p`
    // prints nothing until it is done). This placeholder names the waiting.
    // CSS keeps it invisible for the first beat, so quick commands never flash
    // it; it is removed on the first byte (write) or at freeze.
    this.waiting = document.createElement("div");
    this.waiting.className = "ledge-term-waiting";
    this.waiting.textContent = "running, no output yet";
    this.body.appendChild(this.waiting);
    this.host = document.createElement("div");
    // Present but not shown until the first byte. This used to be
    // `display: none`, and the element has to stay laid out instead.
    //
    // An unlaid-out element has no width, so refit bailed and no winsize
    // reached the shell before the command ran. The command then used the
    // pty's default width, and anything that lays out to COLUMNS (zsh's own
    // prompt padding included) got it wrong.
    //
    // Zero-height and clipped keeps the width measurable without opening an
    // empty terminal row under the placeholder.
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
      // And the narrowest grid xterm allows, for a sharper version of the same
      // reason. The panel has no width of its own: it fills the editor's
      // content, and that content is as wide as its widest thing. An xterm
      // opening at the default 80 columns pushes the content out to 80
      // columns, and the re-fit then measures that and agrees with it.
      //
      // The wrong answer is stable: invisible on a Mac (605 points inside a
      // 1005-point editor) and the whole panel on a phone (605 inside 370,
      // interactions.md §1a). Opening at 2 leaves nothing to push with, and
      // the first re-fit grows the grid to whatever the editor actually is.
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

    // Keystrokes and pasted text go to the note's inline shell, but only while
    // something at the other end can take them (see accepts). A frozen
    // terminal is read-only output, and a disconnected one is a program
    // nothing typed here can reach. The text stays selectable for copy either
    // way.
    this.term.onData((data) => {
      if (this.accepts()) this.opts.onInput?.(data);
    });

    // Clipboard keys, matching a normal terminal (and the drawer). xterm draws
    // its own selection and the WebView's native copy and paste do not fire
    // reliably, so Cmd+C, Cmd+V and Cmd+A go through the Bun clipboard. Ctrl+C
    // is left alone so it still sends SIGINT to an inline program. Returning
    // false consumes the key, so the unhandled Cmd chord does not ring the
    // system alert.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const cmd = e.metaKey && !e.ctrlKey && !e.altKey;
      // The way back to the prose for a run that took focus on its own (see
      // claimFocus). The program still receives the Escapes. The bare form
      // acts on the second one, so the first has already gone through. A
      // pinned full-screen program keeps both, because ⌘Escape is its exit and
      // a vim user's habitual double tap must not eject them from vim.
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
        if (this.accepts()) void readClipboard().then((text) => text && this.term.paste(text));
        return false;
      }
      if (cmd && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        this.term.selectAll();
        return false;
      }
      return true;
    });

    // A program switching to the alternate buffer is a full-screen one
    // starting up (vim, htop and less all do this before they draw). It has
    // sized itself to the tty, so it gets the full grid at once and content
    // tracking stops: rows used means nothing for a screen redrawn in place.
    this.term.buffer.onBufferChange(() => {
      if (this.disposed || this.term.buffer.active.type !== "alternate") return;
      this.pinned = true;
      this.setFocusHint();
      this.refit();
      this.opts.onHeightChange?.();
    });

    // A "system" appearance still changes under a frozen panel (lib/theme.ts).
    // A theme pinned to light or dark never fires this.
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
    // Derived here rather than pushed in separately: every transition into and
    // out of "unknown" already comes through this method (blocks.ts
    // setRunsLink). One source for the header's word and the input gate keeps
    // the panel from saying "Disconnected" while still accepting keystrokes.
    this.unreachable = run.state === "unknown";
    this.setFocusHint();
    // The touch client's invitation to type, withdrawn while there is nothing
    // to type at. CSS shows it under .ledge-term-live, which an unknown run
    // keeps. An inline style rather than a class, matching how the host chip
    // below hides, and it overrides the media query.
    this.tapHint.style.display = this.unreachable ? "none" : "";
    // "local" is the reserved frontmatter word, not a place worth labeling.
    const remote = run.host && run.host !== "local" ? run.host : null;
    this.hostChip.textContent = remote ?? "";
    this.hostChip.style.display = remote ? "" : "none";
    this.duration.textContent = run.durationMs != null ? formatDuration(run.durationMs) : "";
  }

  // A run asks for the keyboard. The claim is not honored until the terminal
  // is on screen, both because an unrevealed host cannot take focus and
  // because the first byte is where a "Password:" or a "[y/N]" appears. There
  // is nothing to answer before then.
  //
  // `stillWanted` is the staleness test, evaluated at that later moment rather
  // than now. A claim lapses if the user has gone back to typing in the note
  // or clicked away entirely, so focus does not move mid-sentence.
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

  /** Put the keyboard in the terminal, for an honored claim or a tap on the
   * invitation in the header.
   *
   * preventScroll because the panel is already in view either way: it sits
   * under the block the caret was in, or it is what was just tapped. Without
   * it, focusing scrolls the widget to the top of the viewport and the note
   * moves under the user. */
  private focusTerm(): void {
    this.term.textarea?.focus({ preventScroll: true });
  }

  /** Hand the keyboard back to the prose editor (Escape grammar, dismiss, freeze). */
  private leave(): void {
    this.lastEscape = 0;
    this.term.blur();
    this.opts.onFocusEditor?.();
  }

  /** Whether the keyboard is over this run. Public because `sendRunKey` picks
   * a panel with it: a page holds many panels and at most one has focus. */
  hasFocus(): boolean {
    return this.host.contains(document.activeElement);
  }

  /**
   * Send one press from the run's own keyboard (`RUN_KEYS`, ios.md §7). The
   * key arrives from the accessory bar as a name, with no key event behind it,
   * so the bytes are picked here rather than by xterm.
   *
   * The one thing xterm is asked is which cursor-key mode the program put the
   * terminal in, since that changes what an arrow sends. `leave` sends
   * nothing: it is the way back to the note, ⌘Escape on a Mac and a control on
   * a phone.
   */
  sendKey(key: RunKey): boolean {
    if (this.disposed) return false;
    if (key === "leave") {
      this.leave();
      return true;
    }
    // The same gate typed input passes (accepts): a frozen panel is output
    // rather than a program, and a disconnected one is a program out of reach.
    // The press is refused rather than sent, and the false is the refusal (the
    // e2e harness reads it; ios.tsx discards it).
    if (!this.accepts()) return false;
    this.opts.onInput?.(runKeyBytes(key, this.term.modes.applicationCursorKeysMode));
    return true;
  }

  /**
   * Whether a keystroke typed here can reach a program. Two ways it cannot,
   * and the header names which. `live` goes false when the run ends: its shell
   * is gone, and the panel is output to read. `unreachable` is a run whose
   * machine went away mid-flight: the program may still be there, but nothing
   * typed here reaches it.
   *
   * Both refuse the input rather than send it, because `inputInline` is a
   * `void` call (boot.tsx) that would discard it without a word. A password
   * typed into a terminal that quietly discards it is the worst version of
   * this.
   */
  private accepts(): boolean {
    return this.live && !this.unreachable;
  }

  private setFocusHint(): void {
    // What the keyboard is doing. An unreachable run keeps focus: the outage
    // is often over in seconds, and moving the caret back into the prose
    // mid-sentence would be worse than the wait. So the hint says "not
    // connected" rather than "typing here".
    this.focusHint.textContent = this.unreachable ? "not connected" : "typing here";
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
    // Grow on the write's callback, not now. xterm parses on its own queue,
    // so the rows this output needs are not known until it has drained.
    this.term.write(bytes, () => this.grow());
  }

  // Track the grid to the output as it arrives, up to RUN_ROWS. Growth only,
  // so a program that clears the screen mid-run does not collapse the panel
  // under it. freeze() does the one shrink, at the end.
  private grow(): void {
    if (this.disposed || !this.shown || this.pinned) return;
    // Nothing to do once the grid is full. This is the hot path for streaming
    // output, so bail before measuring: contentRows() would walk the
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
    // Drop any pending claim on the keyboard. A silent command can finish
    // before its first byte and leave a claim that never came due, and a
    // finished run has no reason to take focus.
    this.claim = null;
    // A run that finished without a byte keeps its header ("Done") and drops
    // the placeholder. "no output yet" would be wrong once the run is over,
    // and a collapsed body already reads as no output.
    this.waiting.remove();
    // The full-screen program that claimed the grid exited with the block, and
    // its screen went with it, so the pin has nothing left to hold. Cleared
    // here, or a later re-fit would undo the shrink below.
    this.pinned = false;
    this.setFocusHint();
    this.term.options.cursorBlink = false;
    // If the finished terminal held focus, hand it back to the prose editor so
    // keystrokes do not land in a now read-only terminal.
    if (this.hasFocus()) this.leave();
    if (!this.shown) return; // no output at all; nothing to render
    // xterm parses writes on its own queue, so the last output bytes may not
    // be in the buffer yet. The empty write's callback runs once the queue
    // drains, so neededRows() measures the settled buffer.
    this.term.write("", () => {
      if (this.disposed) return;
      const needed = this.neededRows();
      const rows = Math.min(needed, RUN_ROWS);
      if (rows !== this.term.rows) this.term.resize(this.term.cols, rows);
      // Stay where the output left off. A run that fits sized its grid to hold
      // everything, so this does nothing for it. A run taller than the grid
      // clamps and keeps its scrollbar, and its end is the part worth landing
      // on: the last thing a build said, the error that stopped it. Rewinding
      // to the top instead opens every long run on `Line 1`.
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
    // Hand the keyboard back before tearing out the DOM that holds it. A panel
    // dismissed (or whose block was deleted) while focused would otherwise
    // drop focus to <body>, and the next keystroke would go nowhere.
    const held = this.hasFocus();
    this.disposed = true;
    if (held) this.opts.onFocusEditor?.();
    this.ro.disconnect();
    this.offAppearance();
    this.term.dispose();
  }

  // Rows for a run still in flight. Never fewer than it already has, so a
  // re-fit for an unrelated reason (a pane resize) cannot shrink the grid
  // under a running program.
  private liveRows(): number {
    return liveRows(this.term.rows, this.neededRows(), this.pinned);
  }

  // Fit cols to the host width. Rows follow the run's own rules, so FitAddon's
  // proposed rows are ignored: they derive from the host height, which is
  // itself driven by the row count.
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

// Whether an Escape keydown in a focused inline terminal hands the keyboard
// back to the note (interactions.md §6a).
//
// ⌘Escape always does, and is the one form a full-screen program cannot
// swallow, so it is the exit while a program owns the screen (`pinned`): vim
// users double-tap Escape by habit and must not be ejected from vim for it.
// Everywhere else the bare double tap works, within ESC_EXIT_MS.
export function escapeLeaves(o: { meta: boolean; pinned: boolean; sinceLastEscMs: number }): boolean {
  if (o.meta) return true;
  if (o.pinned) return false;
  return o.sinceLastEscMs <= ESC_EXIT_MS;
}

// --- the keyboard a running block needs -------------------------------------
//
// A software keyboard has no Ctrl, no Escape and no arrows. A phone can answer
// a `sudo` password or a `[y/N]` by typing, and has no key at all for a program
// that wants one of these (interactions.md §6a, ios.md §7 and §14). Seven keys
// arrive by name from the accessory bar's second face, a native surface that
// knows nothing about terminals.
//
// The seven cover four things: interrupt, end-of-file, Escape, and an arrow in
// each direction. That is the list ios.md §14's phase named.
//
// There is no sticky modifier that arms the next letter, the usual way a
// terminal app on iOS reaches Ctrl-anything. An armed modifier is state on this
// end that a native button has to draw, and the two would drift the first time
// a run ended with it still held.
//
// `leave` is the eighth member and is not a key the program sees. It is the
// ⌘Escape a phone cannot press, on the bar because the panel's own Back to note
// button rides the note's scroller and a run pinned to 24 rows can put it off
// the top of the screen.
export const RUN_KEYS = ["ctrlC", "ctrlD", "escape", "up", "down", "left", "right", "leave"] as const;

export type RunKey = (typeof RUN_KEYS)[number];

/** Whether `name` is a `RunKey`, for a bar tap that arrives as a bare string. */
export function isRunKey(name: string): name is RunKey {
  return (RUN_KEYS as readonly string[]).includes(name);
}

/**
 * What a key sends to the shell. `leave` sends "".
 *
 * `applicationCursor` is DECCKM, which vim, less and every ncurses program turn
 * on while they own the screen: an arrow is `ESC O A` there and `ESC [ A`
 * everywhere else. Callers read the mode off the live terminal (xterm's
 * `modes`) rather than assume it, since the wrong form is an arrow that does
 * nothing in the one place arrows are the whole interface.
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
// The cursor's own line counts, even when it is blank. xterm will not shrink
// the grid past the cursor: asked for fewer rows, it scrolls instead of
// discarding blank lines, pushing the top of the output into scrollback (see
// Buffer.resize). The run would then show a scrollbar and open on its second
// line even though the output fits.
//
// A shell leaves the cursor one line below the last output (the final
// command's trailing newline), so this usually adds one blank row at the
// bottom. A program that ends without a newline leaves the cursor on the last
// line and adds nothing.
export function neededRows(contentRows: number, cursorRow: number): number {
  return Math.max(contentRows, cursorRow + 1);
}

// Rows for a run still in flight, given the grid it has now and what its
// output wants. Grows toward RUN_ROWS and never shrinks, so a program that
// clears the screen mid-run does not collapse the box it is drawing into.
// `pinned` is a full-screen program holding the whole grid regardless of what
// it has drawn.
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
 * A press on the run's own keyboard, sent to whichever panel has focus
 * (ios.md §7). Returns false when the name is not in `RUN_KEYS`, when no panel
 * has focus, and when the focused panel refuses the key (disposed, frozen, or
 * disconnected).
 *
 * It finds the panel by focus rather than by run id, because the bar over the
 * keyboard has no id to send: it appears because a run took the keyboard, and
 * a page holds one focus.
 *
 * `name` is a string rather than a `RunKey`, like the bare command id the verb
 * path takes (lib/menu.ts). The caller is a native bar whose buttons are
 * strings, so a name this page does not know fails visibly here (the
 * `console.warn` below) instead of being typed into a shell by accident.
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
  // Not "Stopped" or "Ended": this client cannot see the machine, so what it
  // knows is about the connection and not about the program. The panel keeps
  // the output it had, and the word says why no more is arriving (blocks.ts
  // setRunsLink).
  if (run.state === "unknown") return "Disconnected";
  if (run.state === "error") {
    // 128 + SIGINT: the shell's code for a block that was Ctrl-C'd. Named
    // because it is the one non-zero status the user asked for.
    if (run.exitCode === 130) return "Interrupted";
    return run.exitCode != null ? `Exited ${run.exitCode}` : "Session ended";
  }
  return "Done";
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
