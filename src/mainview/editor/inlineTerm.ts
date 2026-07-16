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

// A running block renders at a fixed grid so full-screen and redraw-style
// programs get a stable size; on finish it shrinks to the used rows so short
// output does not leave a tall blank box. 24 rows (~the classic terminal
// height) keeps the inline panel about the same height as the old <pre> cap.
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
    this.term.write(bytes);
  }

  // The command finished: stop tracking the live grid and shrink to the used
  // rows so a short run does not leave a tall blank terminal.
  freeze(): void {
    if (this.disposed) return;
    this.live = false;
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
      const content = this.contentRows();
      const rows = Math.min(content, RUN_ROWS);
      if (rows !== this.term.rows) this.term.resize(this.term.cols, rows);
      // Resizing to fewer rows than the buffer holds leaves the viewport anchored to
      // the cursor (usually a line below the last output, from a trailing newline),
      // scrolling the first line out of view. Anchor to the top so the output reads
      // from its start; longer-than-grid output stays scrollable.
      this.term.scrollToTop();
      // Output that fit only overflows by trailing blank lines we never scroll to,
      // so suppress the scrollbar; output taller than the grid keeps it.
      this.wrap.classList.toggle("ledge-term-clamped", content > RUN_ROWS);
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

  // Fit cols to the host width; hold rows at the run grid while live. FitAddon's
  // proposed rows are ignored: they would derive from the host height, which is
  // itself driven by the row count, so we set rows ourselves.
  private refit(): void {
    if (this.disposed || !this.host.isConnected || this.host.clientWidth === 0) return;
    const dims = this.fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || dims.cols < 2) return;
    const rows = this.live ? RUN_ROWS : Math.min(this.contentRows(), RUN_ROWS);
    if (dims.cols !== this.term.cols || rows !== this.term.rows) {
      this.term.resize(dims.cols, rows);
      if (this.live) this.opts.onResize?.(dims.cols, rows);
    }
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
