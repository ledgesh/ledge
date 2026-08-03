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
 * What a user typed, refused with a reason or accepted as a connection. The
 * destination becomes argv for ssh, so it is checked with the same predicate a
 * note's `host:` frontmatter is (shared/frontmatter.ts): what it excludes is
 * option injection and the whitespace that would split one argument into two.
 *
 * A phone passes `keyPath: ""` always. Its key is in the Secure Enclave and has
 * no path, which is a fact its form expresses by not asking.
 */
export function validateConnection(fields: { name: string; destination: string; keyPath: string }): string | null {
  const name = fields.name.trim();
  const destination = fields.destination.trim();
  if (!name) return "A connection needs a name.";
  if (!destination) return "A connection needs an ssh destination, like user@host.";
  if (!isHostName(destination)) {
    return `"${destination}" is not an ssh destination. Use a host, user@host, or a name from your ~/.ssh/config.`;
  }
  if (fields.keyPath.includes("\n")) return "A key path cannot contain a newline.";
  return null;
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
 * No pin fits everything: an empty one is the "your own ssh already trusts this
 * host" case, which is a pin too, in the user's file rather than Ledge's.
 */
export function pinFitsHost(hostKey: string, destination: string): boolean {
  const host = pinnedHost(hostKey);
  return host === "" || host === hostPart(destination.trim());
}
