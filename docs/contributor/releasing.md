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

Arm64 only. `targets: "macos-arm64"` in `electrobun.config.ts` is a decision,
not a default: an x86_64 slice would ship with the PTY dylib and the whole
native seam untested, because there is no Intel Mac here to run it on.

## 2. Version numbers

The version lives in two files and both must say the same thing:

- `package.json` → `version`
- `electrobun.config.ts` → `app.version`

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

- The app launches from `/Applications` with no Gatekeeper dialog.
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

## 6. What is not automated

- **Auto-update.** `release.baseUrl` is unset, so no build offers an upgrade to
  the one before it, and no patch is generated. The artifacts are already the
  right shape for it: publishing them under a `baseUrl` and setting that key is
  what turns it on.
- **Publishing.** Nothing uploads `artifacts/`. CI builds the app but does not
  release it.
- **The signed build in CI.** Signing needs the certificate and the credentials,
  and both live on this machine only.
