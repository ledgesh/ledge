// Build the Android client and run it in the emulator.
//
//   bun run android                          build, install, launch, stream its log
//   bun run android -- --build               build only
//   bun run android -- --store               a Play Store bundle, signed with the upload key
//   bun run android -- --test                the Kotlin unit tests, on this Mac's JVM
//   bun run android -- --server ledge@10.0.2.2 --port 2222
//   bun run android -- --avd ledge-pixel     which emulator to boot if none is running
//   bun run android -- --headless            boot it with no window
//
// `--server` points a debug build at a server without a person tapping Trust on
// the pairing screen. The pin is scanned here, from this Mac, unless `--hostkey`
// names one: 10.0.2.2 is the emulator's name for this Mac's loopback, so the
// scan asks 127.0.0.1 instead. A release build ignores all of it
// (android/.../WebHost.kt `adoptLaunchServer`).
//
// `--store` is the release build as an .aab, signed with the upload key
// (android.md §8), written to build/android/Ledge-<version>-<build>.aab for
// the Play Console. It installs nothing.
//
// The unit tests hold PairingCode.kt to shared/pairing.vectors.json, beside
// the TypeScript and Swift readers (remote.md §4b).
//
// Needs a JDK 21 and the Android SDK, and no Android Studio: JAVA_HOME and
// ANDROID_HOME default to where Homebrew's openjdk@21 and the command-line
// tools put them.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const ANDROID = join(REPO, "android");
const APK = join(ANDROID, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const PACKAGE = "sh.ledge.android";

const argv = Bun.argv.slice(2);
const flag = (name: string): string | null => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? (argv[at + 1] ?? "") : null;
};
const buildOnly = argv.includes("--build");
const store = argv.includes("--store");
const testOnly = argv.includes("--test");
const headless = argv.includes("--headless");
const avd = flag("avd") ?? "ledge-pixel";
const server = flag("server");
const port = flag("port");
let hostKey = flag("hostkey");

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  JAVA_HOME: process.env["JAVA_HOME"] ?? "/opt/homebrew/opt/openjdk@21",
  ANDROID_HOME: process.env["ANDROID_HOME"] ?? join(homedir(), "Library", "Android", "sdk"),
};
const sdk = (...parts: string[]): string => join(env["ANDROID_HOME"]!, ...parts);
const adb = sdk("platform-tools", "adb");

