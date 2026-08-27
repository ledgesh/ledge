// bun test preload (bunfig.toml): give the whole test run a scratch notes root
// and a known shell.
//
// bun/notes.ts reads LEDGE_NOTES_ROOT once, at import time, and every test file
// shares one module registry — so the env var must be set before the first file
// imports the module, which only a preload can guarantee. With it, no test can
// reach the real ~/.ledge no matter what it does; without it, a filesystem test
// that ran after some other file imported notes.ts would be pointed at real
// notes.
import { accessSync, constants, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["LEDGE_NOTES_ROOT"] = mkdtempSync(join(tmpdir(), "ledge-test-"));
// Same deal for the profiles dir (bun/spawnParams.ts): no test may read — or
// seed — the real ~/.config/ledge/profiles.
process.env["LEDGE_PROFILES_DIR"] = mkdtempSync(join(tmpdir(), "ledge-test-profiles-"));

// And the shell those tests spawn, which otherwise is whichever one the account
// running them logs in with: `settings.shell.path` defaults to $SHELL when the
// file does not name one (bun/spawnParams.ts `resolveShellPath`), and both zsh
// and bash are supported, so an account on either gets a green typecheck and a
// different pty.
//
// It matters because the tests that wait for a drawer's shell to come up wait
// for bracketed-paste enable (CSI ? 2004 h), which is how zsh announces its line
// editor is ready for input — the same signal bun/server.ts tracks, and the only
// one that distinguishes a prompt from a shell that has printed nothing yet.
// macOS still ships bash 3.2, which predates readline's bracketed paste
// entirely, so on a bash account those tests spent three seconds waiting for a
// sequence that was never coming. That is precisely what the CI runner is:
// supported, and silent.
//
// This pins the tests and not the app. A shell with no bracketed-paste mode is
// something the product handles on purpose — bun/paste.ts releases a queued
// paste on a quiet pty when no prompt signal ever arrives — and the branches
// that differ between the two shells are covered without spawning anything
// (markers.test.ts, spawnParams.test.ts).
//
// Left alone when no zsh is installed, so the fallback ladder still chooses and
// a machine without one fails on that fact rather than on this line.
const zsh = ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh"].find((path) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
});
if (zsh) process.env["SHELL"] = zsh;
