# Ledge on Android

**`android/` is a Kotlin app that loads the same React view as the iPhone in
a WebView, reaches a Ledge server over ssh with a key in the Android
Keystore, and does all of ios.md §8's v1.** It is the second phone shell, and
it follows ios.md wherever the two platforms allow. This page records where
they did not: what Android made different, and what the Android build and
the Play Store need.

Read ios.md first. Its rules about the protocol staying in JavaScript (§2),
pinning (§3), the reconnect ladder (§5), touch (§6), the editor (§7), the v1
cut (§8) and what never reaches the phone (§11) hold here unchanged, and this
page does not restate them. Where this page and the code disagree, one of
them is wrong.

## 1. What the Android client is

| Part | Where | The iOS counterpart |
| --- | --- | --- |
| The activity, the web view and the bridge | `WebHost.kt` | `WebHost.swift` |
| The ssh connection | `SshTransport.kt`, over sshj | `SSHTransport.swift`, over NIOSSH |
| The device key | `DeviceKey.kt`, P-256 in the Keystore | `DeviceKey.swift`, P-256 in the Secure Enclave |
| Host-key judges | `HostKeys.kt` | `HostKey.swift` |
| The server list and passwords | `ServerStore.kt`, `ServerPassword.kt` | `ShellConfig.swift`, `ServerPassword.swift` |
| Welcome, server list, pairing, setup | `ServerScreens.kt`, in Compose | `Welcome.swift`, `ServerList.swift`, `Pairing.swift`, `ServerSetup.swift`, in UIKit |
| The pairing-code reader | `PairingCode.kt` | `PairingCode.swift` |
| The QR scanner | `CodeScanner.kt`, CameraX and ZXing | AVFoundation |
| The keyboard bar | `AccessoryBar.kt` | `AccessoryBar.swift` |
| Insert Image | `ImagePicker.kt` | `ImagePicker.swift` |

All of it is under `android/app/src/main/kotlin/sh/ledge/android/`. The page
is `android.html`, built by `vite.android.config.ts` into `dist-android/`,
which Gradle takes as the APK's assets. It loads `ios.tsx`, the shared phone
entry.

The app is `sh.ledge.android`, minSdk 29 (Android 10), targetSdk 36
(Android 16), compiled against 37. There is no Android Studio project: Gradle
builds it from the command line, and `bun run android` drives Gradle, the
emulator and adb (§9).

## 2. The shell is Kotlin, and the page is the iPhone's

**The page cannot tell the two shells apart except by what `@hello`
answers.** `WebHost` serves the bundle from
`https://appassets.androidplatform.net/assets/` through `WebViewAssetLoader`,
for the reason iOS has a scheme of its own: `file://` gives every resource an
opaque origin, and the view loads a language mode per fence through
`import()`. The bridge is `addWebMessageListener("ledge")`, which injects
`window.ledge` as a message port. `attachShell` in
`mainview/lib/nativeBridge.ts` finds either shell's port and speaks the same
strings to both.

| Difference | Android | iOS |
| --- | --- | --- |
| Messages | strings both ways, JSON inside | `WKScriptMessage` bodies |
| Base64 on the page | `btoa`/`atob` when `Uint8Array.toBase64` is missing (WebView before 140) | the builtins |
| `@hello` | adds `back: true`, which turns on §6's Back reporting | no `back` |
| Inspector | Chrome's, on a debug build only | Safari's, on a debug build only |

**The pairing screens are native, as on iOS, and in Compose.** `WebHost`
finishes itself into `ServerScreens` when nothing is dialable, and every way
back out starts `WebHost` fresh.

**A debug build takes its server from the launch.** `bun run android --
--server ledge@10.0.2.2 --port 2222` passes it as intent extras, and
`adoptLaunchServer` pins it. A release build ignores the extras, because any
app can start the activity with them.

## 3. SSH over sshj and a full Bouncy Castle

sshj is the Java counterpart of NIOSSH: a client library, with no `ssh`
binary. Two things make it work on Android:

| What | Why |
| --- | --- |
| Android's cut-down "BC" provider replaced with the full `bcprov` | the platform's lacks X25519, which kex needs |
| A custom `ecdsa-sha2-nistp256` signature, `KeystoreEcdsa` | a Keystore private key has no encoding, so Bouncy Castle cannot sign with it; `Signature.getInstance("SHA256withECDSA")` with no provider can |

`SecurityUtils.setSecurityProvider(null)` resets sshj's register-BC flag, so
it runs before `setRegisterBouncyCastle(false)`. Running sshj on the platform
providers alone was the dead end: every ephemeral key lookup lands on
AndroidKeyStore and is refused.

sshj offers both `password` and `keyboard-interactive` for a password server.
NIOSSH has no keyboard-interactive, so an iPhone cannot reach a server that
offers only that.

## 4. Keys live in the Android Keystore

