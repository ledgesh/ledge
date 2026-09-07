import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  b64ToBytes,
  dispatchTerminalExit,
  onTerminalDetached,
  onTerminalOutput,
  onTerminalRelink,
  sendTerminalResize,
  sendTerminalText,
  terminalAttach,
  terminalClaim,
  terminalDetach,
} from "./channel";
import { Button } from "@/components/ui/button";
import { copyText, readClipboard } from "../lib/clipboard";
import { activeConnection, labelFor, linkState, subscribeConnections } from "../lib/connections";
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
// note's docId). App keys this component by sessionId, so switching notes
// unmounts (detaching the old note's shell, which keeps running) and remounts
// (attaching the new note's, replaying its scrollback). Three paths replay the
// shell's history here: the mount's attach, a take-back attach, and a claim
// after a reconnect.

// `onReady` fires once the terminal has mounted and subscribed to output, so a
// queued "run in terminal" command flushes without racing the first output.
// `onClose` hides the drawer (Escape); the shell keeps running. `spawnHost` is
// the machine picked for this open, used only if this attach spawns the shell.
// `onHost` reports the host from the attach response, shown as App's badge.

// A shell has one drawer across the whole server, not one per client. Another
// client attaching takes this one's bytes, keystrokes and winsize, and a
// `terminalDetached` push arrives here (remote.md §7). A dropped wire is the
// other case: the drawer stops sending input, since a terminal waiting for the
// shell and one unable to reach it look the same. Both notices are below.
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
  // Label of the client that took this note's shell (rpc-schema
  // terminalDetached), null while this client has it. labelFor resolves it from
  // the presence list ("" when that list has no entry) as the push arrives, not
  // at each render, so the notice keeps its wording after that device goes
  // away. The xterm keeps its last frame: only the notice says the shell left.
  const [takenBy, setTakenBy] = useState<string | null>(null);
  // Takes the shell back by attaching again. The mount effect publishes this
  // ref, since that is where the terminal the attach writes into lives.
  const takeBack = useRef<() => void>(() => {});
  // The wire to the machine this shell is on is down (lib/connections.ts).
  // Only for drawing: what the keystroke path reads is linkState() itself, so
  // a key pressed between the drop and the re-render is refused too.
  const [offline, setOffline] = useState(() => linkState().state === "lost");
  useEffect(() => subscribeConnections(() => setOffline(linkState().state === "lost")), []);

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
    // another client takes it. Input and resize are the owner's alone, and Bun
    // refuses them from anyone else. This flag keeps them from being sent.
    let mine = false;

    // The handler sends keystrokes and pasted text to Bun while this client has
    // the shell and a wire to carry them, and skips the send otherwise:
    // `terminalInput` is a `void` call (boot.tsx) whose rejection nothing reads,
    // so a line typed at a dropped connection would disappear silently. The gate
    // is "lost" and not "reconnecting", as in editor/blocks.ts `linkDown`.
    const dataSub = term.onData((data) => {
      if (mine && linkState().state !== "lost") sendTerminalText(sessionId, data);
    });

    // Clipboard, matching a normal terminal. xterm draws its own selection (not a
    // DOM selection the browser can copy) and the native paste event does not fire
    // reliably in this WebView, so Cmd+C and Cmd+V are handled explicitly and go
    // through the Bun process (pbcopy/pbpaste). Ctrl+C is left untouched so it
    // still sends SIGINT; Cmd+A selects the whole buffer.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // Escape hides the drawer rather than sending ESC to the shell. The
      // tradeoff is accepted: a full-screen TUI in the drawer cannot receive a
      // bare Escape, which is fine for a notes-app scratch terminal.
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current?.();
        return false;
      }
      // Ctrl+` (the Toggle Terminal key, from commands/keys.ts) closes the
      // drawer from inside it too, and the shell never sees the chord. Without
      // this, the key that opens the terminal does nothing while the terminal
      // has focus.
      if (matchesKey(keyOf("terminal.toggle")!, eventToChord(e))) {
        e.preventDefault();
        onCloseRef.current?.();
        return false;
      }
      const cmd = e.metaKey && !e.ctrlKey && !e.altKey;
      // preventDefault on the handled keys. An unhandled Cmd-key reaches
      // AppKit's key-equivalent path, which rings the system alert (the "blip")
      // even though the copy or paste itself succeeded.
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

    // The mount attaches, and every take-back attaches again. `replace` resets
    // the terminal first: the snapshot is the entire scrollback, so writing it
    // onto a terminal that already shows part of it would print the session
    // twice. After the reset the screen is rebuilt from the shell's history,
    // including everything it printed while another client had it.
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
        // The pty's grid follows the owner's window, so the resize is sent here
        // rather than at mount. Before the attach answers there is no shell to
        // size. After a take-back the shell may come from a client whose window
        // was a different size, so it has to be resized to this one.
        sendTerminalResize(sessionId, term.cols, term.rows);
        if (replace) term.focus();
        else onReady?.();
      });
    };
    takeBack.current = () => attach(true);
    attach(false);

    // The relink handler runs after a reconnect. Ownership survives the outage
    // (a client id outlives its connection, bun/server.ts `Term.owner`), and
    // the claim delivers what the dead wire dropped: the ring's bytes, a detach,
    // or an exit (rpc-schema TerminalClaim). The handler skips it unless `mine`:
    // a wire coming back is not somebody asking for the shell (remote.md §7).
    const offRelink = onTerminalRelink(() => {
      if (!mine) return;
      // The handler buffers output from here, as an attach does. This client is
      // still the owner, so live bytes are already arriving. A push that lands
      // while the claim is in flight would be written and then wiped by the
      // reset below, and it is too late to appear in a snapshot the server has
      // already taken.
      ready = false;
      void terminalClaim(sessionId).then((claim) => {
        if (disposed) return;
        if (claim.state === "attached") {
          // This branch writes the whole scrollback over a reset screen, as a
          // take-back does: the snapshot is the entire history, so writing it
          // onto what is already on screen would print the session twice. It
          // does not focus the terminal, unlike a take-back: nobody pressed
          // anything, and the caret may be in the note.
          onHost?.(claim.host);
          term.reset();
          const snapshot = b64ToBytes(claim.dataB64);
          if (snapshot.length) term.write(snapshot);
          for (const q of queue) term.write(q);
          queue.length = 0;
          ready = true;
          sendTerminalResize(sessionId, term.cols, term.rows);
          return;
        }
        // No output is coming for either state: the bytes go to the client that
        // has the shell, or there is no shell. The queue is dropped and writes
        // are re-enabled anyway, so a later take-back starts from empty.
        queue.length = 0;
        ready = true;
        // The shell moved to another client, or ended, while this client was
        // unreachable. Both pushes went nowhere, so they are delivered here by
        // hand through the paths that would have carried them: the notice, and
        // the exit App closes the drawer on.
        mine = false;
        if (claim.state === "held") setTakenBy(labelFor(claim.by));
        else dispatchTerminalExit(sessionId);
      }).catch(() => {
        // The wire went again mid-question, which is likelier here than
        // elsewhere: the claim is sent the moment a reconnect lands. An
        // unanswered question decides nothing, so the terminal is left as it
        // is. The next connection asks again (editor/bridge.ts reconcileRuns
        // does the same for a panel). Only the write gate reopens, or output
        // that comes back would queue behind an answer that is never coming.
        ready = true;
      });
    });

    // The detach handler runs when another client attached, which sends the
    // bytes there. It drops ownership so this client stops sending what Bun
    // would refuse, and the notice explains the terminal that stopped moving.
    const offDetached = onTerminalDetached((sid, by) => {
      if (sid !== sessionId) return;
      mine = false;
      setTakenBy(labelFor(by));
    });

    // The observer keeps the pty's winsize matched to the rendered grid, but
    // only while this client owns the shell.
    const ro = new ResizeObserver(() => {
      fit.fit();
      if (mine) sendTerminalResize(sessionId, term.cols, term.rows);
    });
    ro.observe(host);

    // The palette can move under a running terminal: "system" tracks the OS
    // live (lib/theme.ts). A pinned theme never fires this.
    const offAppearance = onAppearanceChange((a) => (term.options.theme = xtermTheme(a === "dark")));

    term.focus();

    return () => {
      disposed = true;
      terminalDetach(sessionId);
      ro.disconnect();
      offAppearance();
      off();
      offDetached();
      offRelink();
      dataSub.dispose();
      term.dispose();
    };
    // onReady is not a dep, and should not become one: the terminal is created
    // once per mount. App remounts (via key=sessionId) to switch notes, so
    // sessionId is fixed for a given mount and safe to close over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full" />
      {offline && (
        // The offline notice covers the terminal, and hides the take-back one
        // while the wire is down: from here, whether another device still holds
        // the shell is unknowable, and the take-back button could not send its
        // request anyway.

        // It has no Reconnect button of its own. The connection bar stays on
        // screen and is already that button, and it reports when the app dials
        // on its own (workspace/ConnectionBar.tsx). The take-back notice has a
        // button to press, this one has nothing, so it lets pointer events
        // through and the terminal's last output stays selectable and copyable.
        <div
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/85 px-4 text-center"
          data-testid="terminal-offline"
        >
          <p className="text-[12px] font-medium">Not connected to {activeConnection().name}.</p>
          <p className="max-w-[42ch] text-[11px] text-muted-foreground">
            Nothing typed here reaches the shell. This is the last thing it said, and the drawer catches up when the
            connection comes back.
          </p>
        </div>
      )}
      {!offline && takenBy !== null && (
        // The notice covers the terminal rather than replacing it. Underneath
        // is the last thing this shell said here, and it stays readable while
        // the notice explains why nothing has been added to it.
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/85 px-4 text-center"
          data-testid="terminal-taken"
        >
          {/* The label names the machine that has the shell when the presence
              list has one for it. "Another device" is the fallback for a client
              that gave no name. */}
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
