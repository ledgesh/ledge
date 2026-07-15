// A small ANSI SGR parser for the inline output panel.
//
// Block output comes from a real pty (openpty), so colour-aware tools like ls,
// git, and grep emit SGR escape sequences. The panel used to strip them; this
// turns the common ones (16/256/truecolour foreground and background, bold, dim,
// italic, underline, inverse) into styled spans. Cursor-movement and other CSI
// sequences, plus OSC strings, are recognised and skipped rather than printed.
// This is deliberately not a terminal emulator: the terminal drawer (xterm.js)
// handles the full stream; here we only need legible colour on mostly-linear
// output.

export interface AnsiChunk {
  text: string;
  style: string; // inline CSS; "" for default (emitted as a bare text node)
}

interface SgrState {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

function freshState(): SgrState {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false };
}

// Mid-tone 16-colour palette chosen to stay legible on both the light and dark
// panel backgrounds (pure black/white foregrounds are the usual casualty of a
// theme-following panel, so 0 and 7 are nudged toward the middle).
const ANSI16 = [
  "#3b3b3b", "#d0453b", "#2ea043", "#c69a2d", "#3b82f6", "#b25fd0", "#279b9b", "#b8b8b8",
  "#6e6e6e", "#f0605a", "#46c46a", "#e0b23c", "#5ca0fb", "#cf7fe6", "#3ec9c9", "#eeeeee",
];

function color256(n: number): string {
  if (n < 16) return ANSI16[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const scale = (c: number) => (c === 0 ? 0 : 55 + c * 40);
  return `rgb(${scale(r)},${scale(g)},${scale(b)})`;
}

// Consume an extended-colour argument (38/48 …) starting just after the 38/48,
// returning the CSS colour and how many params it used.
function extendedColor(params: number[], at: number): { color: string | null; used: number } {
  const mode = params[at + 1];
  if (mode === 5) return { color: color256(params[at + 2] ?? 0), used: 2 };
  if (mode === 2) {
    const r = params[at + 2] ?? 0;
    const g = params[at + 3] ?? 0;
    const b = params[at + 4] ?? 0;
    return { color: `rgb(${r},${g},${b})`, used: 4 };
  }
  return { color: null, used: 0 };
}

function applySgr(params: number[], s: SgrState): void {
  if (params.length === 0) params = [0]; // ESC[m == ESC[0m (reset)
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) Object.assign(s, freshState());
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 7) s.inverse = true;
    else if (p === 22) s.bold = s.dim = false;
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p === 27) s.inverse = false;
    else if (p >= 30 && p <= 37) s.fg = ANSI16[p - 30];
    else if (p === 38) {
      const { color, used } = extendedColor(params, i);
      s.fg = color;
      i += used;
    } else if (p === 39) s.fg = null;
    else if (p >= 40 && p <= 47) s.bg = ANSI16[p - 40];
    else if (p === 48) {
      const { color, used } = extendedColor(params, i);
      s.bg = color;
      i += used;
    } else if (p === 49) s.bg = null;
    else if (p >= 90 && p <= 97) s.fg = ANSI16[p - 90 + 8];
    else if (p >= 100 && p <= 107) s.bg = ANSI16[p - 100 + 8];
  }
}

function styleFor(s: SgrState): string {
  let fg = s.fg;
  let bg = s.bg;
  if (s.inverse) {
    // Swap, filling in defaults so inverted text stays visible on the panel.
    const nf = bg ?? "var(--panel-bg)";
    const nb = fg ?? "var(--fg)";
    fg = nf;
    bg = nb;
  }
  const parts: string[] = [];
  if (fg) parts.push(`color:${fg}`);
  if (bg) parts.push(`background-color:${bg}`);
  if (s.bold) parts.push("font-weight:600");
  if (s.dim && !s.inverse) parts.push("opacity:0.7");
  if (s.italic) parts.push("font-style:italic");
  if (s.underline) parts.push("text-decoration:underline");
  return parts.join(";");
}

const ESC = "\x1b";

// Parse `input` into styled chunks. State carries across chunks, so passing the
// full accumulated output each render is correct (streamed output re-parses from
// the top, which keeps colour spans that opened in an earlier write).
export function parseAnsi(input: string): AnsiChunk[] {
  const text = input.replace(/\r\n/g, "\n").replace(/\r/g, "");
  const chunks: AnsiChunk[] = [];
  const state = freshState();
  let run = "";
  let i = 0;

  const flush = () => {
    if (run) {
      chunks.push({ text: run, style: styleFor(state) });
      run = "";
    }
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch !== ESC) {
      run += ch;
      i += 1;
      continue;
    }
    const next = text[i + 1];
    if (next === "[") {
      // CSI: ESC [ params (0x30-0x3f) intermediates (0x20-0x2f) final (0x40-0x7e)
      let j = i + 2;
      while (j < text.length) {
        const code = text.charCodeAt(j);
        if (code >= 0x40 && code <= 0x7e) break;
        j += 1;
      }
      const final = text[j];
      if (final === "m") {
        flush();
        const raw = text.slice(i + 2, j);
        const params = raw === "" ? [] : raw.split(";").map((n) => parseInt(n, 10) || 0);
        applySgr(params, state);
      }
      // Any other CSI (cursor moves, clears) is skipped.
      i = j + 1;
    } else if (next === "]") {
      // OSC: ESC ] ... terminated by BEL or ST (ESC \)
      let j = i + 2;
      while (j < text.length && text[j] !== "\x07" && !(text[j] === ESC && text[j + 1] === "\\")) j += 1;
      i = text[j] === "\x07" ? j + 1 : j + 2;
    } else {
      // Other two-byte escape; skip it.
      i += 2;
    }
  }
  flush();
  return chunks;
}
