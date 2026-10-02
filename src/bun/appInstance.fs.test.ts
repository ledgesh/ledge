// The one-app-process lock (bun/appInstance.ts), over real sockets in a
// scratch folder. The named pipe it uses on Windows was checked on the PC: a
// second listen fails with EADDRINUSE, a connect reaches the holder, and the
// pipe is freed when its holder is killed.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimInstance, holdAddress, instanceAddress, type Holder } from "./appInstance";

const dirs: string[] = [];
const holders: Holder[] = [];
afterEach(async () => {
  for (const h of holders.splice(0)) h.release();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function address(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ledge-instance-"));
  dirs.push(dir);
  return join(dir, "app.sock");
}

async function claim(at: string, onRaise = () => {}, waitMs = 1_000) {
  const c = await claimInstance(at, { onRaise, waitMs, askMs: 300 });
  if (c.held) holders.push(c.holder);
  return c;
}

test("the first launch holds the lock", async () => {
  const at = await address();
  expect((await claim(at)).held).toBe(true);
  expect(existsSync(at)).toBe(true);
});

test("a second launch raises the first one's window and does not hold the lock", async () => {
  const at = await address();
  let raised = 0;
  await claim(at, () => raised++);
  expect(await claim(at)).toEqual({ held: false, answered: true });
  expect(await claim(at)).toEqual({ held: false, answered: true });
  expect(raised).toBe(2);
});

test("of several launches at the same moment, exactly one holds the lock", async () => {
  const at = await address();
  const script = `const { claimInstance } = await import(${JSON.stringify(join(import.meta.dir, "appInstance.ts"))});
    const c = await claimInstance(${JSON.stringify(at)}, { onRaise() {} });
    console.log(c.held ? "held" : c.answered ? "raised" : "silent");
    if (c.held) await Bun.sleep(1500);
    process.exit(0);`;
  const launches = Array.from({ length: 4 }, () => Bun.spawn({ cmd: [process.execPath, "-e", script], stdout: "pipe", stderr: "pipe" }));
  const said = await Promise.all(launches.map(async (p) => (await new Response(p.stdout).text()).trim() || (await new Response(p.stderr).text()).trim().split("\n").pop()));
  expect(said.sort()).toEqual(["held", "raised", "raised", "raised"]);
});

test("a socket file left by a process that was killed does not keep the next launch out", async () => {
  const at = await address();
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `Bun.listen({ unix: ${JSON.stringify(at)}, socket: { data() {} } }); console.log("up"); setInterval(() => {}, 1000);`],
    stdout: "pipe",
  });
  await child.stdout.getReader().read();
  child.kill("SIGKILL");
  await child.exited;
  expect(existsSync(at)).toBe(true);
  expect((await claim(at)).held).toBe(true);
});

test("a holder that never answers is reported rather than joined", async () => {
  const at = await address();
  const mute = Bun.listen({ unix: at, socket: { data() {} } });
  try {
    const started = Date.now();
    expect(await claim(at, () => {}, 600)).toEqual({ held: false, answered: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
  } finally {
    mute.stop(true);
  }
});

test("a released lock can be held again, and leaves no socket file", async () => {
  const at = await address();
  const first = holdAddress(at, () => {});
  first.release();
  expect(existsSync(at)).toBe(false);
  expect((await claim(at)).held).toBe(true);
});

// Left behind, it would cost every launch after a quit two asks to find stale.
test("an app that quits takes its socket file with it", async () => {
  const at = await address();
  const script = `const { holdAddress } = await import(${JSON.stringify(join(import.meta.dir, "appInstance.ts"))});
    holdAddress(${JSON.stringify(at)}, () => {});
    setTimeout(() => process.exit(0), 100);`;
  expect(await Bun.spawn({ cmd: [process.execPath, "-e", script] }).exited).toBe(0);
  expect(existsSync(at)).toBe(false);
});

test("an onRaise that throws still answers, so the second launch exits", async () => {
  const at = await address();
  await claim(at, () => {
    throw new Error("no window yet");
  });
  expect(await claim(at)).toEqual({ held: false, answered: true });
});

test("on Windows the lock is a named pipe, one per client home", () => {
  const a = instanceAddress("C:\\Users\\a\\.ledge\\.client", "win32");
  expect(a).toMatch(/^\\\\\.\\pipe\\ledge-app-[0-9a-f]+$/);
  expect(instanceAddress("C:\\Users\\A\\.ledge\\.client", "win32")).toBe(a);
  expect(instanceAddress("C:\\Users\\b\\.ledge\\.client", "win32")).not.toBe(a);
  expect(instanceAddress("/home/a/.ledge/.client", "linux")).toBe("/home/a/.ledge/.client/app.sock");
});