**The device key is P-256 in StrongBox where the phone has it, and in the
TEE where it does not.** It is minted on first use and never exported.
Passwords have no keychain to go in, so each is sealed with AES-GCM under a
second Keystore key, and only the sealed bytes are in the app's preferences.

**Nothing is backed up and nothing moves to a new phone.** `allowBackup` is
false, and `res/xml/transfer.xml` excludes every domain from cloud backup and
device transfer. allowBackup alone does not stop a device-to-device transfer
on Android 12 and later. A copied server list would arrive without the
Keystore keys it depends on, so the new phone pairs again, as a new iPhone
does.

## 5. Android cuts a background app's network

**About five seconds after the app leaves the screen, Android cuts its
network, and the socket dies.** iOS suspends the process and leaves TCP up.
Coming back reconnects in about half a second, even from `lost`. A run is
held by the server (remote.md §7), so a 15-second run that ends while the app
is in the background comes back Done with all its output.

There is no foreground service. One would keep the socket up, and it would
cost a notification for as long as the app is open, plus a Play declaration
of what the service is for. A reconnect is cheaper.

Android delivers `resumed` before the throttled tick that was pending when
it left. That tick judged the last-chance ping before its pong could arrive,
so `recheck` restarts the beat (`arm()`) in `shared/transport.ts`.

## 6. Touch, the keyboard and Back

| What | Android |
| --- | --- |
| The keyboard bar | plain Views at the foot of the insets-padded layout, focusable false so the web view keeps focus; shown while the IME is up and `@focus` is `note` or `run` |
| Hide Keyboard | none: Back and the navigation bar put the keyboard away |
| Back | the page reports whether a layer is open (`@back`, from `layers.ts`); Back with one open sends `{t:"back"}` and the page closes the top layer; with none open the shell calls `moveTaskToBack` |
| A long press in text | Android's own selection and toolbar |
| Insets | a `FrameLayout` padded by the system bars and the IME; a WebView ignores its own padding |
| Rotation | the page's to lay out: `configChanges` keeps the activity and its socket |
| Dark mode | rebuilds the activity, because a WebView takes its colour scheme from the theme at creation |

**Chromium fires `contextmenu` on a touch long press, and WebKit on iOS does
not.** The page opened its desktop editor menu and blocked Android's
selection. `pressIsSelection` (`lib/useRowMenu.ts`) lets the press through
inside an editor or a field. A row's long press still opens the row menu
(interactions.md §1a).

Back goes through `OnBackPressedDispatcher`, which predictive back on
targetSdk 36 still calls. `onBackPressed` and a `KEYCODE_BACK` handler are not
called there.

**Gboard's suggestion strip, backspace and typing work in CodeMirror** in the
emulator. The emulator's Gboard has autocorrect off. Samsung's keyboard is
untested, since it needs a Samsung phone.

## 7. Pictures

The rules are ios.md §11's: the source menu first, bytes only (the server
names the file), JPEG at 90 except a PNG from Files, and every picture
encoded again so its EXIF stays on the phone.

| Source | How |
| --- | --- |
| Photos | `PickVisualMedia`, which needs no permission |
| Take Photo | `TakePicture` into a `FileProvider` file under `cacheDir/camera`, deleted once read. Asks for the camera first: a declared but ungranted CAMERA makes `ACTION_IMAGE_CAPTURE` throw |
| Choose File | `OpenDocument("image/*")` |
| Paste | an image-typed clip's content URI (`clipboard.image`), or a paste event's bytes (`image.encode`) |

`ImageDecoder` with the software allocator applies the EXIF rotation before
the EXIF goes. `clipboard.read` ignores an image clip, since `coerceToText`
would paste its `content://` URI as text.

## 8. Distribution

**Google Play, through a closed test first.** A personal Play Console account
created after 2023-11-13 cannot publish to production until a closed test has
had at least 12 testers opted in for 14 days in a row. The clock is the
schedule, so the closed test starts as soon as a build is accepted.

### The build

`bun run android -- --store` builds `build/android/Ledge-<version>-<build>.aab`
and checks it is signed. Upload it in the Play Console.

| What | Value |
| --- | --- |
| `versionName` | `package.json`'s version |
| `versionCode` | `git rev-list --count HEAD`, as the iOS build number. Play refuses a second upload with the same one |
| Signing | the upload key. Play App Signing holds the key phones check and re-signs with it |
| R8 | off: sshj and Bouncy Castle find algorithms by reflection, and a missed keep rule fails only on a phone |
| Native libraries | CameraX's and androidx.graphics', all 16 KB aligned, which Play requires for targetSdk 35 and later |
| Size | about 16 MB of bundle; a phone downloads one ABI's split |

### The upload key

The keystore is `~/.config/ledge/android-upload.jks`, outside the checkout on
releasing.md §3's rule, or wherever `LEDGE_ANDROID_KEYSTORE` says. Its
password is in the login keychain, so `release.env` stays free of secrets.
Once per Mac:

