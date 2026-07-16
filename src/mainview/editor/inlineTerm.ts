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

function xtermTheme(dark: boolean) {
  return dark
    ? { background: "#1a1a1c", foreground: "#e8e8ea", cursor: "#e8e8ea", selectionBackground: "#3a3a40" }
    : { background: "#fbfbfd", foreground: "#1d1d1f", cursor: "#1d1d1f", selectionBackground: "#cfe0ff" };
}

// Callbacks the widget wires so the terminal can reach the note's shell and the
// editor. `onResize` reports the live grid so the shell's winsize tracks it;
// `onInput` forwards keystrokes from the running block to the note's inline shell;
// `onHeightChange` asks CodeMirror to re-measure when the panel's height changes
// out of band (freeze/shrink); `onFocusEditor` returns focus to the prose editor
// when the run finishes.
export interface InlineTermOptions {
  onResize?: (cols: number, rows: number) => void;
  onInput?: (data: string) => void;
  onHeightChange?: () => void;
  onFocusEditor?: () => void;
}

export class InlineTerm {
  readonly wrap: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly host: HTMLDivElement;
  private readonly header: HTMLDivElement;
  private readonly dot: HTMLSpanElement;
  private readonly status: HTMLSpanElement;
  private readonly duration: HTMLSpanElement;
  private readonly term: Terminal;
  private readonly fit: FitAddon;
  private readonly ro: ResizeObserver;
  private readonly media: MediaQueryList;
  private readonly onScheme: () => void;
  private shown = false;
  private disposed = false;
  /** A full-screen program took the grid; hold it at RUN_ROWS and stop tracking. */
  private pinned = false;
  /** True while the command is still running (drives grid size / step-2 input). */
  live = true;

  constructor(
    private readonly id: string,
    private readonly opts: InlineTermOptions,
  ) {
    this.wrap = document.createElement("div");
    this.wrap.className = "ledge-output";
    this.wrap.contentEditable = "false";
    this.wrap.dataset.ledgeRun = id;

    this.header = document.createElement("div");
    this.header.className = "ledge-output-header";
    this.dot = document.createElement("span");
    this.status = document.createElement("span");
    this.status.className = "ledge-status";
    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    this.duration = document.createElement("span");
    this.duration.className = "ledge-duration";
    const gap = document.createElement("span");
    gap.style.width = "48px";
    this.header.append(this.dot, this.status, spacer, this.duration, gap);
    this.wrap.appendChild(this.header);

    this.body = document.createElement("div");
    this.body.className = "ledge-term-body";
    this.host = document.createElement("div");
    this.host.className = "ledge-term-host";
    this.host.style.display = "none"; // revealed on first output
    this.body.appendChild(this.host);
    this.wrap.appendChild(this.body);

    this.media = window.matchMedia("(prefers-color-scheme: dark)");
    this.term = new Terminal({
      fontFamily: FONT,
      fontSize: 12,
      // Start at one row and grow with the output. xterm's default is 24, and
      // liveRows() never shrinks a running grid, so the starting size is the
      // smallest the panel can ever be.
      rows: 1,
      theme: xtermTheme(this.media.matches),
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
      this.refit();
      this.opts.onHeightChange?.();
    });

    this.onScheme = () => (this.term.options.theme = xtermTheme(this.media.matches));
    this.media.addEventListener("change", this.onScheme);

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
    this.duration.textContent = run.durationMs != null ? formatDuration(run.durationMs) : "";
  }

  write(bytes: Uint8Array): void {
    if (this.disposed) return;
    if (!this.shown) {
      this.shown = true;
      this.host.style.display = "block";
      this.refit();
      this.opts.onHeightChange?.();
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
    // The full-screen program that claimed the grid has exited with the block, and
    // its screen went with it, so the pin has nothing left to protect. Cleared here
    // or freeze's shrink would be undone by the next re-fit.
    this.pinned = false;
    this.term.options.cursorBlink = false;
    // If the finished terminal held focus (the user was typing into the program),
    // hand focus back to the prose editor so keystrokes do not fall into a now
    // read-only terminal.
    if (this.host.contains(document.activeElement)) {
      this.term.blur();
      this.opts.onFocusEditor?.();
    }
    if (!this.shown) return; // no output at all; nothing to render
    // xterm parses writes on its own async queue, so the final output bytes may not
    // be in the buffer yet; the empty write's callback runs once the queue drains,
    // so usedRows() measures the settled buffer.
    this.term.write("", () => {
      if (this.disposed) return;
      const needed = this.neededRows();
      const rows = Math.min(needed, RUN_ROWS);
      if (rows !== this.term.rows) this.term.resize(this.term.cols, rows);
      // Belt and braces: output that fits now sizes the grid to hold the cursor too,
      // so there is nothing to scroll to. Only a run taller than the grid clamps,
      // and that one keeps its scrollbar.
      this.term.scrollToTop();
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
    this.disposed = true;
    this.ro.disconnect();
    this.media.removeEventListener("change", this.onScheme);
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

// --- header formatting (kept local so the pool stands alone) ----------------

function statusText(run: RunInfo): string {
  if (run.state === "running") return "Running";
  if (run.state === "error") return run.exitCode != null ? `Exited ${run.exitCode}` : "Session ended";
  return "Done";
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
