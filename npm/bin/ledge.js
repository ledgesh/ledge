#!/usr/bin/env bun
// The package's `ledge` command: `ledge-server cli` by its short name
// (src/bun/serve.ts), with the verb put in front of the caller's arguments.
// The same launcher as ledge-server.js beside it, and a separate file from
// the bundle for the same reason: the check below has to run before the
// bundle's `bun:ffi` import does.
if (typeof Bun === "undefined") {
  console.error("ledge runs on Bun, and this process is not Bun.");
  console.error("Install Bun from https://bun.sh, then run: bunx ledge-server cli");
  process.exit(1);
}

const { main } = await import("../lib/serve.js");
await main([process.argv[0], process.argv[1], "cli", ...process.argv.slice(2)]);
