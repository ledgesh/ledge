import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SIGNING,
  SIGNING_MODULE_VERSION,
  extractSetupScript,
  isSetupZip,
  isSignable,
  psQuote,
  replaceSetupScript,
  signScript,
  signsWindows,
  unsignedScript,
} from "./windowsSigning";

describe("signsWindows", () => {
  test("a Windows release build is signed", () => {
    expect(signsWindows({ ELECTROBUN_OS: "win", ELECTROBUN_BUILD_ENV: "stable" })).toBe(true);
    expect(signsWindows({ ELECTROBUN_OS: "win", ELECTROBUN_BUILD_ENV: "canary" })).toBe(true);
  });

  test("a dev build, a dry run and every other platform are not", () => {
    expect(signsWindows({ ELECTROBUN_OS: "win", ELECTROBUN_BUILD_ENV: "dev" })).toBe(false);
    expect(signsWindows({ ELECTROBUN_OS: "win", ELECTROBUN_BUILD_ENV: "stable", LEDGE_UNSIGNED: "1" })).toBe(false);
    expect(signsWindows({ ELECTROBUN_OS: "macos", ELECTROBUN_BUILD_ENV: "stable" })).toBe(false);
    expect(signsWindows({ ELECTROBUN_OS: "linux", ELECTROBUN_BUILD_ENV: "stable" })).toBe(false);
    expect(signsWindows({})).toBe(false);
  });
});

describe("what gets signed", () => {
  test("executables and libraries, in any case", () => {
    expect(isSignable("C:\\b\\bin\\launcher.exe")).toBe(true);
    expect(isSignable("bun.EXE")).toBe(true);
    expect(isSignable("WebView2Loader.dll")).toBe(true);
    expect(isSignable("index.js")).toBe(false);
    expect(isSignable("server.sh")).toBe(false);
    expect(isSignable("exe")).toBe(false);
  });

  test("the setup zip, on any channel, and not the update tarball", () => {
    expect(isSetupZip("win-x64-Ledge-Setup.zip")).toBe(true);
    expect(isSetupZip("canary-win-x64-Ledge-Setup-canary.zip")).toBe(true);
    expect(isSetupZip("stable-win-x64-Ledge.tar.zst")).toBe(false);
    expect(isSetupZip("stable-win-x64-update.json")).toBe(false);
  });
});

describe("the PowerShell scripts", () => {
  test("a quoted string expands nothing, and a quote doubles", () => {
    expect(psQuote("C:\\Users\\Ana O'Neil\\$x")).toBe("'C:\\Users\\Ana O''Neil\\$x'");
  });

  test("the unsigned check lists every file, quoted", () => {
    const s = unsignedScript(["C:\\a b\\launcher.exe", "C:\\x\\bun.exe"]);
    expect(s).toContain("@('C:\\a b\\launcher.exe', 'C:\\x\\bun.exe')");
    expect(s).toContain("Get-AuthenticodeSignature -LiteralPath $_");
    expect(s).toContain("-ne 'Valid'");
  });

  test("signing names the account, the profile and the pinned module, timestamps, and uses only the CLI's credential", () => {
    const s = signScript(["C:\\a\\launcher.exe", "C:\\a\\bun.exe"]);
    expect(s).toContain(`Import-Module ArtifactSigning -RequiredVersion ${SIGNING_MODULE_VERSION}`);
    expect(s).toContain(`-Endpoint '${SIGNING.endpoint}'`);
    expect(s).toContain(`-CodeSigningAccountName '${SIGNING.account}'`);
    expect(s).toContain(`-CertificateProfileName '${SIGNING.profile}'`);
    expect(s).toContain("-Files 'C:\\a\\launcher.exe,C:\\a\\bun.exe'");
    expect(s).toContain("-FileDigest SHA256");
    expect(s).toContain("-TimestampRfc3161 'http://timestamp.acs.microsoft.com'");
    expect(s).toContain("-ExcludeManagedIdentityCredential:$true");
    expect(s).not.toContain("ExcludeAzureCliCredential");
  });

  test("the installer comes out of the zip and goes back under its own name", () => {
    const out = extractSetupScript("C:\\art\\win-x64-Ledge-Setup.zip", "C:\\tmp\\s");
    expect(out).toContain("OpenRead('C:\\art\\win-x64-Ledge-Setup.zip')");
    expect(out).toContain("Join-Path 'C:\\tmp\\s'");
    const back = replaceSetupScript("C:\\art\\win-x64-Ledge-Setup.zip", "C:\\tmp\\s\\Ledge-Setup.exe");
    expect(back).toContain("'Update'");
    expect(back).toContain("$old.Delete()");
    expect(back).toContain("CreateEntryFromFile($zip, 'C:\\tmp\\s\\Ledge-Setup.exe', $name)");
  });
});

test("the release workflow installs the module the scripts import", () => {
  // The workflow reads the version from this module rather than repeating it.
  const workflow = readFileSync(join(import.meta.dir, "../../.github/workflows/release-windows.yml"), "utf8");
  expect(workflow).toContain('require("./src/bun/windowsSigning").SIGNING_MODULE_VERSION');
  expect(workflow).toContain("environment: windows-signing");
  expect(workflow).toContain("id-token: write");
});
