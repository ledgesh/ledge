# Releasing Ledge

How a build becomes something someone else can install: a DMG from this Mac,
and Linux and Windows installers from GitHub's runners. Read this before
cutting a release; it is run rarely enough that nobody remembers it.

`bun run release` is the whole procedure on every platform. §1 to §5 are the
Mac's: what it needs, what it produces, and what to check before publishing.
§9 is the Linux build and §10 the Windows build: the same command with nothing
to sign, run by a workflow.

## 1. What a release consists of

`bun run release` writes these files to `artifacts/` (gitignored):

| File | What it is |
| --- | --- |
| `macos-arm64-Ledge.dmg` | What users download. Contains the self-extracting app and a symlink to `/Applications`. The site's Download buttons and the README link to it by this name under `releases/latest/download/`, so a release that renames it breaks them. |
| `stable-macos-arm64-Ledge.app.tar.zst` | The app itself, compressed. The updater downloads it when no patch applies. |
| `stable-macos-arm64-update.json` | The manifest the updater reads (§7). |
| `stable-macos-arm64-<hash>.patch` | A binary diff from the previous release's build, named by that build's hash, to this one. Written only when the update server was serving a previous release during the build. |

Every release uploads all of them. A missing patch costs installs a full
download. A missing tarball or manifest breaks the update. A Linux release
adds the same three kinds of file per architecture, built and uploaded by the
workflow in §9, and a Windows release adds them once more, for x64 (§10).

Two app bundles get built, and both are signed:

- **The app.** `build/stable-macos-arm64/Ledge.app` while it exists, then tarred
  into the `.tar.zst` and deleted.
- **The self-extracting wrapper.** A small bundle carrying that tarball in its
  Resources. It is what the DMG holds and what a user drags to `/Applications`.
  On first launch it decompresses the tarball into
  `~/Library/Application Support/sh.ledge.app/stable/self-extraction/` and
  replaces itself in place with the real app.

Consequences of that design worth knowing: the app a user launches on day two
is not the bundle they installed on day one, and the extraction leaves its
`.tar` behind in Application Support.

Arm64 only, and a decision rather than a default: an x86_64 slice would ship
with the PTY dylib and the whole native seam untested, because there is no
Intel Mac here to run it on. Electrobun 2.x builds for the build host and has
no `targets` key to say this in, so the guarantee is `scripts/release-preflight.ts`
refusing to start on anything but arm64. Cutting a release on an Intel Mac is
the failure that check exists to prevent.

## 2. Version numbers

The version lives in three files and all of them must say the same thing:

- `package.json` → `version`
- `electrobun.config.ts` → `app.version`
- `src/shared/version.ts` → `BUILD_VERSION`, which is what a server reports in
  its handshake, since it has no Electrobun runtime to ask

A fourth carries it and is not edited: the published `ledge-server` manifest is
generated from `package.json` by `scripts/build-npm.ts`, which is what keeps a
server's handshake naming a build somebody can actually install.
`src/bun/release.test.ts` pins all four together.