```bash
keytool -genkeypair -keystore ~/.config/ledge/android-upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Ledge"
```

```bash
security add-generic-password -s ledge-android-upload -a "$USER" -w
```

The alias must be `upload`. The keystore is PKCS12, so the key's password is
the store's. A lost upload key is recoverable: the Play Console resets it on
request. The keystore still belongs in the same backup as the Apple
certificates.

### The Play Console

What the first submission asks for, and the answers:

| Section | Answer |
| --- | --- |
| App access | a server and a password account, as App Review gets: the demo server, with the instructions from the iOS submission |
| Data safety | Ledge collects nothing. Notes go only to the user's own server over ssh, and nothing reaches a server of Ledge's |
| Privacy policy | https://ledge.sh/privacy, which has to name the Android app first |
| Target audience | 18 and over, which keeps the app out of the Families policy |
| Content rating | a utility with no content shared between users |
| Permissions | CAMERA, for the QR scanner and Take Photo; nothing that needs a declaration form |
| Store listing | `android/store/play-icon-512.png` and `play-feature-1024x500.png`, and at least two phone screenshots |

The feature graphic and the 512 px icon are drawn from `assets/Ledge.icon`'s
mark and fill. The screenshots follow the App Store lesson: a bigger editor
font, one idea per shot, checked at about 250 px wide.

**CI builds the bundle unsigned.** The `android` job in `ci.yml` runs the
Kotlin unit tests, lint and `bundleRelease` on Linux, so a clean machine
proves it can build what the Mac signs. Lint fails on errors only. Its `NewApi`
check is the one that matters: a call newer than minSdk works on the emulator
and fails on an Android 10 phone.

## 9. Testing

| What | How |
| --- | --- |
| The view in Chromium | the `chromium` and `android` Playwright projects (Pixel 7 at 390×844), on CI's Linux job |
| Kotlin unit tests | `bun run android -- --test`, which holds `PairingCode.kt` to `shared/pairing.vectors.json` |
| A live run | `bun run android -- --server ledge@10.0.2.2 --port 2222` against the `ledge-sshd:probe` fixture |

The toolchain is Homebrew's `openjdk@21` and the SDK's command-line tools,
with no Android Studio. The script defaults `JAVA_HOME` and `ANDROID_HOME` to
where those put them.

**The emulator reaches this Mac as 10.0.2.2.** The fixture listens on
127.0.0.1:2222, and the script scans the host key from 127.0.0.1 and pins it.
The first launch prints the device key's `[pair]` line to logcat; start the
fixture with the bare key from it:

```bash
docker run -d --name ledge-android-probe -p 127.0.0.1:2222:22 -e LEDGE_PUBKEY="ecdsa-sha2-nistp256 AAAA… ledge-android-…" ledge-sshd:probe
```

| AVD | Image | For |
| --- | --- | --- |
| `ledge-pixel` | Android 15, Google APIs | everyday runs. WebView 124, with no Play Store to update it, and no StrongBox |
| `ledge-pixel-16` | Android 16, Google Play, 16 KB pages | targetSdk 36's behavior and the page size Play checks. WebView 133. `--avd ledge-pixel-16` picks it |

Traps that cost time:

- A refused dial drops the pin, so relaunch through `bun run android --
  --server` after fixing the fixture.
- `LEDGE_PUBKEY` takes the bare key. The fixture's entrypoint adds
  `restrict,command=`.
- The fixture's host keys are baked into the image. To change one,
  `docker exec` a removal of `/etc/ssh/ssh_host_*`, run `ssh-keygen -A`, and
  restart the container.
- `pm revoke` kills the app, and Android stops asking after a second refusal.
  `pm grant` puts a permission back.
- Gboard takes adb taps for a stylus. `adb shell settings put secure
  stylus_handwriting_enabled 0` stops its handwriting toolbar.
- Back (keyevent 4) in a Compose screen pops the screen as well as the
  keyboard.
- The emulator's camera delivers frames and renders them black, so a QR read
  is tested with `adb shell am start -a android.intent.action.VIEW -d
  "'ledge://pair#…'"`.

## 10. What is still open

- **Gboard's clipboard-panel pictures insert nothing.** The WebView
  advertises no image types to the keyboard. A copied picture still pastes
  through the long-press toolbar and the page's Paste. Checked on a real
  phone with a current WebView before anything is built.
- **`https://ledge.sh/pair` links open the browser, not the app.** App links
  need an `assetlinks.json` on ledge.sh carrying the Play app-signing key's
  fingerprint, which exists only once Play has the app.
- **A server whose `ledge` is missing says only that the connection
  closed**, where the exit status (127) would say what is wrong.
- **Local network access is a runtime permission for apps that target
  Android 17.** At targetSdk 36 the INTERNET permission still covers it. Most
  servers are on a LAN, so the move to 37 declares `ACCESS_LOCAL_NETWORK` and
  asks for it before the first dial.
