// Clipboard access for the app's WebView, used by editor/blocks.ts and
// terminal/TerminalDrawer.tsx. The views:// scheme is not a secure context, so
// navigator.clipboard is missing and execCommand and native ⌘V are unreliable
// (interactions.md §10). boot.tsx wires the real path through the Bun process
// (pbcopy and pbpaste) with configureClipboard. execCopy below is the fallback
// for the view in a plain browser (the Vite dev server), which has no bridge.

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
 * translates it). With no `readRich` wired, as when the view runs in a plain
 * browser, there is no second flavor to read. The result is the text with an
 * empty `html`, and ⌘V pastes it as plain text.
 */
export async function readRichClipboard(): Promise<RichClipboard> {
  if (nativeReadRich) return nativeReadRich();
  return { text: await readClipboard(), html: "" };
}

// Browser-only fallback. execCommand("copy") copies the current selection, so
// execCopy needs the text selected somewhere first. It adds an invisible
// textarea at the top-left corner, puts the text in it, selects it, and copies.
// Afterward it removes the textarea and returns focus to the element that had
// it.
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
    // The copy failed, so the clipboard keeps what it held. There is no
    // other path to it from a plain browser.
  }
  ta.remove();
  active?.focus?.();
}
