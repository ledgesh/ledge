#!/usr/bin/env bun
// Assemble the server the Windows app carries into WSL, in dist-wsl/:
//
//   bun run build:wsl
//
// A server release for linux-x64 alone (build-server.ts `--targets`), plus the
// pinned Bun tarball that build-server.ts checked, all in one directory. The
// app runs its server.sh with `--from` that directory (bun/wslServer.ts), and
// electrobun.config.ts copies it into a Windows build when it is there.
//
// The trampolines are ELF, so this needs a Linux x64 machine or Docker. The
// Windows release workflow runs it on a Linux runner (releasing.md §10).
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUN_PACKAGES, BUN_VERSION, tarballPath, WSL_TARGET, wslFiles } from "../src/bun/serverRelease";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "dist-wsl");

const built = Bun.spawnSync([process.execPath, "scripts/build-server.ts", `--targets=${WSL_TARGET}`, "--out=dist-wsl"], {
  cwd: ROOT,
  stdout: "inherit",
  stderr: "inherit",
});
if (built.exitCode !== 0) {
  console.error(`[wsl] build-server.ts failed (exit ${built.exitCode})`);
  process.exit(1);
}

// build-server.ts downloaded it into its cache and checked it against the pin.
const bun = tarballPath(BUN_PACKAGES[WSL_TARGET]!.name, BUN_VERSION);
copyFileSync(join(ROOT, "dist-bun", `bun-v${BUN_VERSION}`, bun), join(OUT, bun.split("/").pop()!));

const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const missing = wslFiles(version).filter((f) => !existsSync(join(OUT, f)));
if (missing.length > 0) {
  console.error(`[wsl] dist-wsl/ lacks ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`[wsl] the server for WSL, ${version}, in dist-wsl/: ${readdirSync(OUT).sort().join(", ")}`);
