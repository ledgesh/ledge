// The real login shell against a scratch ZDOTDIR, so the profile it reads is
// the one written here and never the account's (testing.md §2).
import { describe, expect, test } from "bun:test";
import { accessSync, constants, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLoginEnv } from "./loginEnv";

const ZSH = "/bin/zsh";
const hasZsh = (() => {
  try {
    accessSync(ZSH, constants.X_OK);
    return true;
  } catch {
    return false;
  }
})();

function scratch(zprofile: string) {
  const dir = mkdtempSync(join(tmpdir(), "ledge-loginenv-"));
  writeFileSync(join(dir, ".zprofile"), zprofile);
  const base = { HOME: dir, ZDOTDIR: dir, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  const warns: string[] = [];
  return { dir, base, warns, warn: (msg: string) => warns.push(msg) };
}

describe.skipIf(!hasZsh)("resolveLoginEnv", () => {
  test("returns what the login profile exports, on top of the base", async () => {
    const s = scratch('export PATH="/opt/fake/bin:$PATH"\nexport FROM_PROFILE=yes\nexport SAW_RESOLVING="$LEDGE_RESOLVING_ENVIRONMENT"\necho chatter\n');
    const env = await resolveLoginEnv(ZSH, s.base, { skip: false, cwd: s.dir, warn: s.warn });
    expect(env["PATH"]?.split(":")[0]).toBe("/opt/fake/bin");
    expect(env["FROM_PROFILE"]).toBe("yes");
    expect(env["HOME"]).toBe(s.dir);
    // The profile can see it is being resolved; the result does not carry it.
    expect(env["SAW_RESOLVING"]).toBe("1");
    expect(env["LEDGE_RESOLVING_ENVIRONMENT"]).toBeUndefined();
    expect(env["PWD"]).toBeUndefined();
    expect(s.warns).toEqual([]);
  });

  test("falls back to the base when the profile outlives the timeout", async () => {
    const s = scratch("sleep 5\n");
    const started = Date.now();
    const env = await resolveLoginEnv(ZSH, s.base, { skip: false, cwd: s.dir, warn: s.warn, timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(env).toEqual(s.base);
    expect(s.warns.length).toBe(1);
  });

  test("falls back to the base when the profile exits before printing", async () => {
    const s = scratch("exit 3\n");
    const env = await resolveLoginEnv(ZSH, s.base, { skip: false, cwd: s.dir, warn: s.warn });
    expect(env).toEqual(s.base);
    expect(s.warns.length).toBe(1);
  });

  test("falls back to the base when the shell does not exist", async () => {
    const s = scratch("");
    const env = await resolveLoginEnv("/nonexistent/zsh", s.base, { skip: false, cwd: s.dir, warn: s.warn });
    expect(env).toEqual(s.base);
    expect(s.warns.length).toBe(1);
  });

  test("LEDGE_SKIP_LOGIN_ENV (set by the test preload) skips the shell", async () => {
    const s = scratch("export FROM_PROFILE=yes\n");
    const env = await resolveLoginEnv(ZSH, s.base, { cwd: s.dir, warn: s.warn });
    expect(env).toEqual(s.base);
    expect(s.warns).toEqual([]);
  });
});
