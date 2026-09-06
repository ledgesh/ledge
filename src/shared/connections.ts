// What a connection is, for the clients that hold one (remote.md §8).
//
// This file holds the facts about ssh itself, which both clients must answer
// the same way. `bun/connections.ts` holds the facts about a Mac's files: the
// stored list, Ledge's known_hosts, the argv, the keyscan. A phone has no ssh
// binary, no known_hosts and no path to a key (ios.md §4).
import { isHostName } from "./frontmatter";

/**
 * The id of the server in the client's own process. Reserved, never minted,
 * never stored. It lives in shared code because the id namespace is shared:
 * both clients key records by connection id, and the Mac files a client id per
 * connection under this one (bun/clientHome.ts). A phone has no local server,
 * so it must never mint a record wearing the id that names one.
 */
export const LOCAL_ID = "local";

/**
 * Which door a connection goes through (remote.md §4).
 *
 * `key` covers the two that need no secret from Ledge: a key file named by
 * `keyPath`, and a key the user's `ssh-agent` holds. `password` is the third,
 * and the only one where Ledge holds the user's credential. The mode is stored
 * rather than inferred from whether a secret exists, so a missing secret fails
 * with a reason instead of silently becoming a key connection that offers
 * nothing.
 */
export type AuthMode = "key" | "password";

/** The mode a stored value means, self-healing: anything other than the
 * password door is the key door. Every record written before this field
 * existed already opens at the key door. */
export function parseAuth(raw: unknown): AuthMode {
  return raw === "password" ? "password" : "key";
}

/**
 * Null when Ledge can deliver the password, otherwise the reason it cannot.
 *
 * The constraint is `SSH_ASKPASS`, not storage: ssh reads one line from the
 * helper and truncates at the first newline (remote.md §4). A password holding
 * a newline would reach the server truncated and be refused, with nothing
 * saying why. Ledge refuses every other control character too, since none can
 * be typed at the password prompt the helper stands in for.
 */
export function validatePassword(password: string): string | null {
  if (password === "") return "A password connection needs a password.";
  for (const ch of password) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return "A password cannot contain tabs, newlines, or other control characters.";
    }
  }
  return null;
}

/**
 * Checks a connection form and returns the first problem, or null when there
 * is none.
 *
 * The destination becomes argv for ssh, so `isHostName` validates it: the same
 * predicate guards a note's `host:` frontmatter (shared/frontmatter.ts). It
 * excludes option injection and the whitespace that would split one argument
 * into two. A phone always passes `keyPath: ""`: its key is in the Secure
 * Enclave and has no path, so its form never asks for one.
 */
export function validateConnection(fields: { name: string; destination: string; keyPath: string; port?: number }): string | null {
  const name = fields.name.trim();
  const destination = fields.destination.trim();
  if (!name) return "A connection needs a name.";
  if (!destination) return "A connection needs an ssh destination, like user@host.";
  if (!isHostName(destination)) {
    return `"${destination}" is not an ssh destination. Use a host, user@host, or a name from your ~/.ssh/config.`;
  }
  if (fields.keyPath.includes("\n")) return "A key path cannot contain a newline.";
  // PORT_UNSET passes. It is the ordinary answer, and it means "ssh decides"
  // rather than "no port was given and something is wrong".
  if (fields.port !== undefined && fields.port !== PORT_UNSET && !isPort(fields.port)) {
    return "A port is a whole number from 1 to 65535.";
  }
  return null;
}

/**
 * Where sshd listens, when it is not where ssh would look by itself.
 *
 * PORT_UNSET, not 22, is the "not specified" value. Unset puts no `-p` on the
 * argv and lets ssh decide. Every connection made before this field existed
 * behaved that way. Sending `-p 22` because a form defaulted to it would
 * override the `Port` in a `~/.ssh/config` alias (remote.md §4).
 */
export const PORT_UNSET = 0;
export const DEFAULT_PORT = 22;

export function isPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * A port from what somebody typed: the number, PORT_UNSET for an empty field,
 * or null for text that is not a port.
 *
 * Null and PORT_UNSET are different answers. An empty field means "ssh decides"
 * and is the ordinary case. "22x" is a typo, and it has to reach the user as a
 * refusal rather than becoming 22.
 */
export function parsePort(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return PORT_UNSET;
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return isPort(port) ? port : null;
}

/**
 * How a host is spelled in `known_hosts`, which is not how it is spelled to
 * ssh: a non-default port makes the entry `[host]:port`.
 *
 * Two places fail silently on the wrong spelling (remote.md §4). `ssh-keyscan
 * -p` writes the bracketed form, so a pin taken from a host is compared
 * against that form. ssh looks the host up in the same shape at connect time,
 * so it finds nothing for a pin stored unbracketed at a non-default port and
 * refuses the connection as an unknown host.
 */
export function knownHostsHost(destination: string, port: number): string {
  const host = hostPart(destination.trim());
  return port === PORT_UNSET || port === DEFAULT_PORT ? host : `[${host}]:${port}`;
}

// keyscan takes a host, not a destination. `deploy@prod` is a user and a host:
// only the host half identifies the host key, and the user half stays in the
// destination passed to ssh.
export function hostPart(destination: string): string {
  const at = destination.lastIndexOf("@");
  return at >= 0 ? destination.slice(at + 1) : destination;
}

/**
 * The host a pinned line belongs to: known_hosts' first field, which is what
 * `ssh-keyscan` printed when it was asked about that host.
 *
 * Empty for a phone's pins, which carry the key's two fields and no hostname.
 * A phone has no known_hosts file for a hostname to index (ios.md §3), so the
 * record itself is the index and `pinFitsHost` below cannot check those pins.
 */
export function pinnedHost(hostKeyLine: string): string {
  const fields = hostKeyLine.trim().split(/\s+/);
  return fields.length >= 3 ? (fields[0] ?? "") : "";
}

/**
 * Whether a pin still belongs to the address it is stored against.
 *
 * This matters when a connection is edited. A pin is a claim about one host at
 * one port (remote.md §4), so a new address invalidates it, and ssh would then
 * refuse every later connection with a message about a changed host key
 * (remote.md §8). The caller asks for the new host's fingerprint instead. This
 * check enforces that: a caller cannot skip it and connect on a stale pin.
 *
 * An empty pin fits every host. It means the user's own ssh already trusts the
 * host, and the pin is in the user's file rather than in Ledge's.
 */
export function pinFitsHost(hostKey: string, destination: string, port: number = PORT_UNSET): boolean {
  const host = pinnedHost(hostKey);
  return host === "" || host === knownHostsHost(destination, port);
}
