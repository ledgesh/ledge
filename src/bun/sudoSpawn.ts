// Builds the sudo half of a spawn for a note with a `sudo:` line
// (architecture.md §6a).
//
// sudo is what the pty spawns locally, and what the ssh preamble execs
// remotely (bun/remoteSpawn.ts). It then execs the note's shell as the named
// user. The shell is never started first and switched afterwards: the marker
// hook (bun/markers.ts) has to land in the shell that runs the blocks, and a
// `sudo -i` typed into a running shell replaces it with one that has no hook.
//
// sudo resets the environment, so the note's inline env is exported by a
// /bin/sh script that sudo runs ahead of the exec. That script is argv, which
// `ps` shows to every user, so only inline env (non-secret by definition)
// crosses. `profile` and `envFile` are skipped with a warning, the rule the
// ssh preamble follows for the same reason. cwd needs no line in the script:
// sudo runs its command in the directory it was started in.
import { isEnvName, isSudoUser } from "../shared/frontmatter";
import { markerUp } from "./markers";
import { shellQuote } from "./shellQuote";

/**
 * sudo's arguments for running `exec` as `user` with `env` exported. `exec` is
 * shell text, quoted by the caller. A `nonce` adds the markerUp printf ahead
 * of the exec, the signal inlinePool.ts waits for before it writes a block.
 * The terminal drawer passes null, because it already waits for the shell's
 * own prompt (bun/server.ts, promptReady).
 *
 * Throws when `user` fails isSudoUser. The name arrives over sessionConfigure
 * from the least-trusted end (architecture.md §2), and degrading would run the
 * note's blocks as a user it did not name.
 */
export function sudoArgs(
  user: string,
  env: Record<string, string>,
  exec: string,
  nonce: string | null,
  warn: (msg: string) => void,
): string[] {
  if (typeof user !== "string" || !isSudoUser(user)) throw new Error(`not a user name: "${String(user)}"`);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    // The parser's check again, on the RPC path (spawnParams.ts does the same).
    if (isEnvName(key) && typeof value === "string") parts.push(`export ${key}=${shellQuote(value)}`);
    else warn(`ignoring unusable env entry "${key}"`);
  }
  if (nonce !== null) parts.push(markerUp(nonce));
  parts.push(`exec ${exec}`);
  return ["-u", user, "--", "/bin/sh", "-c", parts.join("; ")];
}
