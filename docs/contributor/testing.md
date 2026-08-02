# Ledge testing standards

How correctness is checked, and at which layer. The one-line version: **pure
logic gets unit tests, the note store gets real-filesystem tests, wiring gets
the type system, UI behavior gets headless WebKit (the harness), and the
native shell gets the live probe** — each layer covering what the one below
cannot.

## 1. Runner and layout

`bun test` (`bun run test`, `test:watch` to watch). Tests are colocated:
`foo.test.ts` sits next to `foo.ts`, named for the module it tests, importing
it relatively. There is no `tests/` directory and no test-only build step.
Tests land *with* the feature, in the same change — a feature whose logic is
pure but untested is not done.

## 2. What must be tested (and what must not)

**Must:** every pure module. Parsers and matchers (`ansi`, `markers`,
`fuzzy`), the keymap resolver, the reducer and tree helpers, name allocation
and path guards, formatting. If it takes values and returns values, it gets a
colocated test file, and edge cases get named tests whose descriptions read as
sentences stating the rule ("a sibling whose name merely starts with the root
is rejected").

**Must not:** React components, DOM event plumbing, or anything needing a
fake browser. There is **no happy-dom / jsdom in this repo — do not add one.**
The rule when a module seems to need a DOM is to split it:

- the decision goes in a **pure core**, tested — `targetFromDataset` takes a
  plain dataset object and returns a target;
- the DOM touch stays in a **thin wrapper**, untested and too small to be
  wrong — `targetFromElement` is `closest()` plus one call into the core.

A wrapper that grows logic is the signal to move that logic down into the
core. What the wrappers and components add up to is covered by layer 4, not
by simulating a browser badly.

Filesystem code gets both halves: `bun/notes.test.ts` tests the pure helpers
(`uniqueName`, `isInside`) and the guards (a `rejects` assertion needs no
filesystem) without touching disk, and `bun/notes.fs.test.ts` exercises the
rename choreography and the unlink paths against real files. The whole
`bun test` run is pointed at a per-run temp dir by `src/test-preload.ts`
(wired in `bunfig.toml`) — a *preload*, deliberately: `NOTES_ROOT` is frozen
at import time and test files share one module registry, so an env var set
inside a test file can be too late, and too late here means a test wiping the
real `~/.ledge`. The fs test file re-checks the root is under the tmpdir and
refuses to run otherwise.

## 3. Invariant tests

When a rule in `interactions.md` or `architecture.md` can be a
test, it must be one — the doc states the rule, the test enforces it, and a
violation fails CI instead of waiting for a reader. Existing examples, which
new rules should imitate:

- `src/shared/` imports from neither `src/bun` nor `src/mainview`, and
  reaches for no global only Bun has (`shared/portable.test.ts`);
- no two commands share a bare key on the same row kind, and every row verb
  declares its `targetKind` (`registry.test.ts`);
- every command is reachable without a keyboard — in the palette, in a row
  menu, or behind a control that runs it (`registry.test.ts`, interactions.md
  §1a). The menus are JSX, so this one reads the components' source; the
  exceptions are a named list, and an entry a menu item has since made
  unnecessary fails too;
- row verbs live in `listKeys`, never `keys` (`keys.test.ts`);
- the held-modifier badges show the same keys `keys.ts` binds;
- note verbs refuse a trash target and vice versa;
- `deleteTrashed` rejects anything not a `.md` directly inside `.ledge-trash`.

These are the cheapest guardrails the repo has: they turn "someone will
forget" into "the suite goes red."

## 4. Stubbing at the seams

The seams built for testability (architecture.md §5) are where tests inject:

- **Channel handlers**: `notes/store.test.ts` implements the `NoteHandlers`
  interface with stubs — never a mock of the RPC or the webview. Adding a
  handler to a channel interface deliberately breaks these tests at
  typecheck, which is the reminder to extend the stubs.
- **Registry deps**: `registry.test.ts` passes a stub `RegistryDeps` and a
  `Partial<UiHooks>`, so command behavior is tested without the editor stack.
- **State**: build it with `initialState(...)` and the exported action
  creators, not by hand-assembling `AppState` literals that rot as the shape
  grows.

## 5. The harness: UI behavior in headless WebKit

Unit tests cannot see focus or WebKit quirks — the click-focus bug lived
entirely in the gap between green unit tests and the real webview. That gap
belongs to the **harness**: the real app booted in Playwright's headless
WebKit (`bun run test:e2e`), which is the same engine lineage as the shipping
WKWebView, so its focus/tabindex behavior is representative in a way no
simulated DOM is.

The trick is that no fake browser *or* fake app is involved — only a fake
Bun. `src/mainview/harness.tsx` boots the entire view exactly as `main.tsx`
does, but binds the `configureX` seams (architecture.md §5) to an in-memory
store instead of the live RPC. Everything above the seams — the command
registry, dispatch, focus, lists, dialogs, CodeMirror — runs for real. Vite
serves `harness.html` in dev only; the production build's input is
`index.html`, so none of it ships.

Rules:

- Specs (`e2e/*.spec.ts`) assert on what a user can observe — roles, visible
  text, `document.activeElement` — never on internals reached through
  `window`. (`window.__harness` exists for the few things with no visible
  surface, like the clipboard.)
- **Pixel geometry is compared as real numbers, never as two rounded ones.**
  `round(a) - round(b)` turns a subpixel gap into an off-by-one for a quarter
  of the positions a line can land on, so the spec starts reporting where the
  editor happened to sit rather than the rule it states. Round the quantity
  being asserted instead of its inputs — `Math.round((x - origin) / ch)` is a
  column index no thousandth of a pixel can move (`lists.spec.ts`) — or
  compare the raw numbers to half a pixel with `toBeCloseTo(…, 0)`
  (`wrap.spec.ts`). A column width is measured from a whole hidden span:
  WebKit inflates the client rects of a range that starts or ends part-way
  through a text node by about a pixel, which is not a width the layout used.
- WebKit only, deliberately. A Chromium pass would green-light what the
  shipping engine then does differently.
- **Two projects.** `webkit` is the desktop one and runs everything except
  `phone.spec.ts`; `phone` is the same view at 390x844 with touch, a coarse
  pointer and no chords, and runs `phone.spec.ts` alone (ios.md §13). The
  split is deliberate in both directions: the desktop specs assert hovers and
  hotkeys a phone does not have, and the phone specs assert affordances that
  say nothing about a desktop. The viewport is overridden past the iPhone
  descriptor's own, which is what mobile Safari leaves after its chrome — the
  iOS client is a full-screen WKWebView with none. A long press is dispatched
  rather than driven: Playwright's touchscreen taps and does nothing else, so
  the spec sends `pointerdown`, waits for the menu, then sends the `pointerup`
  and the `click` WebKit really would.
- The fake store mirrors `bun/notes.ts` semantics (naming-by-heading,
  enumeration on collision, move-don't-unlink). If a spec needs behavior the
  fake lacks, extend the fake to match the real store — never the reverse.
- No PTYs in the harness: run/terminal behavior belongs to the live probe.
- Every interaction rule that can be a spec should be one, same as §3: R5
  (click focuses the row, opening must not steal focus), §4 (irreversible
  confirms focus Cancel), the bare-key domain guard, all live in
  `e2e/list-verbs.spec.ts` as executable statements of the spec.

## 6. Verifying in the real app

What the harness still cannot see: the real RPC transport, the AppKit
key-equivalent path (the ⌘-beep class of bug), the native clipboard, and
Electrobun's shell. Changes touching those get verified live in the actual
app — a smoke pass, now that the harness carries the behavioral load. The
recipe (the WKWebView console is not forwarded, so results come out through
the clipboard):

1. **Scratch root, always.** Launch with `LEDGE_NOTES_ROOT=<scratch dir>` and
   seed it with throwaway notes. A probe must never run against the real
   `~/.ledge`. Anything touching profiles sets `LEDGE_PROFILES_DIR` the same
   way — a probe must never read or seed `~/.config/ledge/profiles` either.
2. **Temp probe in `main.tsx`**: a self-contained block that waits for boot,
   drives the app with synthetic events, and reports via the `clipboardWrite`
   RPC as one `PROBE: key=value ...` line behind a unique sentinel.
3. **Poll with `pbpaste`** from the shell until the sentinel appears.
4. Synthetic keyboard events must be dispatched **on the element that would
   really have focus** (a list row, the editor), with `bubbles: true` —
   dispatching on `window` skips the domain detection the real key would hit.
5. Focus the element first (`.focus()`), then dispatch; assert on
   `document.activeElement` when focus itself is the behavior under test.
6. **Tear down**: revert the probe (its diff should be the whole diff to
   `main.tsx`), kill the app processes, delete the scratch root.

Four hard-won warnings. Query dialogs by `[role="alertdialog"]` (ConfirmDialog
is an alertdialog, not a dialog). Edit `main.tsx` with proper edit tools, not
ad-hoc string splicing — a text-index splice once matched `boot()`'s `catch`
instead of the intended one and duplicated the file. A synthetic `.click()`
on a `.cm-line` does NOT move the caret: CodeMirror sets the selection from a
mouse event's coordinates, and a programmatic click carries none, so a probe
that then presses ⌘↩ runs nothing at all and looks like a broken chord. Reach
the live editor instead — `EditorView.findFromDOM(document.querySelector(
".cm-editor"))` — and `dispatch({selection})` to the position you want, then
send the key on `view.contentDOM`. And seed notes into a WORKSPACE folder
under the scratch root (`<root>/scratch/`), not the root itself: the root is
the app home, and a `.md` sitting in it belongs to no workspace and is listed
nowhere.

`bun run dev` prefers a Vite dev server by asking whether anything answers on
`localhost:5173` (`bun/index.ts`, `mainViewUrl`). Any other project's Vite
holding that port is what the app will load — a foreign app in the window, or
a blank one — and the probe's own code never runs. Check the port before
concluding the probe is broken.

**The ssh transport** needs a machine to connect to, and "I have a server"
is not a test setup anyone else can repeat. Run one.

For the SERVER transport (`remote.md` §3) that container is written down and
runnable: `bun run probe:ssh` builds the shipped image, adds an sshd to it
(`scripts/ssh-probe/`), installs a throwaway key under the §4 forced command,
and connects with the argv `bun/connections.ts` builds. It asserts the things
that are only true if ssh is really in the path: that the forced command
displaces `whoami`, that a changed host key refuses with no way to continue
anyway, and that a Linux pty answers a command typed from macOS. It holds
`127.0.0.1:22` for a few seconds and removes everything it made. `bun test` in
that same image (`docker build --target build`) runs the whole server suite on
glibc, which is the Linux port's other half.

For `host:` EXECUTION hosts, which is a different feature (`remote.md` §6),
the container is still yours to build, and the shape is: `openssh-server`,
published on `127.0.0.1:22` so a bare `host: 127.0.0.1` is a
valid destination (Ledge builds `ssh -t <host>` with no room for a port), and
an `ssh-agent` of its own on a scratch socket, with a throwaway key in the
container's `authorized_keys`. Pass that socket as `SSH_AUTH_SOCK` and the
app's shells inherit it, so nothing touches the real agent or `~/.ssh/config`.
Give the container more than one user — a second for the `user@host` form, one
whose login shell is fish, one with `enable-bracketed-paste off` in its
`.inputrc` — because those are the differences between servers that the code
actually has to survive, and the container is where you get to choose them.
Two things worth doing deliberately: run it once with the host key *not* in
`known_hosts` (the first connection to a new host is a state every user meets
exactly once, and it is the one where ssh needs an answer before a shell
exists), and remove the entry afterwards with `ssh-keygen -R`.

The transport is also where writing the probe against the real modules pays:
`buildRemoteSpawn` → `PtyProcess` → `InlinePool` is everything under the RPC,
so a script that drives those three answers most questions in seconds, and
only the last pass has to be the whole app.

**The Bun-side variant** — for the seams that never reach the view at all (the
PTY trampolines, the window frame): the clipboard detour is unnecessary,
because a dev build forwards the main process's stdout. Run the built binary
directly, `build/dev-macos-arm64/Ledge-dev.app/Contents/MacOS/launcher` (the
launcher, not the app name), with the scratch `LEDGE_NOTES_ROOT` and the probe
behind an env var, and read `PROBE key=value` lines out of its output.
`bun run build` and `bun run dev` both produce that bundle, so the same binary
answers "does this work" and "is this what ships". Anything driven by the OS
rather than by the user — a window macOS re-positions, a shell the kernel
signals — needs the SAME probe run twice against one scratch home: the second
launch is what proves the state it wrote back is stable rather than creeping a
title bar per restart.

**The iOS variant** — for the seams that exist only there (the bridge, ssh, the
Secure Enclave, the pasteboard, the scheme handler, every number in `ios.md`
§5). The server is `scripts/ssh-probe`'s container rather than a Bun process on
the Mac: it is a real sshd with the §4 forced command already in it, and its
filesystem is the scratch root, so nothing has to be pointed away from
`~/.ledge`.

```
bun run ios -- --build                        # build; the app mints its key at first launch
xcrun simctl launch --console-pty <dev> dev.ledge.ios     # read the [pair] line
docker run -d --name ledge-ios-probe -p 127.0.0.1:22:22 \
  -e LEDGE_PUBKEY="<that key>" ledge-sshd:probe
ssh-keyscan -t ed25519 127.0.0.1              # the line to pin
xcrun simctl launch --console-pty <dev> dev.ledge.ios \
  -LedgeServer ledge@127.0.0.1 -LedgeHostKey "ssh-ed25519 AAAA…"
```

**A probe pairs with launch arguments, and that is not a back door.**
UserDefaults reads `-key value` pairs off the command line, which is how
`-LedgeServer` already worked; giving it `-LedgeHostKey` as well is a phone
that considers itself paired without a human tapping Trust. Nothing on a device
can set those, the pin is still compared on every connection, and the values
live in the argument domain, so they vanish at the next launch and shadow
anything the app stores.

**The device variant** — for the four things a Simulator cannot be (`ios.md`
§13): the phone's own enclave, a suspension that really suspends, a finger, and
a screen the layout was not built on. Two commands, and `ios.md` §12 has the
one-time Apple account work behind the second.

```
bun run probe:ssh -- --serve                  # the fixture on the LAN, not on loopback
bun run ios -- --phone                        # build, sign, install, stream the console
```

**The fixture has to leave loopback.** A Simulator shares this Mac's network
stack, so `127.0.0.1` is the server; a phone is a different machine and there
is nothing there. `--serve` publishes the same container on every interface,
prints the `user@host` to type and the fingerprint to check the pairing screen
against, and appends the `authorized_keys` line pasted into it. Ctrl-C removes
the container and the scratch home.

**Pair by hand here, not with launch arguments.** `-LedgeHostKey` exists so a
Simulator probe can consider itself paired without a human; on a phone it skips
one of the things worth watching. The phone also mints its own key regardless,
so the Simulator's line in `authorized_keys` will never authenticate it: copy
the line off the pairing screen, which has a button for it, and paste it into
the terminal `--serve` is running in.

**The first install always fails, and it cannot be prevented.** It fails on
Developer Mode, under Settings > Privacy & Security on the phone, and that
entry does not appear until an install has been attempted. Turn it on, restart
the phone, run the same command again.

**Whether the key is really the enclave's is a printed line, not an
inspection.** `[pair] key in the Secure Enclave` comes out of
`devicectl --console` at first launch, and `key in software` is the thing that
must never appear there. The software case is compiled out of a device build
(`#if targetEnvironment(simulator)` in `DeviceKey.swift`), so a phone with no
usable enclave throws instead of quietly minting a weaker key: the line
confirms the build, and the structure is what makes it true.

The probe reports with the bridge's `@log`, which is why this variant needs no
clipboard detour: the line comes straight out of `--console-pty` while the app
is running. `xcrun simctl io <device> screenshot` is the other half, and it
needs no permission from anybody. **Do not `pkill` the launcher to move on** —
it owns the app's pty and the app dies with it, which looks exactly like a
crash on the next screenshot.

What this probe reaches that no other does is every refusal. Overwrite
`authorized_keys` in the container to see a key turned away; `rm
/etc/ssh/ssh_host_* && ssh-keygen -A` and restart it to see a changed host key
refused before the phone's key is ever offered; change the exec request to
`whoami`, rebuild, and watch the forced command hand back `ledge-server serve`
anyway. `docker stop` and `docker start` is a wire that really drops. And
`simctl launch com.apple.mobilesafari` then relaunching Ledge is the suspension
lifecycle, which is the one thing a phone does constantly.

**The software keyboard is hidden by default, and two of the things worth
testing only exist on it.** A Simulator with a hardware keyboard attached — the
default — routes text through it, so autocorrect, autocapitalize and QuickPath
swipe typing never run, and a probe that types with `simctl` is not testing any
of them. `defaults write com.apple.iphonesimulator ConnectHardwareKeyboard
-bool false`, quit and reopen Simulator, and the on-screen keyboard comes back;
`defaults delete` the key afterwards. It is a preference of the Simulator app,
not a system setting, and reopening boots whichever device it feels like, so
expect to `simctl boot` yours again. With it off, the audit in ios.md §7 is
tappable: individual letter keys go through iOS's own input path, and
`touch_path` across the letters IS a QuickPath swipe.

**It also comes back on its own, and the symptom is not obvious.** A session
long enough to build and relaunch a few times can find the hardware keyboard
reattached, which looks like a bug in the app rather than in the Simulator: the
accessory bar appears docked at the bottom of the screen with no keys above it,
because that is exactly what iOS shows when a hardware keyboard is connected.
Quit and reopen Simulator and it is right again. Anything about LAYOUT under the
keyboard — which is most of what ios.md §7 now settles — is untestable in that
state, because the keyboard that would change the layout never appears.

**Rebuild the container after any schema change.** `ledge-sshd:probe` bakes the
server in, and the handshake fingerprints the schema on both ends (remote.md
§11), so a client built from a newer `rpc-schema.ts` is refused by an older
image with "the server refused this client: schema … on the server". That is the
check working, and it is a full `docker build` of both images to clear, which
also loses the workspace the probe seeded.

Tear down by uninstalling the app (`simctl uninstall`), `docker rm -f`, and
checking that nothing still listens on 22.

**A slow reader is a test dimension, and until iOS there was no client that
was one.** Everything that speaks the framed protocol — the harness, the Mac,
the probes above — drains its socket as fast as the other end fills it, which
means none of them can ever see a short write. The iOS shell crosses every
frame as base64 through one `evaluateJavaScript` per 32KB chunk, and that is
slow enough to push back through the bridge, through ssh, and onto the daemon's
unix socket; it found a bug there that had been shipping the whole time
(remote.md §3).

So when a change touches a writer, ask what happens when the reader is slow,
and reach for the cheap reproduction rather than the phone. A script that
spawns `bun src/bun/serve.ts serve`, drives it with the real
`clientConnection` over a hand-built `Duplex`, and sleeps between reads
provokes it in seconds with no ssh and no device in the picture — and the
failure is unmistakable, because a frame that stops mid-length-prefix wedges
the stream for good rather than merely arriving late. Note that the threshold
is the platform's, not the protocol's: about 8KB on macOS and about 208KB on
Linux, so a size that reproduces on one may not on the other.

## 7. The green bar

Before any work is called done, all of:

```
bunx tsc --noEmit    # no errors under src/
bunx vite build      # the view still builds
bun test             # everything passes; no skipped tests left behind
bun run test:e2e     # when the change touches UI behavior
```

plus §6 when the change touches the native seams. Report results as they
are: a red test is a finding, not an obstacle to phrase around.

CI (`.github/workflows/ci.yml`) runs that bar on every pull request and every
push to `main`, on a macOS runner — the only platform where it means anything,
since the dylib needs the SDK, the bundle needs `actool`, and the e2e suite
needs WebKit. Two deliberate differences from the list above. It builds the
whole app (`bun run build`), not just the view: a copy map in
`electrobun.config.ts` pointing at a path that no longer exists yields a bundle
that is broken only once launched. And it runs the e2e suite every time, because
"did this change UI behavior" is not a judgment a workflow can make. On the
runner the suite also gets `forbidOnly` (a committed `test.only` shrinks the
suite to one test and still goes green) and one retry — a test that passes only
on the retry is reported as flaky, which is a finding, not a green.

What CI cannot do is §6. The live probe's whole subject is the real app on a
real Mac, and a runner has nobody watching. A green run on a change that
touches the native seams is three of these four layers, not four; the fourth is
done by hand, before the pull request, and said so in it.
