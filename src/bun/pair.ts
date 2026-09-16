// `ledge pair`: this machine's pairing code, drawn as a QR code in the
// terminal (remote.md §4b). serve.ts reads the environment, the host key files
// and ssh-keygen's output; every decision about them is a pure function here.
import { encode } from "uqr";
import { DEFAULT_PORT, parsePort, PORT_UNSET } from "../shared/connections";
import { pairingLink, pairingProblem, PHONE_KEY_TYPES, QR_OPTIONS, type PairingCode } from "../shared/pairing";

export const KEYGEN_PATH = "/usr/bin/ssh-keygen";
export const HOST_KEY_DIR = "/etc/ssh";

export type PairArgs = { user?: string; host?: string; port?: string; keys?: string };

const FLAGS = ["user", "host", "port", "keys"] as const;

/** The flags after `pair`, as `--flag value` or `--flag=value`. */
export function parsePairArgs(args: readonly string[]): PairArgs | { error: string } {
  const out: PairArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf("=");
    const name = (eq < 0 ? arg : arg.slice(0, eq)).replace(/^--/, "");
    const flag = arg.startsWith("--") ? FLAGS.find((f) => f === name) : undefined;
    if (!flag) return { error: `pair does not take "${arg}".` };
    const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || value === "") return { error: `--${flag} needs a value.` };
    out[flag] = value;
  }
  return out;
}

/**
 * The server half of `SSH_CONNECTION` ("client-ip client-port server-ip
 * server-port"), which is an address that already reached this machine. Null
 * for loopback, which no phone can dial, and for IPv6, which a code cannot carry.
 */
export function sshServerAddress(sshConnection: string | undefined): { host: string; port: number } | null {
  const parts = (sshConnection ?? "").trim().split(/\s+/);
  if (parts.length !== 4) return null;
  const ip = parts[2]!.replace(/^::ffff:/i, "");
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || ip.startsWith("127.")) return null;
  const port = parsePort(parts[3]!);
  if (port === null || port === PORT_UNSET) return null;
  return { host: ip, port: port === DEFAULT_PORT ? PORT_UNSET : port };
}

export type AddressKind = "loopback" | "linkLocal" | "tailnet" | "private" | "public";

/**
 * What an IPv4 address is on the network, or null for anything else. RFC 1918
 * is private. 100.64/10 (RFC 6598) is a tailnet's: Tailscale gives every node
 * an address from it, and a home or cloud network never hands one out.
 */
export function addressKind(ip: string): AddressKind | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) return null;
  const [a, b, c, d] = match.slice(1).map(Number) as [number, number, number, number];
  if (a > 255 || b > 255 || c > 255 || d > 255) return null;
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "linkLocal";
  if (a === 100 && b >= 64 && b <= 127) return "tailnet";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  return "public";
}

/** The client half of `SSH_CONNECTION`: where the ssh session came from. Null when there is no session. */
export function sshClientAddress(sshConnection: string | undefined): string | null {
  const parts = (sshConnection ?? "").trim().split(/\s+/);
  if (parts.length !== 4) return null;
  const ip = parts[0]!.replace(/^::ffff:/i, "");
  return addressKind(ip) === null ? null : ip;
}

export type HostSource = "flag" | "tailnet" | "ssh" | "cloud" | "interface" | "name" | "typed";

/** One address a phone might dial, with where `pair` found it and what that says about its reach. */
export type Candidate = { host: string; source: HostSource; note: string };

/** What `tailscale status --json` says about this node, once `tailscaleSelf` has read it. */
export type TailnetSelf = { name: string | null; addresses: string[] };

/** What serve.ts reads for `addressCandidates`. Every field but the name may be missing on a given machine. */
export type CandidateInputs = {
  sshConnection?: string;
  hostname: string;
  tailnet?: TailnetSelf | null;
  cloudAddress?: string | null;
  interfaces: readonly { name: string; address: string }[];
};

// Interfaces whose addresses reach only containers or VMs on this machine.
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|lxc|lxd|cni|flannel|podman|vmnet|vboxnet)/;

