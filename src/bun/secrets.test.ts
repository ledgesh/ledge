// How a password is stored and how ssh gets it back (remote.md §4).
//
// The pure half only. Nothing here spawns `security`: a unit suite that runs
// hundreds of times a day should not write to the login keychain. `bun run
// probe:ssh` covers that native seam live (testing.md §6): it writes a real
// item, connects to a real password-only sshd through the real helper, and
// removes everything it made.
//
// A mistake in the encoding or the script fails silently. The encoding decides
// whether a password survives the round trip, and the script is the program
// ssh runs to fetch it. Both are strings, and a wrong string in either place
// produces a wrong password rather than an error. The server then rejects a
// password the user typed correctly.
import { describe, expect, test } from "bun:test";
import {
  ASKPASS_ACCOUNT_ENV,
  askpassScript,
  fromHex,
  KEYCHAIN_SERVICE,
  SECURITY_PATH,
  storeCommand,
  toHex,
  XXD_PATH,
} from "./secrets";

describe("the stored form", () => {
  // `security find-generic-password -w` prints the value as text when the
  // bytes are printable ASCII and as hex when they are not. The output does
  // not say which form it used. Storing hex keeps the stored value printable,
  // so the read is always hex and always decoded.
  test("round-trips every password the door accepts", () => {
    for (const password of [
      "simple123",
      'p@ssw0rd!#$%^&*()"\'`',
      "has space inside",
      "  leading and trailing  ",
      "pässwörd",
      "пароль",
      "emoji🔑key",
      // Itself valid hex, so a plain read could not tell it from an encoded
      // password.
      "70c3a4",
    ]) {
      expect(fromHex(toHex(password))).toBe(password);
    }
  });

  // Whatever goes in, `toHex` returns printable ASCII, so `security` never
  // falls back to its second output format.
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

describe("the store command", () => {
  const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const HEX = "70c3a4";
  const line = storeCommand(ID, HEX);

  // `-w` with no value makes `security` prompt instead of reading the pipe.
  // With a controlling terminal it prints "password data for new item:" on
  // /dev/tty and waits there forever. `security` never exits, so
  // `storePassword` never returns and the dialog upstream stops. The value has
  // to be in the line.
  test("carries the password inline, so nothing can prompt for it", () => {
    expect(line).toContain(`-w "${HEX}"`);
    expect(line.trimEnd().endsWith("-w")).toBe(false);
  });

  // `storePassword` writes this to `security -i` as one line. A second line
  // would run as a second keychain command.
  test("is a single line", () => {
    expect(line).not.toContain("\n");
  });

  test("files the item under the service, against the connection's id", () => {
    expect(line).toContain(`-s "${KEYCHAIN_SERVICE}"`);
    expect(line).toContain(`-a "${ID}"`);
  });

  // Without `-U`, changing a connection's password hits the item already
  // there and the write fails instead of replacing it.
  test("updates an existing item rather than refusing", () => {
    expect(line.startsWith("add-generic-password -U ")).toBe(true);
  });

  // The label and the comment Keychain Access shows both contain spaces. An
  // unquoted value would arrive as its first word plus stray arguments.
  test("keeps a value with spaces as one token", () => {
    expect(line).toMatch(/-l "[^"]* [^"]*"/);
    expect(line).toMatch(/-j "[^"]* [^"]*"/);
  });

  // `security -i` reads \" as a quote and \\ as a backslash, and stores those
  // characters. Measured against the real parser rather than assumed.
  test("escapes a quote and a backslash", () => {
    expect(storeCommand('a"b', HEX)).toContain(String.raw`-a "a\"b"`);
    expect(storeCommand("a\\b", HEX)).toContain(String.raw`-a "a\\b"`);
  });
});

describe("the askpass helper", () => {
  const script = askpassScript();

  // ssh executes this file directly, so the shebang is what lets it run.
  // Without one the exec fails, and the authentication fails with nothing to
  // read.
  test("is a shell script", () => {
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
  });

  // Both paths are absolute rather than resolved through PATH. The helper runs
  // with whatever environment ssh inherited, so a PATH lookup could find some
  // other program.
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

  // The connection id arrives from the environment. An unquoted expansion
  // would let the shell split or glob it.
  test("quotes every expansion", () => {
    const bare = script.match(/\$[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    for (const use of bare) {
      // Every use is either inside double quotes or inside ${...}, both of
      // which put a quote or a brace immediately before the dollar.
      const at = script.indexOf(use);
      expect(['"', "{"].includes(script[at - 1] ?? "")).toBe(true);
    }
  });

  // A connection with no stored password exits non-zero rather than printing
  // an empty line. ssh sends whatever the helper prints, so an empty line
  // would be spent as an authentication attempt.
  test("exits without printing when there is nothing to print", () => {
    expect(script).toContain(`[ -n "\${${ASKPASS_ACCOUNT_ENV}:-}" ] || exit 1`);
    expect(script).toContain('[ -n "$hex" ] || exit 1');
    expect(script).toContain("|| exit 1\n");
  });

  // No trailing newline of its own. `printf '%s'` writes `$hex` unterminated,
  // and `xxd -r -p` decodes it to the password bytes without adding one. ssh
  // reads the first line of stdout as the password. A newline at the end is
  // therefore harmless. Anything else printed is sent as part of the password,
  // and anything past a newline is not sent at all.
  test("prints the password and nothing after it", () => {
    expect(script).toContain(`printf '%s' "$hex" | ${XXD_PATH} -r -p`);
  });

  // The helper never reads its argument. ssh passes the prompt string as that
  // argument, and the prompt's wording changes between OpenSSH releases.
  test("does not read the prompt ssh passes it", () => {
    expect(script).not.toContain("$1");
    expect(script).not.toContain("password:");
  });
});
