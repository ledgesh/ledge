// Builds the ssh argv that puts a note's shell on a remote host.
//
// The move that keeps this small: the PTY stays local. A remote shell is just
// `ssh -t <host> '<preamble>; exec <shell> -l'` spawned as the pty's child —
// the same PtyProcess, drain loop, and marker parser as any local shell, with
// ssh carrying the bytes. Auth is deliberately not Ledge's business: ssh runs
// on a real tty, so passphrase prompts, host-key confirmations, and 2FA render
// in the terminal and the user answers them there, exactly as they would in
// any terminal. Connection reuse is the user's ~/.ssh/config (ControlMaster),
// not ours.
//
// What crosses the wire is deliberately narrow. cwd and inline env do — cwd
// as a `cd` in the preamble, env (documented non-secret in
// shared/frontmatter.ts) as exports. `profile` and `envFile` deliberately do
// NOT: profiles are the secrets story, and a secret placed on the remote
// command line would sit in the remote machine's process table for anyone
// with `ps` to read; envFile is a local file resolved against a cwd that is
// now a different machine's. Both warn and are skipped — same degrade-and-warn
// posture as bun/spawnParams.ts, whose local resolution this module is the
// remote sibling of.
//
// The preamble is POSIX and is parsed by the REMOTE user's login shell (sshd
// gives it to `$SHELL -c`), which is why values ride in single quotes with the
// one POSIX escape. A remote login shell that is not POSIX (fish, csh) works
// only for a note with no cwd/env — such notes send no command at all — which
// is the documented limit, not a guessed-at compatibility layer.
import { isEnvName, isHostName, LOCAL_HOST, type NoteParams } from "../shared/frontmatter";

// Fixed, not PATH-resolved: PtyProcess spawns via posix_spawn (no PATH
// search), and every macOS ships ssh here.
export const SSH_PATH = "/usr/bin/ssh";

export interface RemoteSpawn {
  executable: string;
  args: string[];
}

// Single-quote `v` for a POSIX shell: inert whatever it holds, with the one
// escape ('\'') for the quote itself.
export function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * The ssh argv for one remote shell. `kind` decides the shell that ends up
 * running over there: inline shells exec `bash -l` unconditionally — the
 * marker protocol needs a shell whose prompt hook markerInit can install
 * (zsh or bash), and bash is the one ~every server has — while the terminal
 * drawer is the user's own remote login shell, prompt and rc files intact.
 *
 * Throws on a host that fails isHostName: the name becomes argv for ssh, and
 * an invalid one reaching this far is a bug in the caller's guard
 * (bun/index.ts resolveHost), not note data to degrade around — degrading
 * would mean running the block somewhere the note did not name.
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
    // Same guard as the local merge (spawnParams.ts): the honest path was
    // validated by the parser; this is the RPC path.
    if (isEnvName(key) && typeof value === "string") {
      parts.push(`export ${key}=${shellQuote(value)}`);
    } else {
      warn(`ignoring unusable env entry "${key}"`);
    }
  }

  if (kind === "inline") {
    parts.push("exec bash -l");
  } else if (parts.length > 0) {
    // Only needed when a preamble exists: with no command at all, sshd runs
    // the login shell itself — the cleanest session, and the one shape that
    // also works for non-POSIX login shells.
    parts.push(`exec "$SHELL" -l`);
  }

  // -t always: with a remote command ssh does not allocate a remote pty on
  // its own, and without one it is redundant, not harmful.
  const args = ["-t", host];
  if (parts.length > 0) args.push(parts.join("; "));
  return { executable: SSH_PATH, args };
}

// `cd` for the preamble. Quoted tilde does not expand, so ~ paths anchor to
// the REMOTE $HOME explicitly — `cwd: ~/proj` must mean that machine's home,
// matching what the same note means locally (spawnParams.ts expandTilde).
// A missing dir degrades like the local fallback does: the session opens in
// the remote $HOME with a message saying so — printed to the tty, so the
// terminal drawer shows it (an inline shell's marker parser drops it as
// outside-block noise, which is the price of the shell still spawning).
function remoteCd(cwd: string): string {
  const target = cwd === "~" ? '"$HOME"' : cwd.startsWith("~/") ? `"$HOME"/${shellQuote(cwd.slice(2))}` : shellQuote(cwd);
  return `cd -- ${target} 2>/dev/null || printf 'ledge: cwd %s not found here; starting in %s\\n' ${shellQuote(cwd)} "$PWD"`;
}
