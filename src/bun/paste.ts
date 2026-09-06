// When a queued block may be typed into a note's terminal drawer, and in which
// of the two wire formats.
//
// A block cannot be written to the shell unconditionally. A shell running a
// foreground job hands whatever arrives to that job's stdin, so the block runs
// as input to that program and the command is gone. Pastes wait for a prompt.
//
// The signal for "at a prompt" is the shell's own bracketed-paste mode. zsh and
// modern bash emit CSI ? 2004 h when the line editor is ready for input and CSI
// ? 2004 l when a job starts. server.ts tracks that mode live from the output
// stream. Shells that lack the mode are covered by the second rule in takePaste
// below. This module does no I/O and touches no pty, so the policy can be
// tested on a plain object. server.ts owns the shell and the byte stream.

/** The shell fields this policy reads. server.ts's Term satisfies it. */
export interface PasteShell {
  // The shell's live bracketed-paste mode: true only at an idle prompt.
  promptReady: boolean;
  // Whether that mode has ever been seen. In a single moment a busy shell and
  // a shell with no bracketed-paste mode look the same. This tells them apart.
  everReady: boolean;
  pasteQueue: string[];
  // When the shell last emitted anything; 0 while it has emitted nothing.
  lastOut: number;
}

/**
 * How long a shell that has never announced bracketed-paste mode must be quiet
 * before a queued paste goes out anyway. Long enough to sit out a login banner
 * arriving in pieces, short enough that the Run button does not seem broken.
 */
export const QUIET_MS = 400;

/** The text wrapped in bracketed-paste markers and followed by Enter, the way
 * a terminal emulator sends a paste. Trailing newlines are trimmed so they do
 * not add blank buffer lines. */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text.replace(/\n+$/, "")}\x1b[201~\r`;
}

/** The same text with Enter but no markers, for a shell that has no
 * bracketed-paste mode. Such a shell echoes the markers as `^[[200~` noise
 * instead of consuming them. */
export function plainPaste(text: string): string {
  return `${text.replace(/\n+$/, "")}\r`;
}

/**
 * The bytes to write to `t` now, or null to keep waiting. Takes the paste off
 * the queue and records the send, so one call releases at most one command.
 * Releasing two would stack them inside the first one's run.
 *
 * A paste goes out on either of two signals. The prompt is the stronger one,
 * so it is checked first.
 *
 * 1. The shell is at a prompt it announced. Sending submits the command, which
 *    ends prompt mode, so `promptReady` is cleared here rather than waited for
 *    in the output. The next paste needs the shell's next prompt.
 * 2. The shell has never announced bracketed-paste mode and has been quiet for
 *    QUIET_MS. The rule needs some output first: `lastOut` is 0 until the shell
 *    has printed anything. bash enables the mode only from readline 8.1 (bash
 *    5.1). A remote shell on RHEL 7, Ubuntu 20.04 or Amazon Linux 2 is older
 *    than that. A shell with `enable-bracketed-paste off` in .inputrc has the
 *    mode turned off. Without this rule those shells hold the queue forever,
 *    and Run Block in Terminal silently does nothing on a shell sitting at a
 *    working prompt.
 *
 * Quiet output is the weaker signal. A job that pauses without printing looks
 * the same as a shell waiting for input, so the rule applies only when the
 * prompt signal has never appeared. The release stamps `lastOut` itself instead
 * of waiting for the shell to echo the pasted text, so the next paste waits out
 * its own quiet period.
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
