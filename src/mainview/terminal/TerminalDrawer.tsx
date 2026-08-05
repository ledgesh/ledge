import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  b64ToBytes,
  onTerminalDetached,
  onTerminalOutput,
  sendTerminalResize,
  sendTerminalText,
  terminalAttach,
  terminalDetach,
} from "./channel";
import { Button } from "@/components/ui/button";
import { copyText, readClipboard } from "../lib/clipboard";
import { labelFor } from "../lib/connections";
import { settings } from "../lib/settings";
import { isDarkAppearance, onAppearanceChange } from "../lib/theme";
import { eventToChord, matchesKey } from "../commands/keymap";
import { keyOf } from "../commands/keys";

function xtermTheme(dark: boolean) {
  return dark
    ? { background: "#1a1a1c", foreground: "#e8e8ea", cursor: "#e8e8ea", selectionBackground: "#3a3a40" }
    : { background: "#fbfbfd", foreground: "#1d1d1f", cursor: "#1d1d1f", selectionBackground: "#cfe0ff" };
}

// The drawer shows one note's terminal shell, named by `sessionId` (the focused
// note's docId). App keys this component by sessionId, so switching notes cleanly
// unmounts (detaching the old note's shell, which keeps running) and remounts
// (attaching the new note's, replaying its scrollback).
//
// `onReady` fires once the terminal has mounted and subscribed to output, so a
// queued "run in terminal" command can be flushed without racing the first output.
// `onClose` hides the drawer (Escape); the shell keeps running for next open.
// `spawnHost` is the machine picked for this open, consumed only if this
// attach is what spawns the shell; `onHost` reports the host the shell is
// actually on (from the attach response), which App shows as the badge.
//
// One shell has one drawer across the whole server, not one per client: another
// client attaching takes this one's bytes, keystrokes and winsize with it, and
// what arrives here is a `terminalDetached` push. That is the notice below, and
// its button attaches again, which takes the shell back (remote.md §7).
export function TerminalDrawer({
  sessionId,
  spawnHost,
  onReady,
  onClose,
  onHost,
}: {
  sessionId: string;
  spawnHost?: string | null;
  onReady?: () => void;
  onClose?: () => void;
  onHost?: (host: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Keep the latest onClose reachable from the key handler without re-running the
  // mount effect (which builds the terminal once).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Another client took this note's shell (rpc-schema terminalDetached): the
  // xterm on screen is a still frame from the moment it left, and the notice
  // covering it is the only thing that says so.
  //
  // null while this client has the shell; otherwise what took it — its label
  // from the presence list, or "" for a device that gave no name. Resolved when
  // the push arrives rather than at every render, so the notice does not change
  // its wording later because the other device has since gone away.
  const [takenBy, setTakenBy] = useState<string | null>(null);
  // Attaching again, which is how the shell comes back — published by the mount
  // effect, since that is where the terminal it writes into lives.
  const takeBack = useRef<() => void>(() => {});

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: settings().terminal.fontSize,
      cursorBlink: true,
      theme: xtermTheme(isDarkAppearance()),
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    // Whether this client owns the shell right now (bun/server.ts `Term.owner`).
    // False until the first attach answers, and false again from the moment
    // another client takes it: input and resize are the owner's alone, and Bun
    // refuses them either way — this is so the refused ones are never sent.
    let mine = false;

    // Keystrokes / pasted text -> Bun.
    const dataSub = term.onData((data) => {
      if (mine) sendTerminalText(sessionId, data);
    });

    // Clipboard, matching a normal terminal. xterm draws its own selection (not a
    // DOM selection the browser can copy) and the native paste event does not fire
    // reliably in this WebView, so Cmd+C and Cmd+V are handled explicitly and go
    // through the Bun process (pbcopy/pbpaste). Ctrl+C is left untouched so it
    // still sends SIGINT; Cmd+A selects the whole buffer.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // Escape hides the drawer rather than sending ESC to the shell. (Tradeoff:
      // full-screen TUIs in the drawer can't receive a bare Escape; acceptable
      // for a notes-app scratch terminal.)
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current?.();
        return false;
      }
      // Ctrl+` (the Toggle Terminal key, from commands/keys.ts) closes the
      // drawer from inside it too; the shell never sees the chord. Without
      // this, the key that opens the terminal is dead while you're in it.
      if (matchesKey(keyOf("terminal.toggle")!, eventToChord(e))) {
        e.preventDefault();
        onCloseRef.current?.();
        return false;
      }
      const cmd = e.metaKey && !e.ctrlKey && !e.altKey;
      // preventDefault on the keys we handle: otherwise the unhandled Cmd-key
      // reaches AppKit's key-equivalent path, which rings the system alert (the
      // "blip") even though the copy/paste itself succeeded.
      if (cmd && (e.key === "c" || e.key === "C") && term.hasSelection()) {
        e.preventDefault();
        copyText(term.getSelection());
        return false;
      }
      if (cmd && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        void readClipboard().then((text) => {
          if (text) term.paste(text);
        });
        return false;
      }
      if (cmd && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        term.selectAll();
        return false;
      }
      return true;
    });

    // Live output is buffered until the scrollback snapshot has been written, so
    // the replayed history and any output that lands mid-attach stay in order.
    let ready = false;
    let disposed = false;
    const queue: Uint8Array[] = [];
    const off = onTerminalOutput((sid, dataB64) => {
      if (sid !== sessionId) return; // output for another note's drawer
      const bytes = b64ToBytes(dataB64);
      if (ready) term.write(bytes);
      else queue.push(bytes);
    });

    // Attach, and again for every take-back. `replace` is what makes the second
    // one safe: the snapshot is the WHOLE scrollback, so writing it onto a
    // terminal that already shows part of it would print the session twice.
    // Reset first and the screen is rebuilt from the shell's history, including
    // everything it printed while another client had it.
    const attach = (replace: boolean): void => {
      ready = false;
      void terminalAttach(sessionId, spawnHost).then(({ snapshot, host }) => {
        if (disposed) return;
        onHost?.(host);
        if (replace) term.reset();
        if (snapshot.length) term.write(snapshot);
        for (const q of queue) term.write(q);
        queue.length = 0;
        ready = true;
        mine = true;
        setTakenBy(null);
        // The pty's grid is the OWNER's window, so it is set here rather than at
        // mount: before the attach answers there is no shell to size, and after
        // a take-back the shell has to be re-sized to this window (the client it
        // came from may have had a different one).
        sendTerminalResize(sessionId, term.cols, term.rows);
        if (replace) term.focus();
        else onReady?.();
      });
    };
    takeBack.current = () => attach(true);
    attach(false);

    // Another client attached: the bytes go there now, so stop sending what Bun
    // would refuse and let the notice explain the terminal that stopped moving.
    const offDetached = onTerminalDetached((sid, by) => {
      if (sid !== sessionId) return;
      mine = false;
      setTakenBy(labelFor(by));
    });

    // Keep the pty's winsize matched to the rendered grid — while this client is
    // the one whose grid it should match.
    const ro = new ResizeObserver(() => {
      fit.fit();
      if (mine) sendTerminalResize(sessionId, term.cols, term.rows);
    });
    ro.observe(host);

    // The palette can still move under a running terminal: "system" tracks the
    // OS live (lib/theme.ts). A pinned theme simply never fires.
    const offAppearance = onAppearanceChange((a) => (term.options.theme = xtermTheme(a === "dark")));

    term.focus();

    return () => {
      disposed = true;
      terminalDetach(sessionId);
      ro.disconnect();
      offAppearance();
      off();
      offDetached();
      dataSub.dispose();
      term.dispose();
    };
    // onReady is intentionally not a dep: the terminal is created once per mount.
    // App remounts (via key=sessionId) to switch notes, so sessionId is fixed for
    // a given mount and safe to close over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full" />
      {takenBy !== null && (
        // Over the terminal rather than instead of it: what is underneath is
        // the last thing this shell said here, and it stays readable while the
        // notice explains why nothing has been added to it.
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/85 px-4 text-center"
          data-testid="terminal-taken"
        >
          {/* By name when there is one: which machine has the shell is the
              first thing worth knowing about a shell that is somewhere else,
              and "another device" is what is left when a client gave no name. */}
          <p className="text-[12px] font-medium">{takenBy || "Another device"} took this shell.</p>
          <p className="max-w-[42ch] text-[11px] text-muted-foreground">
            Its output is going there now. Taking it back brings everything it printed while it was away.
          </p>
          <Button size="sm" onClick={() => takeBack.current()}>
            Take This Shell
          </Button>
        </div>
      )}
    </div>
  );
}
