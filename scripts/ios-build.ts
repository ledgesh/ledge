// Build the iOS client and run it in the Simulator (ios.md §14, phase 4).
//
//   bun run ios                       build, install, launch, stream its log
//   bun run ios -- --build            build only
//   bun run ios -- --phone            the same, on a real device
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
// Two destinations, and `--phone` is the whole difference. The Simulator build
// needs no signing identity, because the Simulator checks none; a device checks
// everything, so the same bundle assembled seven ways differently is a
// different SDK, a different triple, different back-deployment shims, a real
// identity instead of an ad hoc one, entitlements in the signature instead of a
// Mach-O section, a provisioning profile inside the bundle, and `devicectl`
// instead of `simctl`. Every one of them is a `phone ?` below and each is
// commented where it sits, because each announced itself as a launch failure
// with no obvious cause (ios.md §12).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
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

// `--phone`, optionally naming one: `--phone <name-or-udid>`, as `xcrun
// devicectl list devices` prints it. The name is optional because most Macs
// have exactly one device paired, and `simctl`'s word for a simulator is
// already "device", so this flag is spelled for the hardware instead.
const phoneArg = flag("phone");
const phone = phoneArg !== null;
const phoneName = phoneArg && !phoneArg.startsWith("--") ? phoneArg : null;

// Outside the checkout, like the release credentials (releasing.md §3). It is
// not a secret — public certificates and a device UDID — but it belongs to one
// Apple team and one phone and it expires in a year, so it is this Mac's and
// not the repository's.
const PROFILE =
  flag("profile") ??
  process.env.LEDGE_IOS_PROFILE ??
  join(homedir(), ".config", "ledge", "ios-dev.mobileprovision");

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

// --- the provisioning profile -------------------------------------------------
//
// Read first, before anything is built, because every way it can be wrong is a
// way the app installs and then dies: a profile for another bundle id, one that
// does not name this phone, one whose certificate is not in this keychain, one
// that expired. Each of those is a sentence here rather than an alert on the
// phone with a number in it.
//
// It also decides two things this script would otherwise have to be told. The
// entitlements are generated from what the profile grants, rather than kept in
// a second checked-in plist that could disagree with it; and the identity is
// the certificate the profile itself names, matched into the keychain by SHA-1,
// so a Mac holding several Apple Development certificates signs with the one
// this profile will accept instead of the first one listed.

interface Profile {
  entitlements: Record<string, unknown>;
  devices: string[];
  /** A certificate SHA-1, which `codesign -s` takes and no two identities share. */
  identity: string;
  name: string;
}

async function readProfile(path: string): Promise<Profile> {
  if (!existsSync(path)) {
    throw new Error(
      `no provisioning profile at ${path}\n` +
        `Register an iOS App Development profile for ${BUNDLE_ID} at developer.apple.com, download it there, ` +
        `or name another with --profile or LEDGE_IOS_PROFILE (ios.md §12).`,
    );
  }
  mkdirSync(OUT, { recursive: true });
  const plist = join(OUT, "profile.plist");
  // A .mobileprovision is a CMS envelope around a plist and `security cms -D`
  // unwraps it. Nothing here checks the signature on it: the phone does, and a
  // profile this script accepted and the device refused is not a failure worth
  // catching twice.
  await run(["security", "cms", "-D", "-i", path, "-o", plist], { quiet: true });
  // Key at a time, because `plutil -convert json` refuses the whole thing: the
  // profile holds dates and JSON has no date, so the conversion fails on a file
  // that is otherwise perfectly readable.
  const at = async (key: string, format: "json" | "raw"): Promise<string> =>
    (await run(["plutil", "-extract", key, format, "-o", "-", plist], { quiet: true })).trim();

  const entitlements = JSON.parse(await at("Entitlements", "json")) as Record<string, unknown>;
  const name = await at("Name", "raw");
  const expires = await at("ExpirationDate", "raw");
  if (Date.parse(expires) < Date.now()) {
    throw new Error(`the profile "${name}" expired on ${expires}; download a new one`);
  }

  // A distribution profile has no device list at all, which is the loudest way
  // to have brought the wrong file.
  const devices = readFileSync(plist, "utf8").includes("<key>ProvisionedDevices</key>")
    ? (JSON.parse(await at("ProvisionedDevices", "json")) as string[])
    : [];
  if (devices.length === 0) {
    throw new Error(`the profile "${name}" provisions no devices; a device build needs a DEVELOPMENT profile`);
  }

  const team = String(entitlements["com.apple.developer.team-identifier"] ?? "");
  const appId = String(entitlements["application-identifier"] ?? "");
  const wanted = `${team}.${BUNDLE_ID}`;
  const matches = appId === wanted || (appId.endsWith(".*") && wanted.startsWith(appId.slice(0, -1)));
  if (!matches) {
    throw new Error(`the profile "${name}" is for ${appId}, and this app is ${wanted}`);
  }

  const der = join(OUT, "profile-cert.der");
  await Bun.write(der, Buffer.from(await at("DeveloperCertificates.0", "raw"), "base64"));
  const printed = await run(["openssl", "x509", "-inform", "DER", "-in", der, "-noout", "-fingerprint", "-sha1"], {
    quiet: true,
  });
  const identity = (printed.trim().split("=")[1] ?? "").replaceAll(":", "");
  const installed = await run(["security", "find-identity", "-v", "-p", "codesigning"], { quiet: true });
  if (!identity || !installed.includes(identity)) {
    throw new Error(
      `the certificate "${name}" was issued to is not in this keychain (SHA-1 ${identity || "unreadable"})\n` +
        `Xcode > Settings > Accounts > Manage Certificates mints one together with its private key. ` +
        `A certificate downloaded from developer.apple.com without the key that requested it cannot sign anything.`,
    );
  }
  return { entitlements, devices, identity, name };
}

