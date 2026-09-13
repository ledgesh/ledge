// SERVE_COMMAND as the far end's login shell reads it, and the Swift copy the
// phone sends and forces (remote.md §4a). sshd hands the string to `$SHELL -c`,
// so each shell below runs it the way a server's would, against a fake
// `ledge` that reports where it was found. The Swift file and the ssh
// fixture hold copies of the string, and are checked against it last.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVE_COMMAND } from "./connections";

const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash", "/bin/ksh"].filter((s) => existsSync(s));
const SOURCES = join(import.meta.dir, "..", "..", "ios", "Sources");

/** A `ledge` in `dir` that prints its own path, its arguments and its PATH. */
function fakeServer(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "ledge");
  writeFileSync(file, '#!/bin/sh\nprintf "%s|%s|%s" "$0" "$*" "$PATH"\n');
  chmodSync(file, 0o755);
}

function run(shell: string, env: Record<string, string>): { out: string; code: number } {
  const done = Bun.spawnSync([shell, "-c", SERVE_COMMAND], { env, stdout: "pipe", stderr: "pipe" });
  return { out: done.stdout.toString(), code: done.exitCode };
}

describe("the command a client starts the server with", () => {
  test("the shells a server account has are all here to test", () => {
    expect(SHELLS.length).toBeGreaterThanOrEqual(3);
  });

  test.each(SHELLS)("%s finds a per-user install first, and keeps the rest of the PATH", (shell) => {
    const home = mkdtempSync(join(tmpdir(), "ledge serve home "));
    try {
      fakeServer(join(home, ".ledge-server", "bin"));
      fakeServer(join(home, "elsewhere"));
      const path = `${join(home, "elsewhere")}:/usr/bin:/bin:/opt/with space/bin`;
      const { out, code } = run(shell, { HOME: home, PATH: path });
      expect(code).toBe(0);
      expect(out).toBe(`${join(home, ".ledge-server", "bin", "ledge")}|serve|${join(home, ".ledge-server", "bin")}:${path}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.each(SHELLS)("%s still finds a server installed on sshd's own PATH", (shell) => {
    const home = mkdtempSync(join(tmpdir(), "ledge-serve-home-"));
    try {
      fakeServer(join(home, "usr-local-bin"));
      const { out, code } = run(shell, { HOME: home, PATH: `${join(home, "usr-local-bin")}:/usr/bin:/bin` });
      expect(code).toBe(0);
      expect(out.split("|")[0]).toBe(join(home, "usr-local-bin", "ledge"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // 127 is what the phone reads as a server that is not installed
  // (ios/Sources/SSHTransport.swift `notInstalled`).
  test.each(SHELLS)("%s exits 127 when there is no server anywhere", (shell) => {
    const home = mkdtempSync(join(tmpdir(), "ledge-serve-home-"));
    try {
      expect(run(shell, { HOME: home, PATH: "/usr/bin:/bin" }).code).toBe(127);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the copies that cannot import it", () => {
  test("the ssh fixture forces the same string", () => {
    const entrypoint = readFileSync(join(import.meta.dir, "..", "..", "scripts", "ssh-probe", "entrypoint.sh"), "utf8");
    expect(entrypoint.match(/^\s*command='([^']*)'$/m)?.[1]).toBe(SERVE_COMMAND);
  });

  test("the phone's SSHTransport.swift holds the same string", () => {
    const swift = readFileSync(join(SOURCES, "SSHTransport.swift"), "utf8");
    const held = swift.match(/static let serveCommand = "([^"\\]*)"/);
    expect(held?.[1]).toBe(SERVE_COMMAND);
  });

  test("the phone's exec request and its authorized_keys line both use it, and neither spells it out", () => {
    const transport = readFileSync(join(SOURCES, "SSHTransport.swift"), "utf8");
    const key = readFileSync(join(SOURCES, "DeviceKey.swift"), "utf8");
    expect(transport).toContain("command: Self.serveCommand");
    expect(key).toContain('restrict,command=\\"\\(SSHTransport.serveCommand)\\"');
    const spelled = /"[^"\n]*ledge serve[^"\n]*"/g;
    expect(transport.match(spelled)).toEqual([`"${SERVE_COMMAND}"`]);
    expect(key.match(spelled)).toBeNull();
  });
});
