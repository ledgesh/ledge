// Build the iOS client and run it in the Simulator (ios.md §14, phase 4).
//
//   bun run ios                       build, install, launch, stream its log
//   bun run ios -- --build            build only
//   bun run ios -- --server ledge@10.0.0.4
//   bun run ios -- --device "iPhone 16 Pro"
//
// **A package manifest and a directory, not an Xcode project.** The app is a
// binary, a plist and the built view in a folder — which is what `swift build`
// and `cp` produce, and what `simctl` installs. A project file would be a
// second, generated description of the same three facts, unreadable in a diff
// and unverifiable except by opening Xcode. Phase 3 got away with a bare
// `swiftc` over a glob; phase 4 has a dependency to resolve (ios/Package.swift),
// which is the one thing a glob cannot do, and SwiftPM is the smaller of the
// two answers to that.
//
// Cross-compiled, and that is why the flags are doubled. SwiftPM builds for its
// host unless told otherwise and has no first-class iOS destination, so the
// target and the SDK are pushed through to both compilers; the last `-target`
// wins, which is why the output lands in a directory named for macOS and is an
// iOS Simulator binary (`vtool -show-build` says `IOSSIMULATOR`).
//
// Simulator only, and by construction: no signing identity is used and none is
// needed. A build for a device is the phase that needs a provisioning profile
// (ios.md §12).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

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
// arm64 only, like the Mac app (releasing.md). An Intel Mac's Simulator would
// need x86_64, and nothing else here is universal either.
const TRIPLE = `arm64-apple-ios${DEPLOYMENT}-simulator`;
const swiftpm = [
  "swift",
  "build",
  "--package-path",
  join(REPO, "ios"),
  // Release, because the numbers this build reports are the ones ios.md §5
  // quotes: a debug NIO would make the handshake a measurement of the
  // optimizer rather than of the protocol.
  "-c",
  "release",
  "-Xswiftc",
  "-sdk",
  "-Xswiftc",
  sdk,
  "-Xswiftc",
  "-target",
  "-Xswiftc",
  TRIPLE,
  "-Xcc",
  "-isysroot",
  "-Xcc",
  sdk,
  "-Xcc",
  "-target",
  "-Xcc",
  TRIPLE,
  // And once more for the clang that drives the link, which otherwise takes
  // the host's sysroot and warns on every build. A warning that is always
  // there is a warning nobody reads.
  "-Xswiftc",
  "-Xclang-linker",
  "-Xswiftc",
  "-isysroot",
  "-Xswiftc",
  "-Xclang-linker",
  "-Xswiftc",
  sdk,
  // Where the back-deployment shims below are put. The standard app layout,
  // and the one a signed device build will need.
  "-Xlinker",
  "-rpath",
  "-Xlinker",
  "@executable_path/Frameworks",
  // Entitlements, at LINK time and as a Mach-O section. This is the part of
  // simulator code signing that is not like the device's: simulated processes
  // get their entitlements from `__TEXT,__entitlements` in the binary, and a
  // signature that carries them instead is rejected at launch with a POSIX 153
  // and no explanation. A device build puts the same plist in the signature.
  "-Xlinker",
  "-sectcreate",
  "-Xlinker",
  "__TEXT",
  "-Xlinker",
  "__entitlements",
  "-Xlinker",
  join(REPO, "ios", "Resources", "Ledge.entitlements"),
];
await run(swiftpm);
// Asked rather than assumed: the directory is named for the HOST triple even
// though the bytes in it are the simulator's, which is a thing to read out of
// SwiftPM rather than to hardcode.
const binDir = (await run([...swiftpm, "--show-bin-path"], { quiet: true })).trim();
await run(["cp", join(binDir, "Ledge"), join(APP, "Ledge")]);

// The back-deployment shims. A binary built with this toolchain and run on an
// older iOS links a compatibility dylib for every standard-library type the
// runtime there does not have yet (`Span`, at the time of writing). Xcode
// copies them into the bundle as a matter of course; SwiftPM does not know it
// is building an app, so this does, and the symptom of not doing it is a dyld
// abort at launch with no other explanation.
//
// Which ones are needed is read out of the binary rather than listed here: the
// list belongs to the toolchain and changes with it. The copies come from the
// SIMULATOR directory, because the link picked them up from the host's.
const needed = (await run(["otool", "-L", join(APP, "Ledge")], { quiet: true }))
  .split("\n")
  .map((line) => line.trim().split(" ")[0] ?? "")
  .filter((path) => path.startsWith("@rpath/"))
  .map((path) => path.slice("@rpath/".length));