const profile = phone ? await readProfile(PROFILE) : null;
if (profile) console.log(`[ios] profile "${profile.name}", ${profile.devices.length} device(s)`);

// --- the view ----------------------------------------------------------------

console.log("[ios] building the view");
await run(["bunx", "vite", "build", "--config", "vite.ios.config.ts"]);
if (!existsSync(join(REPO, "dist-ios", "ios.html"))) {
  throw new Error("dist-ios/ios.html is missing; the view build produced nothing to bundle");
}

// --- the bundle --------------------------------------------------------------

rmSync(APP, { recursive: true, force: true });
mkdirSync(APP, { recursive: true });

console.log(`[ios] compiling the shell for ${phone ? "a device" : "the Simulator"}`);
// The platform name is most of the difference between the two builds, and it
// comes back below for the back-deployment shims, which have to be taken out of
// the same one: a simulator dylib on a phone is a dyld abort at launch.
const PLATFORM = phone ? "iphoneos" : "iphonesimulator";
const sdk = (await run(["xcrun", "--sdk", PLATFORM, "--show-sdk-path"], { quiet: true })).trim();
// arm64 only, like the Mac app (releasing.md). An Intel Mac's Simulator would
// need x86_64, and nothing else here is universal either. The `-simulator`
// suffix is not decoration: it selects a different ABI, and dropping it is the
// whole of what makes the same source a device binary.
const TRIPLE = `arm64-apple-ios${DEPLOYMENT}${phone ? "" : "-simulator"}`;
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
];
// Entitlements at LINK time and as a Mach-O section, and only for the
// Simulator. This is the part of simulator code signing that is not like the
// device's: simulated processes read their entitlements from
// `__TEXT,__entitlements` in the binary, and a signature carrying them instead
// is rejected at launch with a POSIX 153 and no explanation. A device reads the
// signature and nothing else, so the device build puts them there (below) and
// omits the section rather than shipping a second, stale copy of the same
// claims under an identifier with no team prefix.
if (!phone) {
  swiftpm.push(
    "-Xlinker",
    "-sectcreate",
    "-Xlinker",
    "__TEXT",
    "-Xlinker",
    "__entitlements",
    "-Xlinker",
    join(REPO, "ios", "Resources", "Ledge.entitlements"),
  );
}
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
// DESTINATION's directory, because the link picked them up from the host's, and
// a simulator dylib inside a device bundle is the same abort by another route.
const needed = (await run(["otool", "-L", join(APP, "Ledge")], { quiet: true }))
  .split("\n")
  .map((line) => line.trim().split(" ")[0] ?? "")
  .filter((path) => path.startsWith("@rpath/"))
  .map((path) => path.slice("@rpath/".length));
if (needed.length > 0) {
  const toolchain = dirname(dirname((await run(["xcrun", "--find", "swiftc"], { quiet: true })).trim()));
  mkdirSync(join(APP, "Frameworks"), { recursive: true });
  for (const dylib of needed) {
    const found = [...new Bun.Glob(`lib/swift-*/${PLATFORM}/${dylib}`).scanSync({ cwd: toolchain, absolute: true })];
    if (found.length === 0) throw new Error(`the binary needs ${dylib}, and this toolchain ships no ${PLATFORM} copy of it`);
    await run(["cp", found[0]!, join(APP, "Frameworks", dylib)]);
  }
  console.log(`[ios] bundled ${needed.join(", ")}`);
}