const NOTES = {
  tailnetName: "this machine's tailnet name; a phone on the tailnet reaches it from anywhere",
  tailnetAddress: "this machine's tailnet address; a phone on the tailnet reaches it from anywhere",
  ssh: "the address this ssh session reached",
  sshInside: "the address this ssh session reached, inside a NAT the session came through; a phone outside needs the outside address",
  cloud: "this machine's public address, from the cloud's metadata service",
  public: (name: string) => `the public address on ${name}`,
  private: (name: string) => `the local network address on ${name}; a phone on that network reaches it`,
  name: "this machine's name; a phone on the same network may resolve it",
} as const;

/**
 * Every address this machine could be dialed at, best first, each one once
 * (remote.md §4b, "The candidates"). An ssh session from a public address to
 * a private one crossed a NAT, which drops the session's address below the
 * cloud's public one.
 */
export function addressCandidates(inputs: CandidateInputs): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (host: string, source: HostSource, note: string) => {
    const key = host.toLowerCase();
    if (host === "" || seen.has(key)) return;
    seen.add(key);
    out.push({ host, source, note });
  };

  if (inputs.tailnet?.name) add(inputs.tailnet.name, "tailnet", NOTES.tailnetName);
  for (const ip of inputs.tailnet?.addresses ?? []) if (addressKind(ip) === "tailnet") add(ip, "tailnet", NOTES.tailnetAddress);
  for (const i of inputs.interfaces) if (addressKind(i.address) === "tailnet") add(i.address, "tailnet", NOTES.tailnetAddress);

  const session = sshServerAddress(inputs.sshConnection);
  const client = sshClientAddress(inputs.sshConnection);
  const crossedNat = session !== null && addressKind(session.host) === "private" && client !== null && addressKind(client) === "public";
  const cloud = inputs.cloudAddress && addressKind(inputs.cloudAddress) === "public" ? inputs.cloudAddress : null;
  if (session && !crossedNat) add(session.host, "ssh", NOTES.ssh);
  if (cloud) add(cloud, "cloud", NOTES.cloud);
  if (session && crossedNat) add(session.host, "ssh", NOTES.sshInside);

  const usable = inputs.interfaces.filter((i) => !VIRTUAL_INTERFACE.test(i.name));
  for (const i of usable) if (addressKind(i.address) === "public") add(i.address, "interface", NOTES.public(i.name));
  for (const i of usable) if (addressKind(i.address) === "private") add(i.address, "interface", NOTES.private(i.name));

  add(inputs.hostname, "name", NOTES.name);
  return out;
}

/**
 * This node's MagicDNS name and tailnet addresses out of `tailscale status
 * --json`. Null when the output is not that, or the node is not connected.
 */
export function tailscaleSelf(json: string): TailnetSelf | null {
  let status: unknown;
  try {
    status = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof status !== "object" || status === null) return null;
  const { BackendState, Self } = status as { BackendState?: unknown; Self?: { DNSName?: unknown; TailscaleIPs?: unknown } };
  if (BackendState !== "Running" || typeof Self !== "object" || Self === null) return null;
  const name = typeof Self.DNSName === "string" ? Self.DNSName.replace(/\.$/, "") : "";
  const ips = Array.isArray(Self.TailscaleIPs) ? Self.TailscaleIPs : [];
  const addresses = ips.filter((ip): ip is string => typeof ip === "string" && addressKind(ip) === "tailnet");
  return { name: name === "" ? null : name, addresses };
}

// The cloud metadata services that answer with an instance's public IPv4
// address, all at the link-local address a cloud reserves for it. Amazon's
// is listed apart, since it wants a token first (serve.ts `cloudAddress`).
export const METADATA_ORIGIN = "http://169.254.169.254";
export const METADATA_PATHS: readonly { cloud: string; path: string; headers?: Record<string, string> }[] = [
  { cloud: "Google Cloud", path: "/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip", headers: { "Metadata-Flavor": "Google" } },
  {
    cloud: "Azure",
    path: "/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text",
    headers: { Metadata: "true" },
  },
  { cloud: "DigitalOcean", path: "/metadata/v1/interfaces/public/0/ipv4/address" },
  { cloud: "Hetzner", path: "/hetzner/v1/metadata/public-ipv4" },
];
export const AWS_TOKEN_PATH = "/latest/api/token";