`electrobun.config.ts` is the one that reaches the bundle. It becomes
`CFBundleVersion`, and `scripts/stamp-version.ts` copies it into
`CFBundleShortVersionString` (electrobun does not write that key, and without it
the About panel and Finder's Get Info have no version to show). The preflight
and `src/bun/release.test.ts` both fail when the two files disagree.

`update.json` carries the same version, but the version is not what the updater
compares. It compares the build's hash (§7).

## 3. What signing needs

Ledge signs and notarizes under **individual** Apple Developer enrollment. The
Team ID that comes with it is semi-permanent: changing it later invalidates
every Keychain item the vault stored (`locking.md` §3).

Two credentials, both from the same Apple account:

1. **A Developer ID Application certificate**, in this Mac's keychain. Create it
   at developer.apple.com under Certificates, or let Xcode do it from Settings >
   Accounts > Manage Certificates. `security find-identity -v -p codesigning`
   lists what is installed; the full string it prints is what
   `ELECTROBUN_DEVELOPER_ID` wants.
2. **Notarization credentials**, either kind:
   - An App Store Connect API key (`.p8` file, key ID, issuer ID). Preferred:
     it is revocable on its own and carries no account password. It must be a
     **Team Key**, not an Individual Key: only Team Keys have an issuer ID, and
     electrobun's notarization path requires all three values.
   - An Apple ID with an app-specific password, plus the Team ID.

Environment variables, read by electrobun's build:

| Variable | For | Value |
| --- | --- | --- |
| `ELECTROBUN_DEVELOPER_ID` | signing | `Developer ID Application: Name (TEAMID)` |
| `ELECTROBUN_APPLEAPIKEYPATH` | notarizing (API key) | path to the `.p8` |
| `ELECTROBUN_APPLEAPIKEY` | notarizing (API key) | the key ID |
| `ELECTROBUN_APPLEAPIISSUER` | notarizing (API key) | the issuer UUID |
| `ELECTROBUN_APPLEID` | notarizing (Apple ID) | the account email |
| `ELECTROBUN_APPLEIDPASS` | notarizing (Apple ID) | app-specific password |
| `ELECTROBUN_TEAMID` | notarizing (Apple ID) | the Team ID |

Keep them out of the repo. A file outside the checkout that you `source`, or
`security add-generic-password` and read them back, both work; a `.env` in the
tree is one `git add -A` from being public.

Notarization also needs `xcrun notarytool`, which ships with Xcode and not with
the Command Line Tools alone.

`bun scripts/release-preflight.ts` checks all of the above and names the fix for
whatever is missing. Two of its checks go further than reading variables: the
signing identity is matched against the keychain, and the notarization
credentials are put to Apple via `notarytool history`. Both failures otherwise
surface at the end of a build that takes minutes. `bun run release` runs the
preflight first for that reason.

## 4. Cutting a release

1. Set the version in both files (§2). Commit.
2. Run the green bar (`testing.md` §7). CI runs it too, but a release should not
   be the first time it ran.
3. `bun run release`. Expect several minutes: the tarball compresses for about
   ten seconds and notarization is two round trips to Apple.
4. Verify the artifact (§5).
5. Tag the commit `v<version>` and push the tag. Create the GitHub release on
   `ledgesh/ledge` as a draft, with every file in `artifacts/`.
6. Run the Linux workflow (§9) and the Windows workflow (§10) on the tag. They
   upload their files to the draft.
7. Publish the release, then publish the tag to the update server for every
   prefix (§7). Publishing the tag is the step that offers the release to every
   existing install.

Add `LEDGE_UNSIGNED=1` to package without signing or notarizing. That is for
exercising the packaging path itself, and the app it produces runs on the
machine that built it and nowhere else: Gatekeeper refuses an unsigned bundle
everywhere else, which is the entire point of the exercise.

**Whatever runs the build needs Removable Volumes access.** `hdiutil create`
mounts a staging volume at `/Volumes/Ledge` and copies the app onto it, and
macOS treats that as a removable volume. Without the grant the build gets
through signing and both notarization round trips, then dies at the very last
step:

```
hdiutil: create failed - Operation not permitted
could not access /Volumes/Ledge/Ledge.app - Operation not permitted
```

The matching denial is in the unified log as
`System Policy: copy-helper(…) deny(1) file-write-create /Volumes/Ledge/…`.
Grant it under System Settings > Privacy & Security > Files and Folders, to the
terminal or editor the build is launched from, and note that the grant belongs
to that app rather than to the release script: running the same command from a
different terminal asks the question again.

## 5. Verifying before publishing

Static checks on the DMG, all of which must pass:

```
codesign --verify --deep --strict --verbose=2 <app>
spctl --assess --type execute --verbose <app>       # expects "accepted, source=Notarized Developer ID"
xcrun stapler validate <dmg>
```

Then the live checks, on a **copy that has been through the DMG** rather than on
`build/`. Quarantine and the hardened runtime only apply to the real thing, and
every item below is a place where a signed build can differ from the dev build
that all other testing uses:

- The app launches from `/Applications`. One "Ledge is an app downloaded from
  the Internet. Are you sure you want to open it?" prompt is correct and
  expected on first launch, and it does not appear again. The failure to watch
  for is the other dialog, the one that says the developer cannot be verified
  and offers no Open button: that is Gatekeeper refusing the signature.
- A shell block runs, and Ctrl-C stops it. This is `dlopen` of the PTY dylib
  under library validation.
- ⌘V of a screenshot embeds an image. This is `osascript` as a child process,
  which is an Apple-events path TCC can refuse.
- `views://` still serves the view (it loads at all, so this is implied, but a
  scheme handler is exactly the sort of thing hardening breaks).
- Run Install Shell Command (ledge), then `ledge ls` in a new terminal. The
  shim execs the bundle's own `bun`, from outside the bundle.
- Open a workspace under `~/Documents` or `~/Desktop` and confirm the TCC prompt
  appears and, once granted, that notes read and write.
- Ledge > Check for Updates… answers "Ledge <version> is the latest version."
  That is the answer before the release is published to the update server (a
  404) and after (a manifest naming this build's own hash). An error strip here
  is the updater's fetch failing under the hardened runtime.

A signed build that fails one of these is not a release; it is a bug in the
entitlements (`build.mac.entitlements` in `electrobun.config.ts`).

### App Translocation, and why the install path is part of the test

A quarantined copy of the app that Finder did not move runs from a read-only
randomized mount under `/private/var/folders/…/AppTranslocation/`. The
self-extractor then unpacks the tarball into Application Support, cannot
replace itself at its own path because that path is read-only, and quits
without launching anything. Nothing appears on screen, and a second
double-click does the same thing.

| How the app got there | Translocated | Result |
| --- | --- | --- |
| Dragged from the DMG to `/Applications` in Finder | no | works |
| Double-clicked inside the mounted DMG | yes | extracts, then quits |
| Copied with `cp` or `ditto`, then launched | yes | extracts, then quits |

Moving an app in Finder is what clears translocation, which is why only the
first row survives. The extractor is a prebuilt binary inside electrobun, so
this is not fixable here; it is an instruction instead. Anywhere the DMG is
offered has to say to drag Ledge to Applications and open it from there.

Verifying a release therefore means installing it the way the instructions
say, in Finder. An install done with `ditto` from a terminal reproduces the
failure rather than the release.

## 6. Publishing the server package

The app is half of a release. `ledge-server` on npm is the other half, and it
is what `docs/user/09-keep-notes-on-a-remote-server.md` tells a user to install on
the machine their notes live on. A release that ships the app without it leaves
that page describing a package that does not exist.

Assemble it on this Mac, and only on this Mac:

```
bun run build:server
```

It runs `build:npm` first. The Mach-O trampolines need a Mac and the ELF ones
need a container per architecture (a Linux host compiles its own without one),
so a complete package cannot be assembled anywhere else (`remote.md` §11).
Docker has to be running. `build:npm` refuses
rather than shipping three targets out of four, and it writes
`dist-npm/package.json` last so a half-assembled tree cannot be packed. Then
`build:server` packs that tree and writes `dist-server/`:

| File | What it is |
| --- | --- |
| `ledge-server-<version>.tgz` | The package, packed by `npm pack`. This file is what gets published. |
| `server.sh` | The install script: `release/server.sh` with this version, the tarball's SHA-256 and the pinned Bun written in. |
| `SHA256SUMS` | The SHA-256 of both files above. |

It also downloads each target's pinned Bun tarball into `dist-bun/` and stops
when one does not match its pin, so a script cannot ship naming a Bun the
registry does not serve.

Then prove the thing you are about to publish actually works:

```
bun run probe:npm
bun run probe:install
```

`probe:npm` packs the tree, installs it with `bun add -g` on a container with no
compiler and no libc headers, and drives a terminal on it. `probe:install` runs
`server.sh` on Debian, Ubuntu and Alpine against a directory laid out like the
registry, dials the result through sshd, and updates it. Those fixtures are the
point: they are the machines a user has, and the ones this checkout is least
like. `probe:install` needs the host's two targets, so on an Apple silicon Mac
`--targets=darwin-arm64,linux-arm64` is enough for a quick check; build without
`--targets` before a release. Its update step waits for a daemon's idle exit, so
it takes a few minutes.

Publishing is deliberately not a script, and it publishes the packed file:

```
npm publish ./dist-server/ledge-server-<version>.tgz
```

`server.sh` carries that file's SHA-256. `npm publish` uploads a `.tgz` as it
is and records its sha512, which every npm client checks what it downloads
against, so the registry serves those bytes unchanged. `npm publish ./dist-npm`
would pack the directory again, and
nothing promises a second pack compresses to the same bytes. A script whose
checksum names different bytes refuses every install. Check it once the
publish returns; the hash has to equal the tarball's line in `SHA256SUMS`:

```
curl -fsSL https://registry.npmjs.org/ledge-server/-/ledge-server-<version>.tgz | shasum -a 256
```

The `./` is not decoration. npm reads a bare path as a package name to
resolve against the registry and fails with a 404 for a package nobody has
published, which is a confusing way to learn that an argument was a path.

It is irreversible in the way signing is not. An npm version can be deprecated
but never replaced, so the version has to be right before the command runs, and
`src/bun/release.test.ts` is what checks that it matches the app's.

Two things to know before the first publish. The name `ledge-server` has to be
available or owned by the publishing account, and `npm publish` on a package
that has never existed also decides the account that owns it forever. Neither
is a step that can be rehearsed, so `npm publish --dry-run
./dist-server/ledge-server-<version>.tgz` is the rehearsal: it prints the exact
file list and the tarball size without uploading.

### The install script

`curl -fsSL https://ledge.sh/server.sh | sh` installs the published package with
a Bun of its own, without npm or a Bun of the user's (`remote.md` §11). ledge.sh
redirects `/server.sh` to
`https://github.com/ledgesh/ledge/releases/latest/download/server.sh`, so a user
gets the script attached to the newest published GitHub release. The redirect
lives in `ledgesh/ledge-www`.

Upload `server.sh` and `SHA256SUMS` to the `v<version>` release alongside the
app's (§4), after the npm publish: the script downloads the package from npm,
so a script published first fails for everyone who runs it. GitHub's `latest`
skips drafts and pre-releases, so publishing the release is what gives
`curl … | sh` the new version.

**The Bun it installs is pinned in `src/bun/serverRelease.ts`**, as a version
and the SHA-256 of each target's `@oven/bun-<target>` tarball, and
`serverRelease.test.ts` fails when that version differs from the one CI runs
the suite on or from the `Dockerfile`'s `ARG BUN_VERSION`. npm lists a sha512
rather than a SHA-256, so raising it means downloading the four tarballs at the
new version, checking each against `npm view @oven/bun-<target>@<version>
dist.integrity`, and copying in their SHA-256s. `build:server` then checks the
pins against the registry on every build.

## 7. Updates

Every stable build checks `https://ledge.sh/updates` for a newer one: ten
seconds after launch, then once a day, and an hour after a check that failed.
It downloads a newer build in the background, and Ledge > Restart to Install
Update installs it. `bun/updates.ts` decides when; Electrobun's `Updater` does
the fetch, the validation and the install. The client setting
`updates.automatic` set to `false` stops the scheduled checks, and Check for
Updates… still checks and downloads.

**The address is permanent.** It is `release.baseUrl` in
`electrobun.config.ts`, compiled into every bundle's `version.json`, and a build
asks it for as long as that build is installed. Moving it strands every install
that has the old one. `release.test.ts` pins it.

What an install requests, under that address, with `<prefix>` its own
channel, platform and architecture:

| Request | Served |
| --- | --- |
| `<prefix>-update.json?<random>` | The current release's manifest, or 404 while nothing is published |
| `<prefix>-<its own hash>.patch` | The patch from that install's build, or 404, which falls back to the tarball |
| `<prefix>-Ledge.app.tar.zst?cache=<random>` (`<prefix>-Ledge.tar.zst` on Linux and Windows) | The current release's tarball |

The prefixes a release publishes:

| Prefix | Build |
| --- | --- |
| `stable-macos-arm64` | The Mac app (§1) |
| `stable-linux-x64` | The Linux app on x86_64 (§9) |
| `stable-linux-arm64` | The Linux app on arm64 (§9) |
| `stable-win-x64` | The Windows app (§10) |

**A 404 for the manifest reads as up to date.** That is how every install
behaves before the first release is published, and `noRelease` in
`bun/updates.ts` is the rule.

**The updater compares hashes, never versions.** An install offers an update
whenever the manifest's `hash` differs from its own. So:

- The manifest the site serves must be the one the build wrote, byte for byte.
  A hand-edited or stale manifest offers every install whatever it points at,
  including an older build.
- Pulling a bad release means serving the previous release's manifest again.
  Every install on the bad build then moves back to the previous one.
- A manifest published before its tarball uploads gives every install a failed
  download.

**Publishing is `bun run updates:publish v<version>` in `ledgesh/ledge-www`**,
once per prefix, with `--prefix stable-linux-x64` and
`--prefix stable-linux-arm64` for the Linux builds and `--prefix stable-win-x64`
for the Windows one (the Mac's is the default),
run after every asset has finished uploading to the GitHub release. It
downloads that release's manifest, validates it against the rules Electrobun
enforces, checks that the tarball downloads, and only then writes the manifest
and the release's asset list into that repo's `updates/`. Committing those
files and deploying the site is what offers the release. The tarball and the
patches redirect to the tagged release's assets. `updates/README.md` there is
the site's half of this section.

**Probing an update without publishing one** uses `LEDGE_UPDATE_BASE_URL`,
which replaces the address in an unsigned build. The preflight refuses it in a
signed one. The recipe, all against a scratch `HOME` and `LEDGE_NOTES_ROOT`
(`testing.md` §6):

1. Serve an empty folder on `127.0.0.1` from a static server that answers 404
   for anything missing.
2. `LEDGE_UNSIGNED=1 LEDGE_UPDATE_BASE_URL=http://127.0.0.1:<port> bun run release`
   builds A. Unpack its tarball with the devkit's `zig-zstd` and `tar`, and run
   `Ledge.app/Contents/MacOS/launcher` from there. Its log says
   `[update] current <version>`.
3. Put A's manifest and tarball in the served folder, raise the version in
   `package.json` and `electrobun.config.ts`, and build B. The build downloads A
   and writes the patch. Put B's manifest, tarball and patch in the folder
   instead of A's, and put the version back.
4. Copy A's unpacked `.tar` to
   `$HOME/Library/Application Support/sh.ledge.app/stable/self-extraction/<A's hash>.tar`,
   where the DMG's extractor would have left it, so the patch applies.
5. Run A again. Its log reads `checking`, `downloading`, `ready`, and Restart to
   Install Update relaunches the bundle as B, which then logs `current`.

The relaunched app inherits the environment of the one that installed it, so
it stays on the scratch root. That was checked on 2026-09-12, and it is a fact
about Electrobun's update helper rather than a guarantee: a probe should guard
it before relying on it.

## 8. What is not automated

- **Publishing.** Nothing uploads this Mac's `artifacts/` or `dist-server/`,
  nothing publishes a tag to the update server (§7), and nothing runs
  `npm publish` (§6). CI builds the app but does not release it. The one
  uploads a workflow does are the Linux and Windows builds', onto a draft
  release a human created and will publish (§9, §10).
- **The server in `bun run release`.** The release script builds the Mac app and
  stops; `bun run build:server` (which runs `build:npm`) is a second command,
  run by hand. Folding it in means the release depends on Docker being up,
  which is a fair trade to make later and not one to discover mid-release.
- **The signed build in CI.** Signing needs the certificate and the credentials,
  and both live on this machine only. The Linux and Windows builds have
  nothing to sign, which is why they are the builds a runner cuts.

## 9. The Linux build

`.github/workflows/release-linux.yml` cuts it: started by hand on a tag, it
checks the tag out on an x64 runner (`ubuntu-24.04`) and an arm64 one
(`ubuntu-24.04-arm`), refuses a tag that does not name `package.json`'s
version, runs `bun run release` on each, and uploads what each built to the
GitHub release for that tag with `gh release upload`. The preflight skips the
architecture and signing checks off macOS and keeps the rest. Nothing on
Linux is signed, so no secret reaches the runner.

Hutch builds for its host, so a Linux build needs a Linux machine of its
architecture. The runners are that machine. A Linux checkout builds the same
files by hand with the same command, for its own architecture only.

Each runner writes these files to `artifacts/`:

| File | What it is |
| --- | --- |
| `linux-<arch>-Ledge-Setup.tar.gz` | What users download: `installer`, a self-extracting executable, and a `README.txt`. The site and the README link to it by this name under `releases/latest/download/`. |
| `stable-linux-<arch>-Ledge.tar.zst` | The app itself, compressed. The updater downloads it when no patch applies. |
| `stable-linux-<arch>-update.json` | The manifest the updater reads (§7). |
| `stable-linux-<arch>-<hash>.patch` | The binary diff from the previous release, when the update server was serving one during the build. |

`<arch>` is `x64` or `arm64`. Both ship: the server half of the app already
runs on both in the Docker probes (`remote.md` §11), and the x64 desktop half
is Electrobun's own most-run target. The arm64 build has been run by hand
on an Ubuntu 24.04 desktop; the x64 build has not, and the first x64 user
is the first test of its WebKitGTK path.

What `./installer` does, all under the user's own home and with no root:

| Path | What lands there |
| --- | --- |
| `~/.local/share/sh.ledge.app/stable/app/` | The app: `bin/launcher`, `bin/bun`, the Electrobun libraries, `Resources/app/` with the view, `serve.js` and the PTY `.so` |
| `~/.local/share/applications/Ledge.desktop` | The launcher entry, with the absolute `Exec` and `Icon` paths written in, so the app is in the desktop's app grid |
| `~/Desktop/Ledge.desktop` | A copy on the desktop; GNOME asks the user to allow it before the first launch |
| `~/.local/share/sh.ledge.app/stable/self-extraction/<hash>.tar` | The app's own tarball, kept for the updater's patches (§7) |
| `~/.local/share/sh.ledge.app/stable/uninstall` | The uninstaller, which removes all of the above |

It launches the app when it is done. The app's own files stay where they are
on a Mac: the app home is `~/.ledge`, and the log is under it (`bun/log.ts`).
WebKit's storage goes beside the app, under `stable/WebKit/`. The runtime
packages are GTK 3, WebKitGTK 4.1, libayatana-appindicator3 and librsvg2,
which an Ubuntu desktop has.

Two things a Linux install has no menu bar for. Check for Updates… and
Restart to Install Update are commands in the palette (Ctrl+Shift+P), and
Quit is Ctrl+Q (`interactions.md` §10). The updater is otherwise §7 as
written: the same address, the Linux prefixes, and a manifest the site serves
per prefix.

**Verifying, on a Linux desktop of the release's architecture**, from the
`Setup.tar.gz` a user would download, with the app not yet installed:

- `tar xzf` it and run `./installer`. The app launches, and it is in the app
  grid with its icon.
- A shell block runs, and Ctrl-C stops it. This is `dlopen` of the PTY `.so`
  the runner compiled.
- Ctrl+Shift+V into the drawer pastes, and Ctrl-click on a link opens the
  browser. Those are the GTK clipboard and `xdg-open`.
- Run Install Shell Command (ledge), then `ledge ls` in a new terminal, and
  `ledge <a note's title>` with the app closed: the shim starts the launcher
  beside its own `bun` (`bun/linuxApp.ts`).
- Check for Updates… answers "Ledge <version> is the latest version." That is
  a 404 before the prefix is published and this build's own hash after.
- `~/.local/share/sh.ledge.app/stable/uninstall` removes the app and both
  desktop entries.

Probing an update on Linux is the §7 recipe with two substitutions: the
installer already saved the tar the patch applies to, and the app to run is
`~/.local/share/sh.ledge.app/stable/app/bin/launcher`.

## 10. The Windows build

`.github/workflows/release-windows.yml` cuts it, the way §9's workflow cuts
Linux's: started by hand on a tag, it checks the tag out on `windows-2025`,
refuses a tag that does not name `package.json`'s version, runs
`bun run release`, and uploads what it built to the GitHub release for that
tag. Only x64 ships, the one Windows target Electrobun builds.

The input `upload`, off, builds without touching any release, for any branch
or tag, and keeps the files on the run as the `windows-x64` artifact. That is
how to see a build before the first release carries one.

The build has no PTY library to compile. The Windows app is a client of a
server in WSL (`bun/wslServer.ts`), and that server is the Linux one server.sh
installs (§6), so a Windows release changes nothing on the server side.

**The build is not signed.** Windows shows SmartScreen's "Windows protected
your PC" warning on the installer's first run, and the user clicks More info,
then Run anyway. Signing through Azure Trusted Signing is the planned fix; it
would add the signing secrets to this workflow and a signing step after the
build.

The runner writes the Linux build's kinds of file with the `win-x64` prefix:

| File | What it is |
| --- | --- |
| The installer | What users download: Electrobun's `Ledge-Setup.exe`. Its exact artifact name is what the workflow's List the artifacts step prints, and the README and the site link to it by that name. |
| `stable-win-x64-Ledge.tar.zst` | The app itself, compressed. The updater downloads it when no patch applies. |
| `stable-win-x64-update.json` | The manifest the updater reads (§7). |
| `stable-win-x64-<hash>.patch` | The binary diff from the previous release, when the update server was serving one during the build. |

The app runs `bin\launcher.exe`, with `bun.exe` beside it, from the folder
the installer extracts it to. Where that folder is has not been observed on
an install yet; the first one records it here. The app home is not there: it
is `~/.ledge` inside WSL, the server's.

**Verifying, on a Windows 11 PC with WSL**, from the installer a user would
download, with the app not yet installed:

- Run the installer through SmartScreen's warning. The app launches, and it is
  in the Start menu with its icon.
- With no server in WSL, the app offers to install one, and a window opens
  when server.sh is done. Use a WSL account without `~/.ledge/.server` for this.
- A shell block runs in WSL, and Ctrl-C stops it.
- Attach Folder's Choose Folder opens in WSL's home and attaches the folder
  picked. Formatted text and a picture paste into a note. A misspelled word
  offers guesses on right-click.
- `ledge <a note's title>` in a WSL terminal, with the app closed, opens it
  there (`bun/wslApp.ts`).
- Check for Updates… answers "Ledge <version> is the latest version."
