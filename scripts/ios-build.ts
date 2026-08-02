// Build the iOS client and run it in the Simulator (ios.md §14, phase 3).
//
//   bun run ios                       build, install, launch, stream its log
//   bun run ios -- --build            build only
//   bun run ios -- --server 10.0.0.4:8787
//   bun run ios -- --device "iPhone 16 Pro"
//
// **swiftc and a directory, not an Xcode project.** The app has no external
// dependency and no storyboard, so a `.app` is a binary, a plist and the built
// view in a folder — which is what `xcrun swiftc` and `cp` produce, and what
// `simctl` installs. A project file would be a second, generated description of
// the same three facts, unreadable in a diff and unverifiable except by opening
// Xcode. It becomes necessary at phase 4, where NIOSSH arrives as a SwiftPM
// dependency and signing arrives with a real device; this is deliberately the
// build that gets us to the point of knowing whether phase 3 works.
//
// Simulator only, and by construction: no signing identity is used and none is
// needed. A build for a device is the phase that needs a provisioning profile,
// which is the same phase that needs the ssh (ios.md §12).
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const OUT = join(REPO, "build", "ios");
const APP = join(OUT, "Ledge.app");
const BUNDLE_ID = "dev.ledge.ios";
// The runtime installed on this Mac decides the ceiling; the floor is ours.
// Compiled against whatever SDK Xcode has, deployed back to here.
const DEPLOYMENT = "17.0";

const argv = Bun.argv.slice(2);
const flag = (name: string): string | null => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? (argv[at + 1] ?? "") : null;
};
const buildOnly = argv.includes("--build");
const device = flag("device") ?? "iPhone 16";
const server = flag("server");

async function run(cmd: string[], opts: { cwd?: string; quiet?: boolean } = {}): Promise<string> {
  const proc = Bun.spawn({
    cmd,
    cwd: opts.cwd ?? REPO,
    stdout: opts.quiet ? "pipe" : "inherit",
    stderr: opts.quiet ? "pipe" : "inherit",
  });
  const out = opts.quiet ? await new Response(proc.stdout).text() : "";
  const code = await proc.exited;
  if (code !== 0) {
    if (opts.quiet) console.error(out, await new Response(proc.stderr).text());
    throw new Error(`${cmd[0]} ${cmd[1] ?? ""} exited ${code}`);
  }
  return out;
}

const version = (await Bun.file(join(REPO, "package.json")).json()).version as string;

// --- the view ----------------------------------------------------------------

console.log("[ios] building the view");
await run(["bunx", "vite", "build", "--config", "vite.ios.config.ts"]);
if (!existsSync(join(REPO, "dist-ios", "ios.html"))) {
  throw new Error("dist-ios/ios.html is missing; the view build produced nothing to bundle");
}

// --- the bundle --------------------------------------------------------------

rmSync(APP, { recursive: true, force: true });
mkdirSync(APP, { recursive: true });

console.log("[ios] compiling the shell");
const sdk = (await run(["xcrun", "--sdk", "iphonesimulator", "--show-sdk-path"], { quiet: true })).trim();
const sources = [...new Bun.Glob("*.swift").scanSync({ cwd: join(REPO, "ios", "Sources"), absolute: true })].sort();
if (sources.length === 0) throw new Error("no Swift sources in ios/Sources");
await run([
  "xcrun",
  "--sdk",
  "iphonesimulator",
  "swiftc",
  // arm64 only, like the Mac app (releasing.md). An Intel Mac's Simulator
  // would need x86_64 and this whole file is a fixture.
  "-target",
  `arm64-apple-ios${DEPLOYMENT}-simulator`,
  "-sdk",
  sdk,
  // Without this the module is named for main.swift and the runtime class
  // names collide with the entry point's.
  "-module-name",
  "Ledge",
  "-emit-executable",
  "-o",
  join(APP, "Ledge"),
  ...sources,
]);

await Bun.write(join(APP, "Info.plist"), Bun.file(join(REPO, "ios", "Resources", "Info.plist")));
await run(["plutil", "-replace", "CFBundleShortVersionString", "-string", version, join(APP, "Info.plist")]);
if (server !== null) {
  await run(["plutil", "-replace", "LedgeServer", "-string", server, join(APP, "Info.plist")]);
}

// The view as a bundle resource, under the one directory BundleScheme.swift
// will serve and nothing above it.
await run(["cp", "-R", join(REPO, "dist-ios"), join(APP, "view")]);

const size = (await run(["du", "-sh", APP], { quiet: true })).split("\t")[0];
console.log(`[ios] ${APP} (${size?.trim()}), version ${version}`);
if (buildOnly) process.exit(0);

// --- the Simulator -----------------------------------------------------------

interface SimDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
}

const listed = JSON.parse(await run(["xcrun", "simctl", "list", "devices", "available", "-j"], { quiet: true })) as {
  devices: Record<string, SimDevice[]>;
};
const all = Object.values(listed.devices).flat();
// A booted one of the right name first: booting a second device when one is
// already up is how you end up watching the wrong screen.
const target =
  all.find((d) => d.name === device && d.state === "Booted") ??
  all.find((d) => d.name === device) ??
  all.find((d) => d.state === "Booted");
if (!target) {
  throw new Error(`no simulator called ${device}; xcrun simctl list devices available`);
}
if (target.state !== "Booted") {
  console.log(`[ios] booting ${target.name}`);
  await run(["xcrun", "simctl", "boot", target.udid]);
  await run(["xcrun", "simctl", "bootstatus", target.udid]);
}

console.log(`[ios] installing on ${target.name} (${target.udid})`);
await run(["xcrun", "simctl", "install", target.udid, APP]);
// A relaunch onto a running instance would leave the old process holding the
// socket and the new one failing to bind nothing in particular.
await run(["xcrun", "simctl", "terminate", target.udid, BUNDLE_ID], { quiet: true }).catch(() => {});

// --console-pty is the whole reason `@log` exists: the shell's print() lines
// and every boot measurement the view reports come out here (ios.tsx). Ctrl-C
// detaches and leaves the app running.
console.log(`[ios] launching; Ctrl-C detaches\n`);
const launch = ["xcrun", "simctl", "launch", "--console-pty", target.udid, BUNDLE_ID];
if (server !== null) launch.push("-LedgeServer", server);
await run(launch);
