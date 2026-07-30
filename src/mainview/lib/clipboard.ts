// Clipboard access for the app's WebView.
//
// The view runs under the views:// scheme, which is not a secure context, so
// navigator.clipboard is unavailable and execCommand / native Cmd+V paste are
// unreliable. The real path goes through the Bun process (pbcopy/pbpaste), wired
// here by main.tsx via configureClipboard. The execCommand fallback only matters
// when running the view in a plain browser (e.g. the Vite dev server) where the
// native bridge is absent. Shared by the inline output panel (editor/blocks.ts)
// and the terminal drawer (terminal/TerminalDrawer.tsx).

/** Both pasteboard flavors: `html` is "" unless it carries formatted text. */
export interface RichClipboard {
  text: string;
  html: string;
}

let nativeWrite: ((text: string) => void) | null = null;
let nativeRead: (() => Promise<string>) | null = null;
let nativeReadRich: (() => Promise<RichClipboard>) | null = null;

export function configureClipboard(fns: {
  write: (text: string) => void;
  read: () => Promise<string>;
  readRich?: () => Promise<RichClipboard>;
}): void {
  nativeWrite = fns.write;
  nativeRead = fns.read;
  nativeReadRich = fns.readRich ?? null;
}

export function copyText(text: string): void {
  if (nativeWrite) {
    nativeWrite(text);
    return;
  }
  const clip = navigator.clipboard;
  if (clip && typeof clip.writeText === "function") {
    clip.writeText(text).catch(() => execCopy(text));
  } else {
    execCopy(text);
  }
}

export async function readClipboard(): Promise<string> {
  if (nativeRead) return nativeRead();
  const clip = navigator.clipboard;
  if (clip && typeof clip.readText === "function") {
    try {
      return await clip.readText();
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * The pasteboard with its HTML flavor, for the editor's ⌘V (editor/htmlPaste.ts
 * translates it). Without the native bridge — the view in a plain browser, or a
 * harness that stubs text only — there is no second flavor to have, so this
 * degrades to the text and an empty `html`, which is exactly "paste the text".
 */
export async function readRichClipboard(): Promise<RichClipboard> {
  if (nativeReadRich) return nativeReadRich();
  return { text: await readClipboard(), html: "" };
}

// execCommand("copy") copies the current selection, so we stage the text in an
// off-screen textarea, select it, copy, and remove it. This transiently moves
// focus; we restore it afterward. Browser-only fallback.
function execCopy(text: string): void {
  const active = document.activeElement as HTMLElement | null;
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
  active?.focus?.();
}
