// What the Mac app does about the daemon it finds behind its socket
// (bun/localServer.ts). The process seams are faked, so these run with no
// daemon, no signal and no bundle: what they check is the decision, since the
// daemon's own answer to a retire is daemon.fs.test.ts's.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localServer, type LocalServerOpts } from "./localServer";
import type { Duplex } from "../shared/transport";

const duplex: Duplex = { write() {}, close() {} };

function fake(opts: Partial<LocalServerOpts> = {}) {
  const log: string[] = [];
  const entry = join(mkdtempSync(join(tmpdir(), "ledge-local-")), "serve.js");
  writeFileSync(entry, "");
  const server = localServer({
    build: "0.2.0",
    channel: "stable",
    entry,
    execPath: "/bundle/bun",
    daemon: {
      connect: async (spawn) => {
        log.push("connect");
        if (log.includes("spawn")) return duplex;
        spawn();
        return duplex;
      },
      spawn: (head) => log.push(`spawn:${head.join(" ")}`),
      stop: async () => {
        log.push("stop");
        return true;
      },
      retire: () => {
        log.push("retire");
        return true;
      },
    },
    ...opts,
  });
  return { server, log, entry };
}

describe("the dial", () => {
  test("starts the daemon from the bundle's own runtime and entry", async () => {
    const { server, log, entry } = fake();
    await server.dial();
    expect(log).toEqual(["connect", `spawn:/bundle/bun ${entry}`]);
  });

  // A missing entry would otherwise be a daemon that never answered, reported
  // ten seconds later with no path in it.
  test("refuses to start a daemon from an entry that is not there", async () => {
    const { server } = fake({ entry: "/nowhere/serve.js" });
    await expect(server.dial()).rejects.toThrow("/nowhere/serve.js");
  });

  // A stable build leaves whatever daemon is there for `review` to judge. A
  // dev build's version never changes between builds, so review cannot tell
  // the last launch's daemon from this one's, and the dial stops it first.
  test("a stable build keeps the daemon it finds; a dev build stops it, once", async () => {
    const stable = fake();
    await stable.server.dial();
    expect(stable.log).not.toContain("stop");

    const dev = fake({ channel: "dev" });
    await dev.server.dial();
    await dev.server.dial();
    expect(dev.log.filter((l) => l === "stop")).toEqual(["stop"]);
    expect(dev.log[0]).toBe("stop");
  });
});

describe("the review", () => {
  test("keeps a daemon of this build", () => {
    const { server, log } = fake();
    expect(server.review({ build: "0.2.0", instance: "a" })).toBe("kept");
    expect(log).toEqual([]);
  });

  test("asks a daemon of another build to retire, and asks it once", () => {
    const { server, log } = fake();
    expect(server.review({ build: "0.1.0", instance: "a" })).toBe("retired");
    // Every window reviews the same hello; a second window must not signal
    // the daemon again.
    expect(server.review({ build: "0.1.0", instance: "a" })).toBe("kept");
    expect(log).toEqual(["retire"]);
    // The daemon that replaces it is a different instance, and is judged
    // afresh.
    expect(server.review({ build: "0.2.0", instance: "b" })).toBe("kept");
    expect(log).toEqual(["retire"]);
  });
});
