# Releasing Ledge

How a build on this machine becomes a DMG someone else can open. Read this
before cutting a release; it is run rarely enough that nobody remembers it.

Everything here is macOS. `bun run release` is the whole procedure, and the
sections below say what it needs, what it produces, and what to check before
publishing.

## 1. What a release consists of

`bun run release` writes three files to `artifacts/` (gitignored):

| File | What it is |
| --- | --- |
| `stable-macos-arm64-Ledge.dmg` | What users download. Contains the self-extracting app and a symlink to `/Applications`. |
| `stable-macos-arm64-Ledge.app.tar.zst` | The app itself, compressed. This is what the updater downloads. |
| `stable-macos-arm64-update.json` | `{version, hash, platform, arch}`, read by the updater to decide whether a newer build exists. |

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

`update.json` carries the same version, and the updater compares versions to
decide whether to offer an upgrade. A release that reuses a version number is a
release the updater cannot see.

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
5. Tag the commit and publish `artifacts/` to wherever releases live.

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
- Install the CLI shim and run `ledge ls`. The shim execs the bundle's own
  `bun`, from outside the bundle.
- Open a workspace under `~/Documents` or `~/Desktop` and confirm the TCC prompt
  appears and, once granted, that notes read and write.

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
bun run build:npm
```

The Mach-O trampolines need a Mac and the ELF ones need a container per
architecture, so a complete package cannot be assembled anywhere else
(`remote.md` §11). Docker has to be running. The script refuses rather than
shipping three targets out of four, and it writes `dist-npm/package.json` last
so a half-assembled tree cannot be packed.

Then prove the thing you are about to publish actually works:

```
bun run probe:npm
```

It packs the tarball, installs it on a container with no compiler and no libc
headers, and drives a terminal on it. That fixture is the point: it is the
machine a user has, and the one this checkout is least like.

Publishing is deliberately not a script:

```
npm publish ./dist-npm
```

The `./` is not decoration. npm reads a bare `dist-npm` as a package name to
resolve against the registry and fails with a 404 for a package nobody has
published, which is a confusing way to learn that an argument was a path.

It is irreversible in the way signing is not. An npm version can be deprecated
but never replaced, so the version has to be right before the command runs, and
`src/bun/release.test.ts` is what checks that it matches the app's.

Two things to know before the first publish. The name `ledge-server` has to be
available or owned by the publishing account, and `npm publish` on a package
that has never existed also decides the account that owns it forever. Neither
is a step that can be rehearsed, so `npm publish --dry-run ./dist-npm` is the
rehearsal: it prints the exact file list and the tarball size without uploading.

## 7. What is not automated

- **Auto-update.** `release.baseUrl` is unset, so no build offers an upgrade to
  the one before it, and no patch is generated. The artifacts are already the
  right shape for it: publishing them under a `baseUrl` and setting that key is
  what turns it on.
- **Publishing.** Nothing uploads `artifacts/`, and nothing runs `npm publish`
  (§6). CI builds the app but does not release it.
- **The server package in `bun run release`.** The release script builds the Mac
  app and stops; `bun run build:npm` is a second command, run by hand. Folding
  it in means the release depends on Docker being up, which is a fair trade to
  make later and not one to discover mid-release.
- **The signed build in CI.** Signing needs the certificate and the credentials,
  and both live on this machine only.