// Where Linux exposes the machine's DMI strings, which name the cloud it runs in.
export const DMI_DIR = "/sys/class/dmi/id";
export const DMI_FIELDS = ["sys_vendor", "bios_version", "chassis_asset_tag"] as const;
const AZURE_ASSET_TAG = "7783-7084-3265-9085-8269-3286-77";

/**
 * Whether the DMI strings name a cloud whose metadata service `pair` asks. The
 * service's address is link-local, so off a cloud the request would go out on
 * the LAN for anything there to answer, and never gets sent (remote.md §4b).
 */
export function inCloud(dmi: Partial<Record<(typeof DMI_FIELDS)[number], string>>): boolean {
  const vendor = (dmi.sys_vendor ?? "").trim();
  if (/^(Amazon|Google|DigitalOcean|Hetzner)\b/i.test(vendor)) return true;
  if (/amazon/i.test(dmi.bios_version ?? "")) return true;
  return (dmi.chassis_asset_tag ?? "").trim() === AZURE_ASSET_TAG;
}

// Where the tailscale command is installed, rather than whatever a PATH holds
// under that name (KEYGEN_PATH is fixed for the same reason).
export const TAILSCALE_PATHS = [
  "/usr/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
] as const;
export const AWS_ADDRESS_PATH = "/latest/meta-data/public-ipv4";

/** A metadata service's answer as a public IPv4 address, or null for anything else (an error page, an empty body, a private address). */
export function publicAddressAnswer(body: string): string | null {
  const answer = body.trim();
  return addressKind(answer) === "public" ? answer : null;
}

/** The candidates as a numbered menu for the prompt, the note beside each host. */
export function candidateMenu(candidates: readonly Candidate[]): string {
  const width = Math.max(...candidates.map((c) => c.host.length));
  const lines = ["Which address should a phone dial?"];
  candidates.forEach((c, i) => lines.push(`  ${String(i + 1).padStart(2)}  ${c.host.padEnd(width)}  ${c.note}`));
  return `${lines.join("\n")}\n`;
}

export const CHOICE_PROMPT = "A number, or an address as host or host:port [1]";

export type PairAddress = { host: string; port: number; source: HostSource; note: string } | { error: string };

/**
 * Where a phone dials. `--host` first; then the answer to the menu, which is a
 * number from it or a typed address; then the first candidate. The port is
 * `--port`, else the one typed after a colon, else the ssh session's, else 22.
 */
export function pairAddress(
  args: PairArgs,
  sshConnection: string | undefined,
  candidates: readonly Candidate[],
  answer?: string,
): PairAddress {
  const session = sshServerAddress(sshConnection);
  let port = session?.port ?? PORT_UNSET;
  let host: string;
  let source: HostSource;
  let note = "";
  if (args.host !== undefined) {
    host = args.host;
    source = "flag";
  } else if (answer !== undefined && answer.trim() !== "") {
    const typed = answer.trim();
    if (/^\d+$/.test(typed)) {
      const pick = candidates[Number(typed) - 1];
      if (!pick) return { error: `There is no address ${typed} in the list.` };
      ({ host, source, note } = pick);
    } else {
      const colon = typed.indexOf(":");
      host = colon < 0 ? typed : typed.slice(0, colon);
      source = "typed";
      if (colon >= 0) {
        const parsed = parsePort(typed.slice(colon + 1));
        if (parsed === null || parsed === PORT_UNSET) return { error: `"${typed.slice(colon + 1)}" is not a port from 1 to 65535.` };
        port = parsed === DEFAULT_PORT ? PORT_UNSET : parsed;
      }
    }
  } else {
    const pick = candidates[0];
    if (!pick) return { error: "This machine has no address a phone could dial. Run again with --host." };
    ({ host, source, note } = pick);
  }
  if (args.port !== undefined) {
    const parsed = parsePort(args.port);
    if (parsed === null || parsed === PORT_UNSET) return { error: `"${args.port}" is not a port from 1 to 65535.` };
    port = parsed === DEFAULT_PORT ? PORT_UNSET : parsed;
  }
  return { host, port, source, note };
}

export type HostKey = { fingerprint: string; keyType: string };

/**
 * The host keys a phone can check (shared/pairing.ts PHONE_KEY_TYPES), out of
 * `ssh-keygen -lf` output: `256 SHA256:… comment (ED25519)`. An RSA fingerprint
 * would make the code bigger and could never match.
 */
