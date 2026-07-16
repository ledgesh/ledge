// bun test preload (bunfig.toml): give the whole test run a scratch notes root.
//
// bun/notes.ts reads LEDGE_NOTES_ROOT once, at import time, and every test file
// shares one module registry — so the env var must be set before the first file
// imports the module, which only a preload can guarantee. With it, no test can
// reach the real ~/.ledge no matter what it does; without it, a filesystem test
// that ran after some other file imported notes.ts would be pointed at real
// notes.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["LEDGE_NOTES_ROOT"] = mkdtempSync(join(tmpdir(), "ledge-test-"));
