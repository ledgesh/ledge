// `ledge-server pair`: this machine's pairing code, drawn as a QR code in the
// terminal (remote.md §4b). serve.ts reads the environment, the host key files
// and ssh-keygen's output; every decision about them is a pure function here.
import { encode } from "uqr";
import { DEFAULT_PORT, parsePort, PORT_UNSET } from "../shared/connections";
import { pairingLink, pairingProblem, type PairingCode } from "../shared/pairing";

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

export type HostFrom = "flag" | "ssh" | "name";

export type PairAddress = { host: string; port: number; hostFrom: HostFrom } | { error: string };

/** Where a phone dials: the flags first, then the ssh session's address, then the machine's name. */
export function pairAddress(args: PairArgs, sshConnection: string | undefined, hostname: string): PairAddress {
  const session = sshServerAddress(sshConnection);
  let port = session?.port ?? PORT_UNSET;
  if (args.port !== undefined) {
    const parsed = parsePort(args.port);
    if (parsed === null || parsed === PORT_UNSET) return { error: `"${args.port}" is not a port from 1 to 65535.` };
    port = parsed === DEFAULT_PORT ? PORT_UNSET : parsed;
  }
  if (args.host !== undefined) return { host: args.host, port, hostFrom: "flag" };
  if (session) return { host: session.host, port, hostFrom: "ssh" };
  return { host: hostname, port, hostFrom: "name" };
}

export type HostKey = { fingerprint: string; keyType: string };

// NIOSSH checks only these (ios.md §3), so an RSA fingerprint would make the
// code bigger and could never match. Ed25519 comes first, as NIOSSH offers it.
const PHONE_KEY_TYPES = ["ED25519", "ECDSA"];

/** The host keys a phone can check, out of `ssh-keygen -lf` output: `256 SHA256:… comment (ED25519)`. */
export function phoneHostKeys(keygenOutput: string): HostKey[] {
  const keys: HostKey[] = [];
  for (const line of keygenOutput.split("\n")) {
    const match = /^\d+ (SHA256:\S+) .*\(([A-Z0-9-]+)\)\s*$/.exec(line.trim());
    if (!match || !PHONE_KEY_TYPES.includes(match[2]!)) continue;
    if (!keys.some((k) => k.fingerprint === match[1])) keys.push({ fingerprint: match[1]!, keyType: match[2]! });
  }
  return keys.sort((a, b) => PHONE_KEY_TYPES.indexOf(a.keyType) - PHONE_KEY_TYPES.indexOf(b.keyType));
}

/** The host-side command for a server in a container, which has no host keys or account of its own to read. */
export const CONTAINER_COMMAND =
  'cat /etc/ssh/ssh_host_*_key.pub | docker exec -i ledge ledge-server pair --user "$USER" --host <address> --keys -';

/** Why `pair` cannot use a container's own account, name and keys, or null when the flags replace all three. */
export function containerRefusal(args: PairArgs): string | null {
  if (args.user !== undefined && args.host !== undefined && args.keys !== undefined) return null;
  return [
    "ledge-server is running in a container, so its account, name and host keys are the container's.",
    "A phone signs in to the machine that runs the container. On that machine, run:",
    "",
    `  ${CONTAINER_COMMAND}`,
  ].join("\n");
}

// Error correction is boosted as far as the smallest version allows. The
// quiet zone is the four modules the QR standard asks for, drawn in the light
// color because the terminal around it may be dark.
export const QR_OPTIONS = { ecc: "L", boostEcc: true, border: 4 } as const;

const DARK_ON_LIGHT = "\x1b[30;107m";
const RESET = "\x1b[0m";

/**
 * A QR code as terminal lines, two modules to a line with half blocks. The
 * colors are set rather than left to the terminal's theme, so the code is dark
 * on light on every background.
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

export type PairReport = { code: PairingCode; keys: HostKey[]; hostFrom: HostFrom; columns?: number };

const HOST_NOTES: Record<HostFrom, string> = {
  flag: "",
  ssh: " (the address this ssh session reached)",
  name: " (this machine's name; if your phone cannot reach it by that name, run again with --host)",
};

/** Everything `pair` prints: the code, what it says in words, and the link. Throws on a code `pairingProblem` refuses. */
export function pairReport({ code, keys, hostFrom, columns }: PairReport): string {
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
    `  Host       ${code.host}${HOST_NOTES[hostFrom]}`,
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
