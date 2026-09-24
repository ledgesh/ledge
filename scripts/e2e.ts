#!/usr/bin/env bun
// `bun run test:e2e`: the Playwright suite, with the Mac kept awake for it.
// A Mac that sleeps mid-run leaves page.goto waiting on a display that is off,
// so there the suite runs under caffeinate. Linux has no equivalent and needs
// none: a runner never sleeps, and a desktop that does is woken by hand.
// Arguments pass through to `playwright test`.
const args = process.argv.slice(2);
const cmd = process.platform === "darwin" ? ["caffeinate", "-dimsu", "bunx", "playwright", "test", ...args] : ["bunx", "playwright", "test", ...args];
const proc = Bun.spawn({ cmd, stdio: ["inherit", "inherit", "inherit"] });
process.exit(await proc.exited);
