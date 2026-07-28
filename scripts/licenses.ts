#!/usr/bin/env bun
// Render THIRD-PARTY-NOTICES.md from the installed production tree. Run it
// after adding, removing, or bumping a dependency:
//
//   bun run licenses
//
// The walk and the rendering live in src/bun/licenses.ts, where `bun test` can
// reach them (bunfig.toml roots the runner at src/) — this file is the part
// that touches the working copy. licenses.test.ts re-renders and compares, so
// forgetting to run this is a red suite rather than an unattributed release.
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectPackages, renderNotices } from "../src/bun/licenses";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "THIRD-PARTY-NOTICES.md");

const packages = collectPackages(ROOT);
writeFileSync(OUT, renderNotices(packages));
const missing = packages.filter((p) => p.texts.length === 0).map((p) => p.name);
console.log(`[licenses] ${packages.length} packages -> ${OUT}`);
// Named, not counted: each one is a package whose text someone may have to go
// find by hand, and the number alone hides which.
if (missing.length > 0) console.log(`[licenses] no license file published by: ${missing.join(", ")}`);
