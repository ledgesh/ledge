import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  b64ToBytes,
  onTerminalOutput,
  sendTerminalResize,
  sendTerminalText,
  terminalAttach,
  terminalDetach,
} from "./channel";

function xtermTheme(dark: boolean) {
  return dark
    ? { background: "#1a1a1c", foreground: "#e8e8ea", cursor: "#e8e8ea", selectionBackground: "#3a3a40" }
    : { background: "#fbfbfd", foreground: "#1d1d1f", cursor: "#1d1d1f", selectionBackground: "#cfe0ff" };
}

// Fires once the terminal has mounted and subscribed to output, so a queued
// "run in terminal" command can be flushed without racing the first output.
export function TerminalDrawer({ onReady }: { onReady?: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      cursorBlink: true,
      theme: xtermTheme(media.matches),
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    sendTerminalResize(term.cols, term.rows);

    // Keystrokes / pasted text -> Bun.
    const dataSub = term.onData((data) => sendTerminalText(data));

    // Live output is buffered until the scrollback snapshot has been written, so
    // the replayed history and any output that lands mid-attach stay in order.
    let ready = false;
    let disposed = false;
    const queue: Uint8Array[] = [];
    const off = onTerminalOutput((dataB64) => {
      const bytes = b64ToBytes(dataB64);
      if (ready) term.write(bytes);
      else queue.push(bytes);
    });

    void terminalAttach().then((snapshot) => {
      if (disposed) return;
      if (snapshot.length) term.write(snapshot);
      for (const q of queue) term.write(q);
      queue.length = 0;
      ready = true;
      onReady?.();
    });

    // Keep the pty's winsize matched to the rendered grid.
    const ro = new ResizeObserver(() => {
      fit.fit();
      sendTerminalResize(term.cols, term.rows);
    });
    ro.observe(host);

    const onScheme = () => (term.options.theme = xtermTheme(media.matches));
    media.addEventListener("change", onScheme);

    term.focus();

    return () => {
      disposed = true;
      terminalDetach();
      ro.disconnect();
      media.removeEventListener("change", onScheme);
      off();
      dataSub.dispose();
      term.dispose();
    };
    // onReady is intentionally not a dep: the terminal is created once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className="h-full w-full" />;
}