async function run(cmd: string[], opts: { cwd?: string; quiet?: boolean } = {}): Promise<string> {
  const proc = Bun.spawn({
    cmd,
    cwd: opts.cwd ?? REPO,
    env,
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

if (!existsSync(env["JAVA_HOME"]!)) throw new Error(`no JDK at ${env["JAVA_HOME"]}; brew install openjdk@21, or set JAVA_HOME`);
if (!existsSync(adb)) throw new Error(`no Android SDK at ${env["ANDROID_HOME"]}; install the command-line tools, or set ANDROID_HOME`);

if (testOnly) {
  console.log("[test] gradle testDebugUnitTest");
  await run(["./gradlew", "-q", "testDebugUnitTest"], { cwd: ANDROID });
  console.log("  passed");
  process.exit(0);
}

console.log("[view] vite build --config vite.android.config.ts");
await run(["bunx", "vite", "build", "--config", "vite.android.config.ts", "--logLevel", "warn"]);
if (!existsSync(join(REPO, "dist-android", "android.html"))) {
  throw new Error("dist-android/android.html is missing; the view build produced nothing to bundle");
}

const version = (await Bun.file(join(REPO, "package.json")).json()).version as string;
// Play refuses a second upload with the same versionCode, and the commit count
// only goes up. The iOS build number is the same count.
const buildNumber = (await run(["git", "rev-list", "--count", "HEAD"], { quiet: true })).trim();
const versions = [`-PledgeVersion=${version}`, `-PledgeBuild=${buildNumber}`];

if (store) {
  const keystore = process.env["LEDGE_ANDROID_KEYSTORE"] ?? join(homedir(), ".config", "ledge", "android-upload.jks");
  if (!existsSync(keystore)) {
    throw new Error(`no upload keystore at ${keystore}; android.md §8 has the keytool line, or set LEDGE_ANDROID_KEYSTORE`);
  }
  // The password from the login keychain, so release.env stays free of
  // secrets (releasing.md §3). Gradle reads both from the environment.
  const password =
    process.env["LEDGE_ANDROID_KEYSTORE_PASSWORD"] ??
    (await run(["security", "find-generic-password", "-s", "ledge-android-upload", "-w"], { quiet: true }).catch(() => {
      throw new Error("no ledge-android-upload item in the keychain; android.md §8 has the security line that adds it");
    })).trim();
  env["LEDGE_ANDROID_KEYSTORE"] = keystore;
  env["LEDGE_ANDROID_KEYSTORE_PASSWORD"] = password;

  console.log(`[aab] gradle bundleRelease, version ${version} (${buildNumber})`);
  await run(["./gradlew", "-q", "bundleRelease", ...versions], { cwd: ANDROID });
  const aab = join(ANDROID, "app", "build", "outputs", "bundle", "release", "app-release.aab");
  // A bundle the upload key did not sign is refused by the Play Console, and
  // says so only after the upload.
  const verified = await run([join(env["JAVA_HOME"]!, "bin", "jarsigner"), "-verify", aab], { quiet: true }).catch(() => "");
  if (!verified.includes("jar verified")) throw new Error(`${aab} is not signed; check the upload keystore's alias is "upload"`);
  const out = join(REPO, "build", "android");
  mkdirSync(out, { recursive: true });
  const named = join(out, `Ledge-${version}-${buildNumber}.aab`);
  copyFileSync(aab, named);
  console.log(`  ${named}`);
  process.exit(0);
}

console.log("[apk] gradle assembleDebug");
await run(["./gradlew", "-q", "assembleDebug", ...versions], { cwd: ANDROID });
console.log(`  ${APK}`);
if (buildOnly) process.exit(0);

// --- a device ------------------------------------------------------------------

const devices = async (): Promise<string[]> =>
  (await run([adb, "devices"], { quiet: true }))
    .split("\n")
    .slice(1)
    .filter((line) => line.trim().endsWith("device"))
    .map((line) => line.split("\t")[0]!);

if ((await devices()).length === 0) {
  console.log(`[device] booting ${avd}${headless ? " with no window" : ""}`);
  // Detached, so the emulator outlives this script and the next run reuses it.
  Bun.spawn({
    cmd: [sdk("emulator", "emulator"), "-avd", avd, ...(headless ? ["-no-window", "-no-audio"] : [])],
    env,
    stdout: "ignore",
    stderr: "ignore",
  }).unref();
  await run([adb, "wait-for-device"], { quiet: true });
  for (let i = 0; ; i++) {
    // A first boot reports the device offline for a while after
    // wait-for-device returns, which is the same answer as not booted yet.
    const booted = (await run([adb, "shell", "getprop", "sys.boot_completed"], { quiet: true }).catch(() => "")).trim();
    if (booted === "1") break;
    if (i > 120) throw new Error(`${avd} did not finish booting in two minutes`);
    await Bun.sleep(1000);
  }
}

console.log("[install] adb install");
await run([adb, "install", "-r", APK], { quiet: true });

// --- the server to point it at -----------------------------------------------

if (server !== null && hostKey === null) {
  const host = server.slice(server.lastIndexOf("@") + 1);
  const scanned = host === "10.0.2.2" ? "127.0.0.1" : host;
  const scan = await run(["ssh-keyscan", "-T", "3", ...(port ? ["-p", port] : []), scanned], { quiet: true }).catch(() => "");
  const lines = scan.split("\n").filter((line) => line && !line.startsWith("#"));
  // The same preference the Mac's pairing has: ed25519 when offered.
  const line = lines.find((l) => l.split(" ")[1] === "ssh-ed25519") ?? lines[0];
  if (!line) throw new Error(`${scanned}${port ? `:${port}` : ""} offered no host key to ssh-keyscan; is its sshd up?`);
  hostKey = line.split(" ").slice(1, 3).join(" ");
  console.log(`[pin] ${hostKey.slice(0, 40)}…`);
}

// `adb shell` hands the device's shell one string, so every argument is quoted
// for it.
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const extras = [
  ...(server !== null ? ["-e", "server", server] : []),
  ...(port !== null ? ["-e", "port", port] : []),
  ...(hostKey !== null ? ["-e", "hostkey", hostKey] : []),
];

await run([adb, "logcat", "-c"], { quiet: true });
// -S stops a running copy first, so the launch is a boot and not a resume.
await run([adb, "shell", ["am", "start", "-S", "-n", `${PACKAGE}/.WebHost`, ...extras].map(quote).join(" ")], {
  quiet: true,
});
console.log("[run] launched; the log follows (Ctrl-C stops the log, not the app)\n");
await run([adb, "logcat", "-v", "brief", "ledge:V", "chromium:W", "AndroidRuntime:E", "*:S"]);
