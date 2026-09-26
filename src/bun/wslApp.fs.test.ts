// `ledge open` inside WSL (bun/wslApp.ts): the record the Windows app leaves,
// written by the same sh command the app runs through wsl.exe, and the
// verdicts that decide between launching the app and leaving it be.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inWsl, readWindowsApp, tasklistShowsBun, WINDOWS_APP_FILE } from "./wslApp";
import { recordArgv } from "./wslServer";

function appHome(record?: string): string {
  const home = mkdtempSync(join(tmpdir(), "ledge-wslapp-"));
  mkdirSync(join(home, ".ledge"));
  if (record !== undefined) writeFileSync(join(home, ".ledge", WINDOWS_APP_FILE), record);
  return home;
}

describe("the record", () => {
  test("reads back what the app's command writes", async () => {
    const home = appHome();
    const app = { launcher: "C:\\Users\\dan\\AppData\\Local\\sh.ledge.app\\stable\\app\\bin\\launcher.exe", pid: 4242 };
    // The argv after `wsl.exe --exec` is what runs inside Linux.
    const proc = Bun.spawn({ cmd: recordArgv(app).slice(2), env: { ...process.env, HOME: home }, stdout: "ignore", stderr: "ignore" });
    expect(await proc.exited).toBe(0);
    expect(readWindowsApp(join(home, ".ledge"))).toEqual(app);
  });

  test("is null when missing or not a record", () => {
    expect(readWindowsApp(join(appHome(), ".ledge"))).toBeNull();
    expect(readWindowsApp(join(appHome("not json"), ".ledge"))).toBeNull();
    expect(readWindowsApp(join(appHome('{"launcher":"/usr/bin/launcher","pid":1}'), ".ledge"))).toBeNull();
    expect(readWindowsApp(join(appHome('{"launcher":"C:\\\\a\\\\launcher.exe","pid":-1}'), ".ledge"))).toBeNull();
  });
});

describe("the running app", () => {
  test("is the bun.exe tasklist lists at the recorded pid", () => {
    expect(tasklistShowsBun('"bun.exe","4242","Console","1","180,512 K"\r\n')).toBe(true);
    expect(tasklistShowsBun("INFO: No tasks are running which match the specified criteria.\r\n")).toBe(false);
  });
});

describe("WSL", () => {
  test("needs both the distro and interop", () => {
    const linux = process.platform === "linux";
    expect(inWsl({ WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/1_interop" })).toBe(linux);
    expect(inWsl({ WSL_DISTRO_NAME: "Ubuntu" })).toBe(false);
    expect(inWsl({})).toBe(false);
  });
});
