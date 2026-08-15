// How a password is stored and how ssh gets it back (remote.md §4).
//
// The pure half only. The keychain itself is a native seam and belongs to the
// live probe (testing.md §6): `bun run probe:ssh` writes a real item, connects
// to a real password-only sshd through the real helper, and takes it all away
// again. Nothing here spawns `security`, because a unit suite that ran hundreds
// of times a day should not be writing to the login keychain.
//
// What IS here is the part that would fail silently. The encoding decides
// whether a password survives the round trip at all, and the script is the
// program ssh runs to fetch it: both are strings, and a wrong string in either
// place produces a wrong PASSWORD rather than an error, which reaches the user
// as a server that refuses a credential they can see is right.
import { describe, expect, test } from "bun:test";
import {
  ASKPASS_ACCOUNT_ENV,
  askpassScript,
  fromHex,
  KEYCHAIN_SERVICE,
  SECURITY_PATH,
  toHex,
  XXD_PATH,
} from "./secrets";

describe("the stored form", () => {
  // `security find-generic-password -w` prints the value as text when the
  // bytes are printable ASCII and as hex when they are not, and says which
  // nowhere. Storing hex is what makes the read unambiguous: the stored value
  // is always printable, so the output is always hex and is always decoded.
  test("round-trips every password the door accepts", () => {
    for (const password of [
      "simple123",
      'p@ssw0rd!#$%^&*()"\'`',
      "has space inside",
      "  leading and trailing  ",
      "pässwörd",
      "пароль",
      "emoji🔑key",
      "70c3a4", // Itself a valid hex string, which is the ambiguity this avoids.
    ]) {
      expect(fromHex(toHex(password))).toBe(password);
    }
  });

  // The whole point: whatever goes in, what comes out of `toHex` is printable
  // ASCII, so `security` never falls back to a second output format.
  test("is always printable ascii, whatever went in", () => {
    expect(toHex("emoji🔑key")).toMatch(/^[0-9a-f]*$/);
    expect(toHex("пароль")).toMatch(/^[0-9a-f]*$/);
  });

  test("is the hex of the UTF-8 bytes, and two characters per byte", () => {
    expect(toHex("hi")).toBe("6869");
    // Two bytes in UTF-8, four hex characters, and not the code point.
    expect(toHex("ä")).toBe("c3a4");
    expect(toHex("")).toBe("");
  });
});

describe("the askpass helper", () => {
  const script = askpassScript();

  // ssh runs this file directly, so a shell that cannot parse it is an
  // authentication that fails with nothing to read.
  test("is a shell script", () => {
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
  });

  // Both fixed, not resolved through PATH: this runs with whatever environment
  // ssh inherited, and a PATH lookup is a way for something else to answer.
  test("names both binaries by absolute path", () => {
    expect(script).toContain(SECURITY_PATH);
    expect(script).toContain(XXD_PATH);
    expect(script).not.toContain("\nsecurity ");
    expect(script).not.toContain("| xxd");
  });

  test("looks the password up by service and by the connection it was told", () => {
    expect(script).toContain(`-s ${KEYCHAIN_SERVICE}`);
    expect(script).toContain(`-a "$${ASKPASS_ACCOUNT_ENV}"`);
  });

  // Quoted, because a connection id arrives from the environment and an
  // unquoted expansion is where a shell splits or globs one.
  test("quotes every expansion", () => {
    const bare = script.match(/\$[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    for (const use of bare) {
      // Every use is either inside double quotes or inside ${...}, both of
      // which put a quote or a brace immediately before the dollar.
      const at = script.indexOf(use);
      expect(['"', "{"].includes(script[at - 1] ?? "")).toBe(true);
    }
  });

  // A connection with no stored password must fail rather than print an empty
  // line: ssh sends what the helper prints, and an empty password offered to a
  // server is an authentication attempt spent on nothing.
  test("exits without printing when there is nothing to print", () => {
    expect(script).toContain(`[ -n "\${${ASKPASS_ACCOUNT_ENV}:-}" ] || exit 1`);
    expect(script).toContain('[ -n "$hex" ] || exit 1');
    expect(script).toContain("|| exit 1\n");
  });

  // No trailing newline of its own. ssh truncates at the first one, so adding
  // one is harmless and omitting one is what keeps a password that is a prefix
  // of another from arriving whole.
  test("prints the password and nothing after it", () => {
    expect(script).toContain(`printf '%s' "$hex" | ${XXD_PATH} -r -p`);
  });

  // Never. The helper is spawned by ssh, and ssh's argv is the prompt string,
  // which changes wording between OpenSSH releases.
  test("does not read the prompt ssh passes it", () => {
    expect(script).not.toContain("$1");
    expect(script).not.toContain("password:");
  });
});