export function phoneHostKeys(keygenOutput: string): HostKey[] {
  const keys: HostKey[] = [];
  const types: readonly string[] = PHONE_KEY_TYPES;
  for (const line of keygenOutput.split("\n")) {
    const match = /^\d+ (SHA256:\S+) .*\(([A-Z0-9-]+)\)\s*$/.exec(line.trim());
    if (!match || !types.includes(match[2]!)) continue;
    if (!keys.some((k) => k.fingerprint === match[1])) keys.push({ fingerprint: match[1]!, keyType: match[2]! });
  }
  return keys.sort((a, b) => types.indexOf(a.keyType) - types.indexOf(b.keyType));
}

/** The host-side command for a server in a container, which has no host keys or account of its own to read. */
export const CONTAINER_COMMAND =
  'cat /etc/ssh/ssh_host_*_key.pub | docker exec -i ledge ledge pair --user "$USER" --host <address> --keys -';

/** Why `pair` cannot use a container's own account, name and keys, or null when the flags replace all three. */
export function containerRefusal(args: PairArgs): string | null {
  if (args.user !== undefined && args.host !== undefined && args.keys !== undefined) return null;
  return [
    "The server is running in a container, so its account, name and host keys are the container's.",
    "A phone signs in to the machine that runs the container. On that machine, run:",
    "",
    `  ${CONTAINER_COMMAND}`,
  ].join("\n");
}

const DARK_ON_LIGHT = "\x1b[30;107m";
const RESET = "\x1b[0m";

/**
 * A QR code as terminal lines, two modules to a line with half blocks. The
 * colors are set rather than left to the terminal's theme, so the code is dark
 * on light on every background, quiet zone included (shared/pairing.ts
 * QR_OPTIONS).
 */
export function terminalQR(text: string): string[] {
  const { data, size } = encode(text, QR_OPTIONS);
  const lines: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let line = "";
    for (let x = 0; x < size; x++) {
      const top = data[y]![x]!;
      const bottom = data[y + 1]?.[x] ?? false;
      line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    lines.push(`${DARK_ON_LIGHT}${line}${RESET}`);
  }
  return lines;
}

/** How many terminal columns `terminalQR` needs for this text. */
export function terminalQRWidth(text: string): number {
  return encode(text, QR_OPTIONS).size;
}

/** The candidates a run without a terminal did not use, for stderr: a network's layout is talk, not the code. */
export function othersNote(others: readonly Candidate[]): string {
  if (others.length === 0) return "";
  const width = Math.max(...others.map((c) => c.host.length));
  const lines = ["Other addresses this machine has (run again with --host to use one):"];
  for (const c of others) lines.push(`  ${c.host.padEnd(width)}  ${c.note}`);
  return `${lines.join("\n")}\n`;
}

export type PairReport = { code: PairingCode; keys: HostKey[]; note: string; columns?: number };

/** Everything `pair` prints: the code, what it says in words, and the link. Throws on a code `pairingProblem` refuses. */
export function pairReport({ code, keys, note, columns }: PairReport): string {
  const link = pairingLink(code);
  const width = terminalQRWidth(link);
  const out: string[] = [];
  if (columns !== undefined && columns < width) {
    out.push(`This terminal is ${columns} columns wide, and the code needs ${width}. Widen it and run pair again.`);
  } else {
    out.push(...terminalQR(link));
  }
  out.push(
    "",
    "Scan the code with Ledge on your phone. It names this server and its host keys, and holds no password or key.",
    "",
    `  Account    ${code.user}`,
    `  Host       ${code.host}${note === "" ? "" : ` (${note})`}`,
    `  Port       ${code.port === PORT_UNSET ? DEFAULT_PORT : code.port}`,
    ...keys.map((k, i) => `  ${i === 0 ? "Host keys" : "         "}  ${k.fingerprint} (${k.keyType})`),
    "",
    link,
  );
  return `${out.join("\n")}\n`;
}

/** The code for these fields, or the sentence that says why there is none. */
export function pairCode(user: string, address: { host: string; port: number }, keys: HostKey[]): PairingCode | { error: string } {
  const code: PairingCode = { user, host: address.host, port: address.port, fingerprints: keys.map((k) => k.fingerprint) };
  const problem = pairingProblem(code);
  return problem ? { error: problem } : code;
}
