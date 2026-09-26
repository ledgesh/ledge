// How a Windows release is signed: Azure Artifact Signing, through Microsoft's
// ArtifactSigning PowerShell module, the one Azure/artifact-signing-action runs
// (releasing.md §10). Two build hooks call it: scripts/sign-windows-app.ts
// signs the app's executables before Electrobun packs them, and
// scripts/sign-windows-setup.ts signs the installer after. This is the half of
// them that `bun test` can reach.

/**
 * The signing account and its certificate profile. Neither is a secret: Azure
 * lets only the release workflow's identity sign with them, and only from the
 * `windows-signing` environment on `main`.
 */
export const SIGNING = {
  endpoint: "https://eus.codesigning.azure.net",
  account: "ledge",
  profile: "ledgepublic",
} as const;

/** The module version the release workflow installs: the one
 * Azure/artifact-signing-action pins. */
export const SIGNING_MODULE_VERSION = "0.1.20";

/** Microsoft's timestamp service. The certificate lasts three days, and the
 * timestamp is what keeps a signature valid after it expires. */
export const TIMESTAMP_URL = "http://timestamp.acs.microsoft.com";

/**
 * Whether this build is signed: a Windows release build, unless
 * `LEDGE_UNSIGNED=1` asks for a dry run, as on a Mac. A dev build is never
 * signed. The hooks read the environment Electrobun gives them.
 */
export function signsWindows(env: Record<string, string | undefined>): boolean {
  return env["ELECTROBUN_OS"] === "win" && env["ELECTROBUN_BUILD_ENV"] !== "dev" && env["LEDGE_UNSIGNED"] !== "1";
}

/** Whether a file carries an Authenticode signature: executables and libraries. */
export function isSignable(path: string): boolean {
  return /\.(exe|dll)$/i.test(path);
}

/** The installer's zip among a release's artifacts: `win-x64-Ledge-Setup.zip`
 * on the stable channel, `…-Setup-canary.zip` on another. */
export function isSetupZip(name: string): boolean {
  return /-Setup(-[a-z]+)?\.zip$/i.test(name);
}

/** A PowerShell single-quoted string, in which nothing expands. */
export function psQuote(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function psArray(files: readonly string[]): string {
  return `@(${files.map(psQuote).join(", ")})`;
}

/**
 * A script that prints each of `files` whose signature Windows does not call
 * valid, one per line. A file someone else already signed, such as
 * WebView2Loader.dll, prints nothing and keeps its own signature.
 */
export function unsignedScript(files: readonly string[]): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `${psArray(files)} | Where-Object { (Get-AuthenticodeSignature -LiteralPath $_).Status -ne 'Valid' }`,
  ].join("\n");
}

// Every credential but the Azure CLI's, which `azure/login` signed in. The
// others are tried first by default, and the managed identity probe can stall
// on a runner that is itself an Azure VM.
const EXCLUDED_CREDENTIALS = [
  "Environment",
  "WorkloadIdentity",
  "ManagedIdentity",
  "SharedTokenCache",
  "VisualStudio",
  "VisualStudioCode",
  "AzurePowerShell",
  "AzureDeveloperCli",
  "InteractiveBrowser",
];

/** A script that signs `files` and timestamps each signature, with SHA-256 for both. */
export function signScript(files: readonly string[]): string {
  const args = [
    `-Endpoint ${psQuote(SIGNING.endpoint)}`,
    `-CodeSigningAccountName ${psQuote(SIGNING.account)}`,
    `-CertificateProfileName ${psQuote(SIGNING.profile)}`,
    `-Files ${psQuote(files.join(","))}`,
    "-FileDigest SHA256",
    `-TimestampRfc3161 ${psQuote(TIMESTAMP_URL)}`,
    "-TimestampDigest SHA256",
    ...EXCLUDED_CREDENTIALS.map((c) => `-Exclude${c}Credential:$true`),
  ];
  return [
    "$ErrorActionPreference = 'Stop'",
    `Import-Module ArtifactSigning -RequiredVersion ${SIGNING_MODULE_VERSION}`,
    `Invoke-ArtifactSigning ${args.join(" ")}`,
  ].join("\n");
}

/**
 * A script that copies the installer out of the release zip to `dir` and
 * prints its path. The entry is the zip's one top-level `.exe`; beside it is
 * the `.installer` folder that holds the app, which signing leaves alone.
 */
export function extractSetupScript(zip: string, dir: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$zip = [System.IO.Compression.ZipFile]::OpenRead(${psQuote(zip)})`,
    "try {",
    "  $entries = @($zip.Entries | Where-Object { $_.FullName -notmatch '[/\\\\]' -and $_.Name -like '*.exe' })",
    "  if ($entries.Count -ne 1) { throw \"expected one installer .exe at the top of the zip, found $($entries.Count)\" }",
    `  $out = Join-Path ${psQuote(dir)} $entries[0].Name`,
    "  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $out, $true)",
    "  $out",
    "} finally { $zip.Dispose() }",
  ].join("\n");
}

/**
 * A script that puts `exe` back into the release zip under its own name,
 * replacing the unsigned copy. Every other entry is left as it was, byte for
 * byte, so the `.installer` folder keeps whatever attributes Electrobun gave it.
 */
export function replaceSetupScript(zip: string, exe: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$name = Split-Path -Leaf ${psQuote(exe)}`,
    `$zip = [System.IO.Compression.ZipFile]::Open(${psQuote(zip)}, 'Update')`,
    "try {",
    "  $old = $zip.GetEntry($name)",
    "  if ($null -eq $old) { throw \"$name is not at the top of the zip\" }",
    "  $old.Delete()",
    `  [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, ${psQuote(exe)}, $name)`,
    "} finally { $zip.Dispose() }",
  ].join("\n");
}
