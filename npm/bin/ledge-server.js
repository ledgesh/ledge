#!/usr/bin/env bun
// The published package's entry point (src/bun/npmPackage.ts). Hand-written
// and tiny; everything it runs is in the bundled lib/serve.js beside it.
//
// It is a separate file from the bundle for one reason: the bundle statically
// imports `bun:ffi`, which under any other runtime is an unresolvable
// specifier and therefore a load error before a single line of ours runs. A
// launcher that does not import it until after the check is the only place a
// readable message can be printed. Hence the dynamic import below, which must
// stay dynamic.
//
// The shebang covers the ordinary case: npm links this into .bin and the
// kernel picks the interpreter, so `bunx ledge-server`, a PATH install, and an
// authorized_keys forced command all arrive under Bun. What it does not cover
// is Bun missing entirely, which fails as `env: bun: No such file or
// directory` before this file is read at all. README.md answers that one,
// because nothing here can.
if (typeof Bun === "undefined") {
  console.error("ledge-server runs on Bun, and this process is not Bun.");
  console.error("Install Bun from https://bun.sh, then run: bunx ledge-server");
  process.exit(1);
}

const { main } = await import("../lib/serve.js");
await main(process.argv);
