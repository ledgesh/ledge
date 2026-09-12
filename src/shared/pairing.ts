// The pairing code: a link naming a server and the host keys it offers, which a
// phone reads to pair without typing. It carries no credential. The phone's
// reader is ios/Sources/PairingCode.swift, and pairing.vectors.json holds the
// two readers to one answer (remote.md §4b).
import { DEFAULT_PORT, PORT_UNSET, isPort } from "./connections";

export const PAIRING_VERSION = 1;

/** Where a code points. The fragment carries the fields, so ledge.sh never receives them. */
export const PAIRING_LINK = "https://ledge.sh/pair";

/** The same code through the app's own URL scheme. */
export const PAIRING_SCHEME_LINK = "ledge://pair";

export const MAX_FINGERPRINTS = 4;

export type PairingCode = {
  /** The account Ledge signs in as. */
  user: string;
  /** A host name or an IPv4 address. */
  host: string;
  /** PORT_UNSET for sshd's default, which is how both clients store port 22. */
  port: number;
  /** `SHA256:…` as `ssh-keygen -lf` prints it, one per host key the server offers. */
  fingerprints: string[];
};

export type PairingParse = { code: PairingCode } | { problem: string };

export const PAIRING_PROBLEMS = {
  notACode: "This is not a Ledge pairing code.",
  newer: "This pairing code needs a newer version of Ledge. Update the app, then try the code again.",
  version: "The pairing code's version is not one Ledge recognizes.",
  encoding: "The pairing code has a damaged character in it.",
  user: "The pairing code has no valid account name.",
  host: "The pairing code has no valid host name or IP address.",
  port: "The pairing code's port is not a whole number from 1 to 65535.",
  noFingerprint: "The pairing code has no host key fingerprint.",
  fingerprint: "The pairing code has a host key fingerprint that is not a SHA256 fingerprint.",
  tooManyFingerprints: `The pairing code names more than ${MAX_FINGERPRINTS} host keys.`,
  repeated: (field: string) => `The pairing code gives the ${field} more than once.`,
};

// ASCII only, and not starting with "-" or ".", so neither half of `user@host`
// can become an ssh option. IPv6 is out: the phone refuses a colon in a
// destination (ShellConfig.swift `problem(with:)`).
const USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const HOST = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,252}$/;
// 32 bytes as unpadded base64 is 43 characters, and the last one holds only
// four bits, so it is one of these sixteen.
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$/;

/** The first problem with a code's fields, or null when a link can be made from them. */
export function pairingProblem(code: PairingCode): string | null {
  const P = PAIRING_PROBLEMS;
  if (!USER.test(code.user)) return P.user;
  if (!HOST.test(code.host)) return P.host;
  if (code.port !== PORT_UNSET && !isPort(code.port)) return P.port;
  if (code.fingerprints.length === 0) return P.noFingerprint;
  if (!code.fingerprints.every((fp) => FINGERPRINT.test(fp))) return P.fingerprint;
  if (new Set(code.fingerprints).size > MAX_FINGERPRINTS) return P.tooManyFingerprints;
  return null;
}

/** The link for a code. Throws on a code `pairingProblem` refuses, so check that first. */
export function pairingLink(code: PairingCode): string {
  const problem = pairingProblem(code);
  if (problem) throw new Error(problem);
  const fields = [`v=${PAIRING_VERSION}`, `u=${code.user}`, `h=${code.host}`];
  if (code.port !== PORT_UNSET && code.port !== DEFAULT_PORT) fields.push(`p=${code.port}`);
  // Every other character the fields allow is literal in a fragment. A plus is
  // too, but URLSearchParams reads one as a space.
  for (const fp of new Set(code.fingerprints)) fields.push(`k=${fp.replaceAll("+", "%2B")}`);
  return `${PAIRING_LINK}#${fields.join("&")}`;
}

/**
 * The code a scanned or pasted link carries, or the reason it carries none.
 *
 * The version is read before anything else, so a later format with a different
 * grammar is reported as newer rather than as damaged. The steps are in
 * remote.md §4b, and PairingCode.swift takes them in the same order.
 */
export function parsePairingLink(text: string): PairingParse {
  const P = PAIRING_PROBLEMS;
  const trimmed = text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  const hash = trimmed.indexOf("#");
  if (hash < 0) return { problem: P.notACode };
  const base = asciiLowercase(trimmed.slice(0, hash));
  if (base !== PAIRING_LINK && base !== PAIRING_SCHEME_LINK) return { problem: P.notACode };

  const fields = trimmed
    .slice(hash + 1)
    .split("&")
    .filter((segment) => segment !== "")
    .map((segment) => {
      const eq = segment.indexOf("=");
      return eq < 0 ? { key: segment, raw: "" } : { key: segment.slice(0, eq), raw: segment.slice(eq + 1) };
    });
  const raws = (key: string): string[] => fields.filter((f) => f.key === key).map((f) => f.raw);

  const versions = raws("v");
  if (versions.length === 0) return { problem: P.notACode };
  if (versions.length > 1) return { problem: P.repeated("version") };
  if (!/^[1-9][0-9]{0,5}$/.test(versions[0]!)) return { problem: P.version };
  if (Number(versions[0]) > PAIRING_VERSION) return { problem: P.newer };

  for (const [key, name] of [["u", "account name"], ["h", "host"], ["p", "port"]] as const) {
    if (raws(key).length > 1) return { problem: P.repeated(name) };
  }
  const decoded = new Map<string, string[]>();
  for (const key of ["u", "h", "p", "k"]) {
    const values = raws(key).map(percentDecoded);
    if (values.includes(null)) return { problem: P.encoding };
    decoded.set(key, values as string[]);
  }

  const code: PairingCode = {
    user: decoded.get("u")![0] ?? "",
    host: decoded.get("h")![0] ?? "",
    port: portField(decoded.get("p")![0]),
    fingerprints: [...new Set(decoded.get("k")!)],
  };
  const problem = pairingProblem(code);
  return problem ? { problem } : { code };
}

// -1 for text that is not a port, so `pairingProblem` reports it in its turn
// and a code with two bad fields names the same one in both readers.
function portField(text: string | undefined): number {
  if (text === undefined) return PORT_UNSET;
  if (!/^[0-9]{1,5}$/.test(text) || !isPort(Number(text))) return -1;
  return Number(text) === DEFAULT_PORT ? PORT_UNSET : Number(text);
}

function asciiLowercase(text: string): string {
  return text.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

// Only escapes of ASCII bytes. Every field is ASCII, so a byte above 0x7f is
// damage, and refusing it here keeps this identical to the Swift reader
// without either side depending on its platform's UTF-8 decoder.
function percentDecoded(raw: string): string | null {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "%") {
      out += raw[i];
      continue;
    }
    const hex = raw.slice(i + 1, i + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
    const byte = parseInt(hex, 16);
    if (byte > 0x7f) return null;
    out += String.fromCharCode(byte);
    i += 2;
  }
  return out;
}
