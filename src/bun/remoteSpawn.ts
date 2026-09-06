// Builds the ssh argv that puts a note's shell on a remote host
// (architecture.md §6a).
//
// The pty stays local. A remote shell is `ssh -t <host> '<preamble>; exec
// <shell> -l'` spawned as the pty's child, so it uses the same PtyProcess,
// drain loop, and marker parser as a local shell. ssh runs on a real tty.
// Passphrase prompts, host-key confirmations, and 2FA appear in the terminal
// and the user answers them there, as in any terminal. Ledge holds no
// credentials. Connection reuse is the user's ~/.ssh/config (ControlMaster).
//
// Only cwd and inline env cross the wire: cwd as a `cd` in the preamble, env
// (non-secret, per shared/frontmatter.ts) as exports. `profile` warns and is
// skipped, because profiles are how Ledge carries secrets and a secret on the
// remote command line would sit in that machine's process table for anyone
// with `ps` to read. `envFile` warns and is skipped, because it is a local
// path resolved against a cwd that is now a different machine's.
// bun/spawnParams.ts, the local sibling, degrades and warns the same way.
//
// The remote login shell parses the preamble (sshd hands it to `$SHELL -c`),
// so the preamble is POSIX and values ride in single quotes with the one
// POSIX escape. A non-POSIX remote login shell (fish, csh) works only for a
// note with no cwd or env preamble. §6a records that as an accepted limit.
// This file adds no shell-compatibility layer for it.
import { isEnvName, isHostName, LOCAL_HOST, type NoteParams } from "../shared/frontmatter";

// Fixed, not PATH-resolved: PtyProcess spawns via posix_spawn (no PATH
// search), and every macOS ships ssh here.
export const SSH_PATH = "/usr/bin/ssh";

export interface RemoteSpawn {
  executable: string;
  args: string[];
}

// Wraps `v` in single quotes so a POSIX shell interprets nothing inside it.
// A single quote inside `v` is escaped as '\''.
export function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * The ssh argv for one remote shell. `kind` picks the shell that runs over
 * there. "inline" execs `bash -l` every time: the marker protocol needs a
 * shell whose prompt hook markerInit can install (zsh or bash, bun/markers.ts)
 * and bash is the one ~every server has. "terminal" leaves the user's own
 * remote login shell alone, prompt and rc files intact.
 *
 * Throws when `host` fails isHostName or names the local host. The host
 * becomes argv for ssh, and an invalid one arriving here means the caller's
 * guard (resolveHost in bun/server.ts) let it through. Degrading instead
 * would run the block on a machine the note did not name.
 */
export function buildRemoteSpawn(
  host: string,
  kind: "inline" | "terminal",
  params: NoteParams | undefined,
  warn: (msg: string) => void,
): RemoteSpawn {
  if (!isHostName(host) || host === LOCAL_HOST) {
    throw new Error(`not an ssh destination: "${host}"`);
  }
  if (params?.profile) {
    warn(`profile "${params.profile}" is local-only; secrets are not sent to ${host}`);
  }
  if (params?.envFile) {
    warn(`envFile "${params.envFile}" is local-only; not read for ${host}`);
  }

  const parts: string[] = [];
  if (params?.cwd) parts.push(remoteCd(params.cwd));
  for (const [key, value] of Object.entries(params?.env ?? {})) {
    // Same guard as the local merge (spawnParams.ts). Re-checked here, not
    // just in the parser: these entries reach Bun over sessionConfigure from
    // the least-trusted end (architecture.md §2), and the parser's check is a
    // typo message for the honest path.
    if (isEnvName(key) && typeof value === "string") {
      parts.push(`export ${key}=${shellQuote(value)}`);
    } else {
      warn(`ignoring unusable env entry "${key}"`);
    }
  }

  if (kind === "inline") {
    parts.push("exec bash -l");
  } else if (parts.length > 0) {
    // Only needed when a preamble exists. Without one, ssh gets no command
    // argument and sshd starts the login shell itself. That is also the one
    // shape a non-POSIX login shell works in.
    parts.push(`exec "$SHELL" -l`);
  }

  // -t always. ssh allocates no remote pty of its own when it carries a
  // command, and with no command the flag is redundant rather than harmful.
  const args = ["-t", host];
  if (parts.length > 0) args.push(parts.join("; "));
  return { executable: SSH_PATH, args };
}

// The `cd` for the preamble. A tilde in single quotes does not expand, so ~
// paths are written to anchor on the remote `$HOME`, matching what the same
// note means locally (spawnParams.ts expandTilde). A missing directory falls
// back like the local one: the session starts in the remote $HOME and prints
// a message to the tty. The terminal drawer shows that message, and an inline
// shell's marker parser drops it as noise outside any block.
function remoteCd(cwd: string): string {
  const target = cwd === "~" ? '"$HOME"' : cwd.startsWith("~/") ? `"$HOME"/${shellQuote(cwd.slice(2))}` : shellQuote(cwd);
  return `cd -- ${target} 2>/dev/null || printf 'ledge: cwd %s not found here; starting in %s\\n' ${shellQuote(cwd)} "$PWD"`;
}