if (needed.length > 0) {
  const toolchain = dirname(dirname((await run(["xcrun", "--find", "swiftc"], { quiet: true })).trim()));
  mkdirSync(join(APP, "Frameworks"), { recursive: true });
  for (const dylib of needed) {
    const found = [...new Bun.Glob(`lib/swift-*/iphonesimulator/${dylib}`).scanSync({ cwd: toolchain, absolute: true })];
    if (found.length === 0) throw new Error(`the binary needs ${dylib}, and this toolchain ships no simulator copy of it`);
    await run(["cp", found[0]!, join(APP, "Frameworks", dylib)]);
  }
  console.log(`[ios] bundled ${needed.join(", ")}`);
}

await Bun.write(join(APP, "Info.plist"), Bun.file(join(REPO, "ios", "Resources", "Info.plist")));
await run(["plutil", "-replace", "CFBundleShortVersionString", "-string", version, join(APP, "Info.plist")]);
if (server !== null) {
  await run(["plutil", "-replace", "LedgeServer", "-string", server, join(APP, "Info.plist")]);
}

// The view as a bundle resource, under the one directory BundleScheme.swift
// will serve and nothing above it.
await run(["cp", "-R", join(REPO, "dist-ios"), join(APP, "view")]);

// --- the attribution the Swift closure asks for -------------------------------
//
// architecture.md §8: every dependency is an attribution, and a notice the
// user's copy does not carry is a notice that did not ship. The Mac app's
// THIRD-PARTY-NOTICES.md is generated from npm and committed, which is why a
// test has to catch it going stale; this one is generated from the resolved
// checkouts straight into the bundle, so there is no committed copy that can
// drift. Apache-2.0 §4 asks for the license AND any NOTICE file, so both
// travel. What is still owed is a way to READ it on the phone: the manual the
// app shows is the server's (ios.md §12).
const NOTICE_FILE = /^(LICEN[CS]E|COPYING|NOTICE)([-.].*)?$/i;
interface Pin {
  location: string;
  state: { version?: string; revision: string };
}
const resolved = JSON.parse(readFileSync(join(REPO, "ios", "Package.resolved"), "utf8")) as { pins: Pin[] };
const notices = [
  "# Third-Party Licenses",
  "",
  "Ledge is Apache-2.0: see LICENSE at the repository root. This file is the attribution for the Swift packages linked into the iOS app, generated from the resolved checkouts at build time.",
  "",
];
for (const pin of resolved.pins) {
  const name = pin.location.replace(/\.git$/, "").split("/").pop() ?? "";
  const dir = join(REPO, "ios", ".build", "checkouts", name);
  notices.push(`## ${name} ${pin.state.version ?? pin.state.revision}`, "", pin.location, "");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => NOTICE_FILE.test(f)) : [];
  // Nothing is invented: a checkout that publishes no license text gets a
  // pointer to its repository rather than the standard wording under a guessed
  // copyright holder.
  if (files.length === 0) notices.push("No license file in the published source; the canonical text is with the project.", "");
  for (const file of files.sort()) {
    notices.push(`### ${file}`, "", "```", readFileSync(join(dir, file), "utf8").trimEnd(), "```", "");
  }
}
await Bun.write(join(APP, "THIRD-PARTY-NOTICES.md"), `${notices.join("\n")}\n`);

// --- the signature ------------------------------------------------------------
//
// Ad hoc, and not for the reason signing usually exists. The Simulator does not
// check who signed this; the keychain checks that the process has an
// application identity at all, and answers errSecMissingEntitlement (-34018) to
// one that does not. The device key is a keychain item, so an unsigned bundle
// is an app that cannot mint a key and cannot pair.
//
// The entitlements are already in the binary as a section (above), so this
// signature carries none: passing them here is what makes the Simulator refuse
// to launch it at all.
//
// Inside out: a bundle's signature covers what is nested in it, so the shim has
// to be signed before the app that contains it.
for (const dylib of needed) {
  await run(["codesign", "--force", "--sign", "-", join(APP, "Frameworks", dylib)]);
}
await run(["codesign", "--force", "--sign", "-", APP]);

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