const plistPath = join(APP, "Info.plist");
await Bun.write(plistPath, Bun.file(join(REPO, "ios", "Resources", "Info.plist")));
await run(["plutil", "-replace", "CFBundleShortVersionString", "-string", version, plistPath]);
if (server !== null) {
  await run(["plutil", "-replace", "LedgeServer", "-string", server, plistPath]);
}

// Five keys Xcode writes that a hand-assembled bundle has to write itself, and
// only a device wants them. `CFBundleSupportedPlatforms` is the load-bearing
// one: installd refuses a bundle that does not claim the platform it is being
// installed on, and what it says back is that the bundle is invalid rather than
// which key is missing. The DT keys describe what built it, and they are asked
// of `xcrun` rather than written down, because a hardcoded SDK version is a
// lie one Xcode update later.
if (phone) {
  const sdkVersion = (await run(["xcrun", "--sdk", PLATFORM, "--show-sdk-version"], { quiet: true })).trim();
  const sdkBuild = (await run(["xcrun", "--sdk", PLATFORM, "--show-sdk-build-version"], { quiet: true })).trim();
  await run(["plutil", "-replace", "CFBundleSupportedPlatforms", "-json", '["iPhoneOS"]', plistPath]);
  await run(["plutil", "-replace", "DTPlatformName", "-string", PLATFORM, plistPath]);
  await run(["plutil", "-replace", "DTPlatformVersion", "-string", sdkVersion, plistPath]);
  await run(["plutil", "-replace", "DTSDKName", "-string", `${PLATFORM}${sdkVersion}`, plistPath]);
  await run(["plutil", "-replace", "DTSDKBuild", "-string", sdkBuild, plistPath]);

  // The profile, under the one name the installer looks for. It is not
  // configuration and nothing here reads it again: the phone reads it, checks
  // its own UDID is in the list, and checks that what the signature claims is
  // a subset of what it grants.
  await Bun.write(join(APP, "embedded.mobileprovision"), Bun.file(PROFILE));
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
// On the Simulator, ad hoc, and not for the reason signing usually exists. The
// Simulator does not check who signed this; the keychain checks that the
// process has an application identity at all, and answers
// errSecMissingEntitlement (-34018) to one that does not. The device key is a
// keychain item, so an unsigned bundle is an app that cannot mint a key and
// cannot pair. Its entitlements are already in the binary as a section (above),
// so that signature carries none.
//
// On a device, a real identity and the entitlements in the signature: the same
// fact inverted. What goes in them is generated from the profile rather than
// read from ios/Resources/Ledge.entitlements, because it is the profile that
// decides what the identifier really is (ios.md §4), and a checked-in copy of a
// team-prefixed identifier is a copy that can disagree with it.
//
// Three claims, and deliberately not a fourth. `keychain-access-groups` is
// absent: DeviceKey.swift never names an access group, so its items land in the
// app's default one, which `application-identifier` grants on its own. Claiming
// the group as well would put Keychain Sharing on the App ID for nothing.
const signature: string[] = [];
let identity = "-";
if (phone && profile) {
  identity = profile.identity;
  // The CONCRETE identifier, assembled from the team rather than copied out of
  // the profile, because a wildcard profile says `TEAM.*` and a signature may
  // not: what is claimed here has to be an app, and what the profile grants has
  // to be a superset of it.
  const team = String(profile.entitlements["com.apple.developer.team-identifier"] ?? "");
  const ent = join(OUT, "Ledge.device.entitlements");
  await Bun.write(
    ent,
    JSON.stringify({
      "application-identifier": `${team}.${BUNDLE_ID}`,
      "com.apple.developer.team-identifier": team,
      // Whatever the profile allows: a development profile says true, and it is
      // what lets `devicectl` attach to the process and stream its output.
      "get-task-allow": profile.entitlements["get-task-allow"] === true,
    }),
  );
  await run(["plutil", "-convert", "xml1", ent]);
  // iOS 15 and later read entitlements out of a DER blob rather than the plist,
  // and a signature carrying only the plist is accepted at install and killed
  // at launch.
  signature.push("--entitlements", ent, "--generate-entitlement-der");
}

// Inside out: a bundle's signature covers what is nested in it, so the shim has
// to be signed before the app that contains it. The shims carry no entitlements
// of their own, and on a device they still take the same identity: one bundle
// signed by two hands is a bundle the device refuses.
for (const dylib of needed) {
  await run(["codesign", "--force", "--sign", identity, join(APP, "Frameworks", dylib)]);
}
await run(["codesign", "--force", "--sign", identity, ...signature, APP]);

const size = (await run(["du", "-sh", APP], { quiet: true })).split("\t")[0];
console.log(`[ios] ${APP} (${size?.trim()}), version ${version}`);
if (buildOnly) process.exit(0);

// --- the phone ----------------------------------------------------------------
//
// `devicectl` where the Simulator has `simctl`, and the three steps line up one
// for one: list, install, launch with the console attached. What it has no need
// of is a boot step, because a phone is either there or it is not.
//
// Every devicectl command on some Macs prints "Failed to load provisioning
// paramter list" (Apple's typo) to stderr and then works. It is about a
// subsystem none of this uses, and the exit code is zero.
if (phone && profile) {
  interface CoreDevice {
    deviceProperties: { name: string };
    hardwareProperties: { udid: string; marketingName: string };
    connectionProperties: { tunnelState: string };
  }
  const listing = join(OUT, "devices.json");
  await run(["xcrun", "devicectl", "list", "devices", "--json-output", listing], { quiet: true });
  const paired = (JSON.parse(readFileSync(listing, "utf8")) as { result: { devices: CoreDevice[] } }).result.devices;

  if (paired.length === 0) {
    throw new Error("no devices are paired with this Mac; connect the phone, unlock it, and trust this computer");
  }
  if (!phoneName && paired.length > 1) {
    const names = paired.map((d) => d.deviceProperties.name).join(", ");
    throw new Error(`${paired.length} devices are paired (${names}); name one with --phone <name>`);
  }
  const target = phoneName
    ? paired.find((d) => d.deviceProperties.name === phoneName || d.hardwareProperties.udid === phoneName)
    : paired[0];
  if (!target) throw new Error(`no paired device called ${phoneName}; xcrun devicectl list devices`);

  const udid = target.hardwareProperties.udid;
  const name = target.deviceProperties.name;
  // Asked here rather than left to the installer, because a phone that is not
  // in the profile fails at install with a code and a sentence about the
  // application being invalid, which is true and points nowhere.
  if (!profile.devices.includes(udid)) {
    throw new Error(
      `${name} (${udid}) is not one of the ${profile.devices.length} device(s) in the profile "${profile.name}"\n` +
        `Register it at developer.apple.com under Devices, add it to the profile, and download the profile again.`,
    );
  }
  if (target.connectionProperties.tunnelState !== "connected") {
    console.log(`[ios] ${name} is ${target.connectionProperties.tunnelState}; unlock it, and plug it in if this hangs`);
  }

  console.log(`[ios] installing on ${name} (${target.hardwareProperties.marketingName})`);
  try {
    await run(["xcrun", "devicectl", "device", "install", "app", "--device", udid, APP], { quiet: true });
  } catch (failed) {
    // The first install onto a phone that has never had one always fails this
    // way, and the toggle it names does not appear in Settings until something
    // has tried, so it cannot be turned on in advance.
    console.error(
      "\n[ios] if that says Developer Mode is disabled: on the phone, Settings > Privacy & Security >\n" +
        "      Developer Mode, turn it on, restart the phone, and run this again.\n",
    );
    throw failed;
  }

  // `--console` is the device's `--console-pty`: the shell's print() lines and
  // every boot number the view reports come out here, and Ctrl-C detaches and
  // leaves the app running. The trailing arguments reach the app's argv, which
  // is where UserDefaults finds `-LedgeServer` (ShellConfig.swift).
  console.log(`[ios] launching; Ctrl-C detaches\n`);
  const launch = [
    "xcrun",
    "devicectl",
    "device",
    "process",
    "launch",
    "--device",
    udid,
    "--console",
    "--terminate-existing",
    BUNDLE_ID,
  ];
  // `--` first, and it is not optional: devicectl parses its own flags out of
  // everything after the bundle id too, so `-LedgeServer` comes back as
  // "Unknown option '-L'". simctl takes the same pair with no separator, which
  // is why the two lines below this one and above it do not match.
  if (server !== null) launch.push("--", "-LedgeServer", server);
  await run(launch);
  process.exit(0);
}

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
