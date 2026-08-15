// What a connection is, for the clients that hold one (remote.md §8).
//
// Only the part that is a fact about ssh rather than about a machine's files.
// `bun/connections.ts` has the rest — the stored list, Ledge's known_hosts, the
// argv, the keyscan — because every one of those is a Mac's, and a phone has no
// ssh binary, no known_hosts and no path to a key (ios.md §4).
//
// What is left is here because BOTH clients need it and must agree: the Mac
// manages its list in Bun and the phone manages its in the webview, and two
// implementations of "is that an ssh destination" would be two answers to a
// question about the same string.
import { isHostName } from "./frontmatter";

/**
 * The id of the server in the client's own process. Reserved, never minted,
 * never stored.
 *
 * Here rather than beside the stored list because it is a fact about the
 * NAMESPACE the list is keyed in, and both clients key things by connection id:
 * the Mac files a client id per connection under it (bun/clientHome.ts), and a
 * phone that has no local server still must not mint a record wearing the one
 * id that names one.
 */
export const LOCAL_ID = "local";

/**
 * What a user typed, refused with a reason or accepted as a connection. The
 * destination becomes argv for ssh, so it is checked with the same predicate a
 * note's `host:` frontmatter is (shared/frontmatter.ts): what it excludes is
 * option injection and the whitespace that would split one argument into two.
 *
 * A phone passes `keyPath: ""` always. Its key is in the Secure Enclave and has
 * no path, which is a fact its form expresses by not asking.
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
  // PORT_UNSET passes: it is the ordinary answer, and it means "ssh decides"
  // rather than "no port was given and something is wrong".
  if (fields.port !== undefined && fields.port !== PORT_UNSET && !isPort(fields.port)) {
    return "A port is a whole number from 1 to 65535.";
  }
  return null;
}

/**
 * Where sshd listens, when it is not where ssh would look by itself.
 *
 * PORT_UNSET rather than 22 is the "not specified" value, and the difference is
 * not cosmetic: a destination may be a `~/.ssh/config` alias carrying its own
 * `Port`, and passing `-p 22` because a form defaulted to it would override the
 * user's own configuration with our guess. Unset means no `-p` on the argv and
 * ssh decides, which is what every connection made before this field existed
 * did.
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
 * Null and PORT_UNSET are different answers on purpose. An empty field means
 * "you decide" and is the ordinary case; "22x" is a typo that has to reach the
 * user as a refusal rather than becoming 22.
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
 * It matters twice, and getting it wrong is silent both times. `ssh-keyscan -p`
 * writes the bracketed form, so a pin taken from one host is compared against
 * the bracketed form; and ssh looks the host up in that same shape at connect
 * time, so a pin stored unbracketed for a non-default port matches nothing and
 * refuses every connection with a message about an unknown host.
 */
export function knownHostsHost(destination: string, port: number): string {
  const host = hostPart(destination.trim());
  return port === PORT_UNSET || port === DEFAULT_PORT ? host : `[${host}]:${port}`;
}

// keyscan takes a host, not a destination: `deploy@prod` is a user and a host,
// and the user half is ssh's business, not the host key's.
export function hostPart(destination: string): string {
  const at = destination.lastIndexOf("@");
  return at >= 0 ? destination.slice(at + 1) : destination;
}

/**
 * The host a pinned line belongs to: known_hosts' first field, which is what
 * `ssh-keyscan` printed when it was asked about that host.
 *
 * Empty for the phone's pins, which are the key's two fields and no hostname —
 * there is no known_hosts file on a phone for a hostname to index (ios.md §3),
 * so the record itself is the index and `pinFitsHost` below cannot check them.
 */
export function pinnedHost(hostKeyLine: string): string {
  const fields = hostKeyLine.trim().split(/\s+/);
  return fields.length >= 3 ? (fields[0] ?? "") : "";
}

/**
 * Whether a pin still belongs to the address it is stored against.
 *
 * The case is editing a connection: a pin is a claim about one host, so moving
 * a connection to another machine invalidates it, and keeping it would refuse
 * every future connection with a message about a CHANGED host key — the most
 * alarming possible wording for "you edited the address". The caller's job is
 * to ask for the new host's fingerprint instead (remote.md §4); this is the
 * check that makes forgetting to impossible rather than unlikely.
 *
 * The PORT is part of the claim, because it is part of the known_hosts key: two
 * sshd instances on one machine are two hosts as far as pinning is concerned,
 * and they really can offer different keys.
 *
 * No pin fits everything: an empty one is the "your own ssh already trusts this
 * host" case, which is a pin too, in the user's file rather than Ledge's.
 */
export function pinFitsHost(hostKey: string, destination: string, port: number = PORT_UNSET): boolean {
  const host = pinnedHost(hostKey);
  return host === "" || host === knownHostsHost(destination, port);
}
