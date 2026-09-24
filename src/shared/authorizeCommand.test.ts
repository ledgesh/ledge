// The command a phone's pairing screen copies, run the way the user runs it:
// pasted into a shell on the server as the account Ledge signs in to. Each
// shell below runs it against a scratch HOME, and the Swift and Kotlin copies
// the native screens build it from are checked against it last (ios.md §4).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTHORIZE_PREFIX, AUTHORIZE_SUFFIX, authorizeCommand } from "./connections";

const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash", "/bin/ksh"].filter((s) => existsSync(s));
const LINE = `restrict,command="PATH=$HOME/.ledge/.server/bin:$PATH ledge serve" ecdsa-sha2-nistp256 AAAAkey ledge-iphone-abc123`;

function inHome(shell: string, line: string, before?: string): { keys: string; dirMode: number; fileMode: number } {
  const home = mkdtempSync(join(tmpdir(), "ledge-authorize-"));
  try {
    if (before !== undefined) {
      mkdirSync(join(home, ".ssh"), { mode: 0o755 });
      writeFileSync(join(home, ".ssh", "authorized_keys"), before, { mode: 0o644 });
    }
    const done = Bun.spawnSync([shell, "-c", authorizeCommand(line)], { env: { HOME: home, PATH: "/usr/bin:/bin" } });
    expect(done.exitCode).toBe(0);
    const file = join(home, ".ssh", "authorized_keys");
    return {
      keys: readFileSync(file, "utf8"),
      dirMode: statSync(join(home, ".ssh")).mode & 0o777,
      fileMode: statSync(file).mode & 0o777,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const lines = (keys: string) => keys.split("\n").filter((l) => l !== "");

describe("the command that installs a phone's key", () => {
  test.each(SHELLS)("%s makes ~/.ssh and the file with the modes sshd insists on", (shell) => {
    const got = inHome(shell, LINE);
    expect(lines(got.keys)).toEqual([LINE]);
    expect(got.dirMode).toBe(0o700);
    expect(got.fileMode).toBe(0o600);
  });

  test.each(SHELLS)("%s keeps the keys already there, even with no final newline", (shell) => {
    const got = inHome(shell, LINE, "ssh-ed25519 AAAAmine me@laptop");
    expect(lines(got.keys)).toEqual(["ssh-ed25519 AAAAmine me@laptop", LINE]);
    expect(got.dirMode).toBe(0o700);
    expect(got.fileMode).toBe(0o600);
  });

  test.each(SHELLS)("%s writes a line with a single quote in it unchanged", (shell) => {
    const odd = `${LINE.replace("ledge-iphone-abc123", "dan's-iphone")} $(touch pwned) \\n`;
    expect(lines(inHome(shell, odd).keys)).toEqual([odd]);
  });

  test("the Swift copy builds the same command", () => {
    const swift = readFileSync(join(import.meta.dir, "..", "..", "ios", "Sources", "DeviceKey.swift"), "utf8");
    const literal = (name: string) => {
      const m = swift.match(new RegExp(`static let ${name} = "((?:[^"\\\\]|\\\\.)*)"`));
      expect(m).not.toBeNull();
      return JSON.parse(`"${m![1]}"`) as string;
    };
    expect(literal("authorizePrefix")).toBe(AUTHORIZE_PREFIX);
    expect(literal("authorizeSuffix")).toBe(AUTHORIZE_SUFFIX);
    expect(swift).toContain(`line.replacingOccurrences(of: "'", with: "'\\\\''")`);
  });

  test("the Kotlin copy builds the same command", () => {
    const kotlin = readFileSync(
      join(import.meta.dir, "..", "..", "android", "app", "src", "main", "kotlin", "sh", "ledge", "android", "DeviceKey.kt"),
      "utf8",
    );
    const literal = (name: string) => {
      const m = kotlin.match(new RegExp(`const val ${name} = "((?:[^"\\\\]|\\\\.)*)"`));
      expect(m).not.toBeNull();
      return JSON.parse(`"${m![1]}"`) as string;
    };
    expect(literal("AUTHORIZE_PREFIX")).toBe(AUTHORIZE_PREFIX);
    expect(literal("AUTHORIZE_SUFFIX")).toBe(AUTHORIZE_SUFFIX);
    expect(kotlin).toContain(`line.replace("'", "'\\\\''")`);
  });
});
