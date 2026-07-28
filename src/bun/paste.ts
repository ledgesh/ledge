// When a queued block may be typed into a note's terminal drawer, and in which
// of the two wire formats.
//
// A block pasted into the drawer cannot just be written to the shell. A shell
// running a foreground job passes whatever arrives to that job's stdin, so a
// command written then does not queue politely: it feeds the running program
// and the user's command is gone. Pastes therefore wait for a prompt.
//
// The signal for "at a prompt" is the shell's own bracketed-paste mode. zsh and
// modern bash emit CSI ? 2004 h when the line editor is ready for input and CSI
// ? 2004 l the moment a job starts, which is exactly the state this needs, and
// index.ts tracks it live from the output stream.
//
// Not every shell has that mode, which is what the second rule is for. Pure so
// the whole policy is testable; index.ts owns the shell and the byte stream.

/** The bits of a drawer shell this policy reads. index.ts's Term satisfies it. */
export interface PasteShell {
  // The shell's live bracketed-paste mode: true only at an idle prompt.
  promptReady: boolean;
  // Whether that mode has EVER been seen. Distinguishes "busy" from "does not
  // speak the protocol", which look identical in a single moment.
  everReady: boolean;
  pasteQueue: string[];
  // When the shell last emitted anything; 0 while it has emitted nothing.
  lastOut: number;
}

/**
 * How long a shell that has never announced bracketed paste must be quiet
 * before a queued paste goes out anyway. Long enough to sit out a login banner
 * arriving in pieces, short enough that the button does not feel broken.
 */
export const QUIET_MS = 400;

/** A paste as a terminal emulator sends one: markers, then Enter. Trailing
 * newlines are trimmed so they do not add blank buffer lines. */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text.replace(/\n+$/, "")}\x1b[201~\r`;
}

/** The same text for a shell that does not speak the protocol, where the
 * markers would not be consumed but echoed as `^[[200~` noise. */
export function plainPaste(text: string): string {
  return `${text.replace(/\n+$/, "")}\r`;
}

/**
 * The bytes to write to `t` right now, or null to keep waiting. Takes the paste
 * off the queue and records the send, so one call yields at most one command:
 * releasing two would stack them inside the first one's run.
 *
 * Two ways a paste is released, in order of how much they know:
 *
 * 1. The shell is at a prompt it told us about. Sending submits the command,
 *    which ends prompt mode, so `promptReady` is cleared here rather than
 *    waited for in the output: the next paste needs the shell's NEXT prompt.
 * 2. The shell has never announced bracketed-paste mode and has gone quiet.
 *    bash only enables it from readline 8.1 (bash 5.1), so a remote shell on
 *    RHEL 7, Ubuntu 20.04 or Amazon Linux 2 never will, nor will anyone with
 *    `enable-bracketed-paste off` in their .inputrc. Without this rule those
 *    shells hold the queue forever and Run in Terminal does nothing at all,
 *    silently, on a shell sitting at a perfectly good prompt.
 *
 * Quiet output is a weaker signal than a prompt: a job that pauses without
 * printing looks the same as a shell waiting. That is why it is used only when
 * the real signal has never appeared, and why `lastOut` is stamped on release
 * rather than left for the echo to update, so the next paste waits out its own
 * quiet period instead of following on the first one's heels.
 */
export function takePaste(t: PasteShell, now: number): string | null {
  if (t.pasteQueue.length === 0) return null;
  if (t.promptReady) {
    t.promptReady = false;
    return bracketedPaste(t.pasteQueue.shift()!);
  }
  if (!t.everReady && t.lastOut !== 0 && now - t.lastOut >= QUIET_MS) {
    t.lastOut = now;
    return plainPaste(t.pasteQueue.shift()!);
  }
  return null;
}
