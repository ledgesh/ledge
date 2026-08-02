# Ledge on iOS

**§14 phases 1 to 4 are code. There is Swift, it runs, and it reaches a server
over ssh.** `ios/` is an app that loads this repository's React view in a
WKWebView, authenticates to `ledge-server` with a key minted in the Secure
Enclave, and pins the host key it was paired with; what it does not yet have is
a phone-shaped screen (phase 5) or the rest of v1 (phase 6).
This is phase 6 of `docs/contributor/remote.md`, which built the server the
phone talks to and then stopped, because the client is a different problem in a
different language. Everything below depends on remote.md phases 1 to 5 and
asks for none of them to be redone.

The sixth sibling standard, beside `architecture.md` (whose process topology
it extends by one more process), `interactions.md` (to whose affordance
matrix §6 adds a column), `remote.md` (whose client this is), `locking.md`
(whose passphrase now crosses two hops) and `testing.md` (whose categories
§13 instantiates). Where this document and the code disagree, one of them is
wrong.

Two things this document changes about remote.md, both recorded in place
below: `remote.md` §4's "Ledge parses no key material and computes no hash of
its own" is true of the Mac client and false of this one (§3), and §7's
"sessions outlive connections" is true for a client that reconnects in
seconds and false for one the operating system freezes (§5).

## 1. What the iOS client is

The iOS client is `src/mainview/` in a WKWebView with a Swift shell around
it, where the Mac has Electrobun. It is a client in remote.md §1's sense: it
owns what the user sees and no machine state at all.

There are then three shells and one view, and the view does not know which
one it is in:

| Shell | Entry point | Reaches a server by | Ships |
| ----- | ----------- | ------------------- | ----- |
| Electrobun (`bun/index.ts`) | `main.tsx` | in-process, or `ssh` | the Mac app |
| Playwright (`harness.tsx`) | `harness.tsx` | `FakeStore`, in memory | nothing; `test:e2e` |
| Swift (`ios/`) | `ios.tsx` | SSH, always | the iOS app |

**The view is bound to a server in one place, and the entry points differ only
in which one.** `mainview/boot.tsx` is every `configureX` seam, the boot
prefetch and the render, over a `RequestClient` (`shared/wire.ts`); `main.tsx`
hands it Electrobun's RPC and `ios.tsx` hands it a connection over a socket.
The harness is the exception and stays one: it binds the seams to a `Map`
rather than to a server, so it has nothing to share with the other two.

That split is not tidiness. A second copy of boot.tsx in the iOS entry point is
the third version this section warns about two paragraphs down: two halves of
one client that can drift and mismatch each other.

**There is no local server on iOS**, and that is the single fact the rest of
this document falls out of. Bun does not run there, an app cannot spawn a
subprocess, and a phone is not where anyone wants their notes to live. Every
row of remote.md §1's transport table that mentions a phone is a remote one.
A phone that cannot reach a server has no notes to show, and saying so
plainly is the product rather than a degradation of it.

The shell is Swift and the view is the same TypeScript, so the two version
and ship together. That argues for `ios/` inside this repository
rather than beside it: `checkHello` refuses a schema mismatch between a
client and a server (remote.md §11), and a client whose two halves can drift
against each other has invented a third version to mismatch.

## 2. The shell is Swift; the protocol stays in JavaScript

**Swift owns the socket, the keys, and the six client-only RPC methods.
Everything else about being a client is TypeScript that already exists and is
already tested.**

A connection abstracts its transport down to `Duplex`, which is `write`,
`close`, `onData` and `onClose` and nothing else. `clientConnection` and
`reconnectingClient` are written against that interface, and `fedDuplex` is
the externally-fed shape: something outside hands it bytes with `feed`, and it
holds early chunks until a reader attaches. That interface was built so a
local server and an `ssh` child process could be the same code. A WKWebView
being fed by Swift is a third thing of the same shape.

So the iOS client's protocol stack is the code the Mac runs, running in the
webview instead of in Bun: the frame codec, the handshake, the op ids, the
reconnect ladder, the held requests, and the `ConnectionLost` distinction
between a transport failure and an answer.

The alternative is `wire.ts` reimplemented in Swift. remote.md §3 says both
ends of a connection are one thing described twice and that the remote path
is not a second implementation; a Swift client would make that false. What it
would duplicate is also the worst possible list to duplicate: frame
boundaries, the dedupe window, and the instance check that decides when a
replay is safe. Those fail silently and their failures are corrupted notes.

**The portable half is `shared/transport.ts`** (phase 1, done): `Duplex`,
`clientConnection`, `reconnectingClient`, `fedDuplex` and `ConnectionLost`,
none of which touch a runtime API. What stays in `bun/transport.ts` is what
touches a process — `spawnDuplex`, `stdioDuplex` — and `serverConnection`,
which exists to serve a handler map that only a server has. The binary
companion rule went into `shared/wire.ts` with the rest of the codec, because
both halves keep it. `architecture.md` §1 forbids the view importing
`src/bun/`, and this is not a workaround for that rule but the thing the rule
is for: the line between what a browser can run and what it cannot is exactly
where the module boundary belongs. `shared/portable.test.ts` is that line as a
test, and it checks the second half of the rule too — that nothing in
`src/shared/` reaches for a global only Bun has.

The codec's own base64 was the one thing in the moved path that a webview
could not have run: `wire.ts` converted with `Buffer`, on the argument that
both ends were Bun. It uses `Uint8Array.prototype.toBase64` and
`Uint8Array.fromBase64` now, which Bun and WebKit both have (checked in the
harness's WebKit, since that is the engine lineage the app ships in). The
builtins are strict where `Buffer` was lenient, and strict is what this
position wants: every string they see was written by the encoder a few lines
earlier, so one that is not base64 is a bug, and decoding the valid prefix
would have put short bytes on the wire and reported success.

**Bytes cross the in-device bridge base64'd.** `WKScriptMessage.body` carries
the JSON-compatible types only, so a `Uint8Array` does not survive the trip
from JavaScript to Swift. That reverses remote.md §3's arithmetic without
contradicting it: base64 costs a third of a cell connection's bandwidth and a
third of a memcpy inside one device. Frames stay binary on the wire, where
the cost is real, and the transport is unchanged. If the bridge ever measures
as the bottleneck, a `WKURLSchemeHandler` can stream `Data` in the
server-to-client direction, which is the direction with the volume; that is
an optimization to reach for with a profile in hand, not a thing to build
first. Phase 3 says it is not the bottleneck yet: a whole boot's frames cross
it inside the 16ms between `server` and `view` in §5's measurement.

**The bridge is ten strings, and it is written down twice.**
`mainview/lib/nativeBridge.ts` is the page's half and
`ios/Sources/WebHost.swift` is Swift's; between them is a byte stream in both
directions and a request/response channel for what only a device can answer.
Three rules keep it from growing into a second protocol:

- **A frame is opaque.** Swift base64s what the socket gives it and hands over
  what the page hands back. No Swift code parses a frame or knows a method
  name.
- **The calls are their own vocabulary.** `clipboard.read`, not
  `clipboardRead`. They are not the schema's methods, and naming them as if
  they were is the invitation to implement half the schema in Swift.
  `clipboard.image` is the case that proves it: the schema's `assetPaste`
  reads a pasteboard AND names a file in a workspace, which are two machines'
  jobs (remote.md §5). Swift answers the first half and the page sends the
  bytes on to `assetWrite` for the second, so the client still never names a
  file.
- **Every socket has a generation.** A reconnect opens the next one while the
  previous one's close is still crossing the bridge, and a message from a
  generation the page has moved on from is dropped rather than delivered.
  Without it, the obituary of the connection that just died hangs up the one
  that just replaced it.

## 3. SSH without an ssh binary

**iOS runs no subprocesses, so there is no `ssh` to spawn.** The app links an
SSH implementation instead. SwiftNIO SSH (`apple/swift-nio-ssh`) is the
choice: it is Apple's, it is Swift, and it supports
`SSHChannelRequestEvent.ExecRequest`, which is the whole of what remote.md §3
asks a transport to do.

`bun/connections.ts` builds an argv, and on iOS that argv has no executor.
Every flag in it becomes a question about who enforces the thing it asked
for:

| `sshCommand` | Enforced on the Mac by | On iOS |
| ------------ | ---------------------- | ------ |
| `command="ledge-server serve"` | the server's sshd | the server's sshd, unchanged |
| `StrictHostKeyChecking=yes` | OpenSSH | the app's host-key delegate |
| `UserKnownHostsFile` | OpenSSH | the app's own store |
| `GlobalKnownHostsFile=/dev/null` | OpenSSH | nothing to exclude |
| `BatchMode=yes` | OpenSSH | no prompt exists to suppress |
| no `-t` | OpenSSH | no pty is requested |

The first row is the one that matters and it is the row that does not move.
remote.md §4's restriction lives in the server's `authorized_keys`, so it is
indifferent to what the client is written in. A client that speaks SSH badly
gets a connection that fails; it does not get a capability nobody granted it.
`scripts/probe-ssh.ts` proves that today against a real sshd, and it proves
it for this client too.

**What Ledge now does itself.** remote.md §4 says Ledge parses no key
material and computes no hash of its own, because OpenSSH does the pinning
and Ledge is only its client. That sentence describes the Mac and stops being
true here. NIOSSH hands the offered host key to a client delegate and the app
decides.

Keep the decision as small as it can be: the pinned key from the connection
record against the key offered, compared as encoded bytes, refusing on any
difference. An equality test on a blob is not a parser, and remote.md §4's
"no blind accept and no continue-anyway that remembers" is a property of the
UI rather than of the comparison. The fingerprint shown at pairing is for a
human to read, so it is rendered from the same bytes and never used to
decide.

**No RSA, and that is a constraint on the server too.** SwiftNIO SSH supports
Ed25519 and ECDSA over P256, P384 and P521, with AES-GCM and x25519, and
nothing else. Two consequences: a server offering only an `ssh-rsa` host key
cannot be pinned by this client, and a user's existing `id_rsa` cannot be its
client key. The second does not matter, because the phone mints its own key
(§4). The first rarely bites, because sshd has offered an ed25519 host key by
default for years, but it is a sentence `docs/user/` owes anyone whose server
is old.

**NIOSSH is building blocks, not a client.** Its own README says so. What it
ships is the protocol; connection setup, the authentication flow, channel
management, keepalives, and every timeout are the app's to write. That is the
largest single piece of Swift in this design and the phase most likely to
take longer than it looks (§14).

**Two of those blocks have no edges, and both cost a live debugging session.**
Neither is a bug in NIOSSH; both are the shape of a library that hands back
events and expects an application around them.

- **An error is fired and then dropped.** A host key that fails the pin and a
  key the server will not take both arrive as `errorCaught` on the connection's
  pipeline. NIO's default for an unhandled error is to log it and carry on, so
  without a handler at the tail the connection sits there, neither up nor down,
  until something else gives up: a refusal that was immediate and specific
  gets reported fifteen seconds later as "no answer in time".
  `SSHTransport.swift`'s `FailOnError` is that handler, and it is why the
  reasons in §4 reach a person at all.
- **"No more methods" is a failed promise, not a nil.** The client auth
  delegate's documentation says to fail the promise when there is nothing left
  to offer. It means it: there is a `noFurtherMethods()` in the state machine
  for the nil case and nothing in the library ever calls it, so answering nil
  sends no message and waits for the server's login grace period.

**The key algorithms line up with the Mac's, by luck rather than by
agreement.** NIOSSH offers `ssh-ed25519` first, which is also the first entry
in `connections.ts`'s `KEY_PREFERENCE`, so a pin taken by `ssh-keyscan` on a
Mac names the key an iOS connection will actually be offered. That is worth
knowing rather than relying on: the app pins what the connection in front of
the user offered (§4), so the two lists agreeing is a convenience, not a
requirement.

## 4. Keys live in the Secure Enclave

**The phone mints its own key on first launch and never holds a copy of the
user's.** `NIOSSHPrivateKey` has an `init(secureEnclaveP256Key:)` behind
`#if canImport(Darwin)`, so the private key can be generated inside the
Secure Enclave and never leave it. The app holds a reference; signing is a
call into the enclave, gated by the device passcode or biometrics.

That gives a property the Mac client does not have. A lost phone hands over
no key material at all, because there is none to hand over, and revoking it
is deleting one line from `authorized_keys` on the server.

**The enclave is not gated per signature, and that is deliberate.** CryptoKit's
default access control for an enclave key is "this device, while unlocked",
which ties the key to the passcode at unlock time. Requiring `.userPresence`
instead would put a Face ID scan in front of every signature, and §5's whole
point is that reconnecting is the ordinary path on a phone: the prompt would
land on an app switch, not on a login.

**Two things the build has to do for the key to exist at all.** The private
half is a keychain item, and the keychain answers `errSecMissingEntitlement`
to a process with no application identity — which an unsigned bundle is. So
`ios-build.ts` signs the app ad hoc and gives it `application-identifier` and
a keychain access group (`ios/Resources/Ledge.entitlements`). On the Simulator
those entitlements go in a Mach-O section (`__TEXT,__entitlements`) at link
time, not in the signature; a signature that carries them is refused at launch
with a POSIX 153 and no explanation. A device build puts the same plist in the
signature, where a provisioning profile decides what the identifier really is.

**The Simulator has an enclave.** On Apple silicon `SecureEnclave.isAvailable`
is true inside the Simulator and `SecKeyCreateSignature` reaches the host's
SEP, so the path a probe exercises is the real one rather than a stand-in.
`DeviceKey.swift` keeps a software key anyway, for a Simulator that does not:
it is refused on hardware, because a key on disk is a weaker thing than the one
this section promises and silently downgrading to it is how a security property
becomes a claim nobody checked.

It also decides the key type: `ecdsa-sha2-nistp256`, because the Secure
Enclave does P-256 and nothing else. OpenSSH accepts it by default. A server
whose `PubkeyAcceptedAlgorithms` has been narrowed to Ed25519 will refuse it,
which is a posture to name in `docs/user/` rather than debug in the field.

**Keys are per device, not per user.** Two phones are two lines in
`authorized_keys` and revoking one does not touch the other. This falls out
of the enclave rather than being a policy: a key that cannot be exported
cannot be shared.

**Pairing is a line the user copies.** The app shows its public key and the
whole `authorized_keys` line, forced command included, exactly as remote.md
§4 writes it. Getting that line onto the server is the user's problem in v1,
which is the same problem the Mac client has today and the same one
`docs/user/18-notes-on-another-machine.md` already documents. A Mac running
Ledge could append it for a phone on the same network, and that is a good v2
and an unnecessary v1.

One consequence to write down before it surprises someone: **deleting the app
destroys the key.** The container goes, and the enclave reference with it. A
reinstall is a new client with a new id, a new key, and a stale line in
`authorized_keys` that will never authenticate again. That is correct
behavior and it needs to be said out loud, because the user-visible symptom
is "my phone stopped working after I reinstalled" and the fix is pairing
again.

## 5. The connection drops constantly, and that is the normal case

**iOS suspends an app shortly after it leaves the foreground, and a suspended
app's socket dies.** Reconnecting is the ordinary path on a phone, not the
failure path, and three numbers decide what that costs:

| Clock | Length |
| ----- | ------ |
| Background execution after leaving the foreground | about 30s, then suspension |
| The reconnect ladder (`shared/transport.ts` `RECONNECT_DELAYS`) | 8 attempts, 31.75s |
| The daemon's idle exit (`daemon.ts` `IDLE_EXIT_MS`) | 60s |

Three consequences, in the order they bite:

- **The ladder does not run while suspended.** No timers fire in a suspended
  process. A phone that comes back after an hour would resume a countdown
  that learned nothing, so the client dials on the foreground lifecycle
  notification rather than on a timer. The ladder keeps its job, which is a
  wire that flaps while the app is on screen.

  The shell does the simplest true version: it closes the socket on the way
  out and refuses a dial while the app is away, and on the way back the page
  reloads unless its connection is somehow still live. Refusing the dial is the
  part that is not obvious — iOS gives about thirty seconds of background
  execution and the ladder is 31.75s long, so without it the whole ladder runs
  in the background, succeeds, and hands back a socket that suspension kills a
  moment later. Holding the socket across a short app switch instead is an
  optimization, and the thing it would have to get right is telling a live
  socket from a half-open one, which is the one distinction that has no cheap
  answer.

  Measured over ssh: leaving the app announces `reconnecting` and the refused
  dial keeps the ladder from doing anything with it; coming back reloads and
  reaches a server again 211ms later. A whole boot is cheaper than the
  bookkeeping that would avoid it.
- **The server is usually gone, and the sessions with it.** Sixty seconds of
  no client and nothing running is the daemon exiting. `running()` means a
  block in flight or a shell inside a foreground command, so an idle drawer
  sitting at a prompt holds nothing. remote.md §7's "sessions outlive
  connections" therefore holds for a Mac that reconnects inside half a minute
  and not for a phone that comes back after lunch. What is lost is the PTYs
  and the scrollback ring; what is not lost is the notes, which is the right
  side of that trade.
- **The writes are already safe.** A reconnect that reaches a *different*
  daemon instance sees a different `Hello.instance` and fails what was in
  flight rather than guessing (remote.md §7). The op log's window is 120
  seconds, so a write retried across a short background trip either lands
  once or is refused, and never applies twice.

  The corollary is the phone's only dead end. A server that restarted is a new
  instance, so the ladder stops for good rather than adopting it: sessions the
  app believes in no longer exist, and nothing below the transport can rebuild
  them. Recovery is choosing the connection again, which on a Mac re-attaches
  and on a phone is the same boot as foregrounding — `nativeBridge.ts` answers
  `connectionSelect` for its one server by reloading the page. Without that the
  connection row is a dead label and the app waits to be force-quit, which is
  what a live server restart actually did before this was written down.

**The idle timeout stays at 60 seconds.** Raising it for phones would leave a
process running on someone's Mac for a client that may never come back, and
the phone has nothing worth keeping alive while v1 does not run commands
(§8). When live execution arrives, the answer is a client that declares it
wants its sessions held, with the server timing that request out on its own
terms. It is not a bigger constant.

**So foregrounding is a boot, and the boot is the number to measure.** The
view's boot builds the registry, the note lists, the tags and the layout, and
those are concurrent, so remote.md §12 charges them as one round trip. What
it does not charge is the SSH handshake in front of them: a TCP connect, a
key exchange, an authentication, and a channel open, none of which can be
overlapped with the first frame. That is the latency the phone actually
feels, it is invisible on a Mac whose local server needs no handshake at all,
and it is why §14's first measurable phase is a stopwatch rather than a
screen.

**The stopwatch.** `ios.tsx` marks each phase and reports the line through the
bridge's `@log`, so it comes out of `simctl launch --console-pty`. On a
Simulator, warm, over ssh to a container on loopback — with the plain TCP
fixture phase 3 measured beside it:

| Mark | At | Cost | Phase 3 |
| ---- | -- | ---- | ------- |
| `bridge` | 70ms | loading and parsing the view | 190ms |
| `hello` | 72ms | 2ms — who we are, where we point | 7ms |
| `socket` | 141ms | 69ms — TCP, key exchange, authentication, exec | 14ms |
| `server` | 191ms | 50ms — the protocol handshake | 7ms |
| `view` | 200ms | 9ms — the whole boot prefetch | 16ms |
| `paint` | 247ms | 47ms — the first composited frame | 109ms |

Three things to read off it, and one to distrust. **The prefetch is one round
trip**, which is remote.md §12's claim measured rather than asserted: six
requests across three workspaces cost 9ms, no worse over ssh than over a bare
socket, because they are concurrent and the round trip is paid once. **The
handshake is what phase 4 cost**, and the prediction was right about the row
and low about the size: `socket` went from 14ms to 69, a key exchange and a
P-256 signature in the Secure Enclave in place of a `connect(2)`. **And
`server` is not a round trip**, it is a process launch: every ssh session runs
`ledge-server serve` on the far side, and Bun starting is most of the 50ms —
120ms when the daemon behind it has to start too. The number to distrust is
`bridge`: a first launch after install measured 1548ms to paint, so any figure
taken from a cold Simulator is measuring the Simulator.

Four hundred milliseconds of ssh, end to end, and the app is on screen. That
is the number that decides whether §14's "foregrounding is a boot" is a design
or an apology.

## 6. Touch is a column the affordance matrix does not have

**A phone has no hotkeys, no hover, no right-click and no double-click.** Four
of the six columns in `interactions.md` §1 are unavailable, including the one
that every high-frequency action is required to have. The column exists now:
this section is implemented (phase 2, §14) and its normative home is
`interactions.md` §1a, which the view is built against. What stays here is why
it was smaller than it looked.

What survives is the palette and the context menu, and interactions.md
already guarantees both exist for everything. **R1** puts every command in
the palette. **R2** forbids a hover-revealed control from being the only path
to anything. **R6** makes the context menu the canonical home for row verbs
and calls a missing entry a bug. A touch-reachable path to every verb is
therefore already required, and has been since before a phone was in scope.
That is the finding that makes this phase smaller than it looks: the phone
needs a way to *reach* those two surfaces, not a second grammar of its own.

**The mapping itself lives in `interactions.md` §1a**, one table from desktop
affordance to touch, with the long press's own rules (which pointers get it,
what cancels it, what it does to focus) and the two that had to be added rather
than translated: focus stops being invisible state when no hover ever hinted at
it, and destructive verbs keep their confirmation while losing their
accelerator. It is written there and not here because it is now behavior in the
shipping view rather than a plan for one, and a table in two normative
documents is a table that will disagree with itself.

**The connection indicator is chrome, with more force than on the Mac.**
remote.md §8 makes it persistent because running a command on the wrong box
is the failure mode. On a phone there is no local server to fall back to, the
note list is a client-side cache (remote.md §12), and a phone with a dead
wire is showing that cache. The indicator names the machine and says whether
it is reachable right now, so a stale list is legible as one.

## 7. The editor on a phone

**CodeMirror 6 is the editor on iOS too, and it is the largest unknown in
this design.** CM6 supports touch devices. What it does not do is behave
identically, and the gap is where this phase's risk sits.

Reported against CM6 on iOS, each needing a re-check against the current
release before anything is designed around it: selection drag handles missing
from the editor, the cut/copy callout failing to appear after a double tap,
"select all" from the callout moving the caret instead of selecting on large
documents, autocapitalize misfiring at the start of a line, and swipe typing
inserting a leading space. None of these is fatal and all of them are the
kind of thing a user reads as "this app is broken" rather than "Safari is
odd".

Four decisions follow:

- **Live preview defaults on, independently of the Mac.** `editor.livePreview`
  is an appearance setting, and appearance settings are client-owned
  (remote.md §5), so a phone can conceal markup whether or not the desktop
  does. On a 390-point screen the concealed form is the readable one.
- **The keyboard accessory bar is where the phone's chords go.** ⌘↩ has no
  touch equivalent, but the strip above the keyboard does: indent and
  outdent, the formatting trio that ⌘B, ⌘I and ⌘K own on the desktop
  (interactions.md §2), and the `[[` that opens the wikilink picker. It is a
  native `inputAccessoryView` rather than HTML, because HTML that tries to
  sit above the keyboard is fighting the visual viewport for the whole life
  of the app.
- **Autocorrect, autocapitalize and spellcheck are off on the editor.**
  Markdown is not prose to iOS's dictionary, and an autocorrected fence is a
  broken one.
- **Nothing is deleted from the keymap to make touch work.** An iPad with a
  hardware keyboard is a Mac-shaped client and the existing keymap is already
  right for it. Serving it is not a v1 goal; breaking it would be a v1
  mistake.

## 8. What v1 is, and what it cuts

**v1 reads, edits, creates, searches and navigates notes. It does not run
commands.**

| In v1 | Out of v1 |
| ----- | --------- |
| The note list, quick open, full-text search | Running blocks and terminal drawers |
| Tags, backlinks, the outline | The host picker and the run confirmation |
| Editing, with live preview | Attaching a workspace folder |
| Daily notes, templates, wikilinks | Editing profiles or behavior settings |
| Rendered images, and adding them from the photo library | Moving a workspace |
| The trash | |
| Workspace and connection switching | |
| Unlocking a locked note (§10) | |

**Running commands is cut for its interaction surface, not because it cannot
work.** A block that is running holds the daemon open through `running()`, so
the run itself survives a backgrounded phone and its output is still in the
ring when the app comes back, as long as the phone returns before the next
idle check finds nothing running. That grace is anything from zero to sixty
seconds after the run ends, depending on where it fell in the window relative
to the last check. What does not survive is an idle drawer, and what does not
exist yet is any of the rest of it: the host picker
(interactions.md §4a), the confirmation (§4b), the unterminated-fence refusal
(§4c), the rules about who owns the keyboard while a block runs (§6a), and an
ANSI terminal on a phone screen. That is the part of the app where being
wrong runs a command on the wrong machine, and it is not the part to build
while the ssh transport is still new.

**Attaching a workspace is cut because the server already refuses it.**
`bun/server.ts` answers a headless folder dialog with "attaching a folder
needs the app running on the machine that holds the notes". A phone is
permanently that case. The verb should be absent rather than present and
failing.

## 9. State ownership on a phone

remote.md §5's table needs no new rows. It needs one substitution and two
consequences.

**The client home is the app's container.** `LEDGE_NOTES_ROOT` has no meaning
on iOS; the sandbox is per-install and is the isolation. The connection
records, Ledge's own pinned host keys, the client id and the client
`settings.jsonc` live there, in the same shapes `bun/clientHome.ts` writes
today, with the Secure Enclave holding the one thing that is not a file.

**Layout keyed by client id is what stops a phone inheriting a desktop.**
That was already the design (remote.md §5) and the phone is the case it was
written for: a three-pane layout restored onto a 390-point screen is the
failure it prevents. The phone writes a single-pane tree of its own and the
Mac never sees it.

**Appearance settings are already per device**, so the phone's font size is
independent by construction and nothing new is needed to make it so.

## 10. Locking on a phone

**Unlocking is in v1, and the phone stores no passphrase.** remote.md §9
already has the passphrase crossing the connection once per unlock to the
machine that holds the notes, which is the only machine that can use it. A
phone adds a hop and no new principal. Leaving locked notes unopenable on the
phone would be a worse answer, because a note that cannot be opened and does
not say why is indistinguishable from a bug.

**Face ID does not replace the passphrase, and v1 does not pretend it can.**
The master key lives in the server's memory (`bun/vault.ts`) and biometrics
on a phone prove nothing to the machine on the other end. What Face ID
could do is gate a passphrase stored in the phone's keychain, which is a real
weakening of the threat model in `locking.md` §1 and deserves to be decided
on its own rather than acquired as a convenience. v1 stores nothing and asks
every time.

**Idle relock is the server's timer and does not change.** A phone that
disconnects does not relock the vault; walking away does, which is what the
timer measures. A phone that has been suspended for an hour will find the
vault locked, and that is the timer working.

`locking.md` §8's agents-never-read-locked-bodies invariant is untouched. A
remote client is a UI surface, not an agent surface, and the refusals live at
the `notes.ts` seam on the server.

## 11. What never reaches the phone

Everything in remote.md §10 stays true, and the phone adds four entries of its
own:

- **Notes are not in Files.** The app's container holds no note bytes. There
  is nothing to export and nothing to sync, and the share sheet shares text
  the view already has rather than a file.
- **Images arrive from the photo picker, not a pasteboard.** `assetPaste` is
  a client seam (remote.md §10) and on iOS its source is PHPicker or the
  camera. The bytes still ride `assetWrite` on a type-1 frame and the server
  still names the file, seals it if the note is locked, and refuses a
  read-only root. remote.md §2's "the client never names a file" is
  unaffected.
- **`menuSet` is a no-op.** There is no menu bar. It is already a client-only
  method the server refuses, so this costs nothing but a stub.
- **`linkOpen` is `UIApplication.open`.** Opening a URL happens on the device
  in the user's hand, which is what made it a client method in the first
  place.

## 12. Distribution

**The App Store, and guideline 2.5.2 is not the problem it looks like.** 2.5.2
forbids downloading and executing code that changes the app after review.
This app executes nothing locally: the WKWebView runs the reviewed bundle,
and commands run on the user's own server over SSH. That is what every SSH
client on the store does, and there are several. When live execution ships
(§8), the review note is that the app is a terminal, not an interpreter.

**TestFlight is the distribution for as long as this is one person's
notebook.** Nothing in the design needs a paid tier, a server of Ledge's, or
an account.

**The manual comes from the server.** `bun/docsContent.ts` compiles
`docs/user/` into the server binary (remote.md §11), so the phone showing the
manual is showing the connected server's version of it, and the iOS bundle
ships none of it. A phone connected to an old server sees that server's docs,
which is the behavior that keeps the docs honest.

The view is built by Vite and copied into the app bundle as a resource. Its
entry point is a third one beside `main.tsx` and `harness.tsx` (§1), and its
build is a second config rather than a second input on the first: `dist/` is
copied wholesale into the Mac app, so an `ios.html` sitting in it would be a
dead page shipped to every Mac. `vite.ios.config.ts` writes `dist-ios/`, the
sibling of `dist-cli/` and `dist-native/`.

**The app is a package manifest and a directory, not an Xcode project.**
`scripts/ios-build.ts` runs `swift build` over `ios/Package.swift`, writes an
`Info.plist`, copies the view in beside it, and hands the result to `simctl`.
A project file would be a second, generated description of facts that are
already legible — unreadable in a diff and unverifiable except by opening
Xcode. Phase 3 got away with a bare `swiftc` over a glob; phase 4 has a
dependency to resolve, which is the one thing a glob cannot do, and SwiftPM is
the smaller of the two answers to that.

Four things that build has to do that Xcode would have done quietly, each of
which announced itself as a launch failure with no obvious cause:

| What | Why |
| ---- | --- |
| `-sdk` and `-target` pushed through `-Xswiftc`, `-Xcc` and the link | SwiftPM builds for its host and has no iOS destination. The last `-target` wins, which is why the output lands in a directory named for macOS and is an iOS Simulator binary |
| The back-deployment shims copied into `Frameworks/` | A binary built with this toolchain and deployed to iOS 17 links a compatibility dylib for every standard-library type the runtime there lacks. Missing, it is a dyld abort at launch. The list is read out of the binary, because it belongs to the toolchain |
| An ad hoc signature | The keychain answers `errSecMissingEntitlement` to a process with no application identity, and the device key is a keychain item (§4) |
| Entitlements as a Mach-O section, not in the signature | The Simulator's rule, and not the device's. A signature carrying them is refused at launch with a POSIX 153 |

**The Swift closure is a second set of attributions.** architecture.md §8 says
every dependency travels with the binary it ships in; the Mac app's notices are
generated from npm and committed, and the iOS app's are generated from the
resolved SwiftPM checkouts into the bundle at build time. Seven packages, all
Apache-2.0, whose LICENSE and NOTICE files both travel. What is still owed is a
way to read it on the phone: the manual the app shows is the server's, and the
server knows nothing about this app's dependencies.

The webview loads the bundle over a scheme of its own
(`ios/Sources/BundleScheme.swift`) rather than `file://`, because `file://`
gives every resource an opaque origin of its own and the view loads a
CodeMirror language mode per fence through `import()`.

## 13. Testing

Per `testing.md`'s categories:

- **Unit (colocated `bun test`)**: the transport half that moves to
  `src/shared/` (§2) keeps every test it has, and the move is only correct if
  they stay green unchanged. New: the host-key comparison and its refusal,
  and the `authorized_keys` line the pairing screen generates, which must
  match what remote.md §4 specifies character for character.
- **e2e (headless WebKit)**: a phone is the same view at a phone's viewport,
  so the harness gained a mobile project at 390x844 rather than a second
  harness (phase 2, done). WebKit at that size is what catches a palette
  nobody can reach, a row menu that opens off screen, and a verb that survived
  §6's translation only on paper — the middle one it caught on the first run.
  What it cannot catch is the input itself: Playwright's touchscreen taps and
  does nothing else, so a long press is dispatched as pointer events, and
  whether iOS delivers that same sequence under a finger is the Simulator's
  question, answered by a hand on it rather than by any harness.
- **The Simulator (`bun run ios`)**: `testing.md` §6's live probe, for the
  seams that only exist here — the bridge, the socket, the pasteboard, the
  scheme handler, and every boot number in §5. It is a better probe than the
  Mac's, because the bridge has a `@log` call: a `PROBE key=value` line comes
  out of `simctl launch --console-pty` directly, with no clipboard detour and
  no waiting on `pbpaste`.
- **The Swift side, against the fixture that already exists**:
  `scripts/probe-ssh.ts` stands up a real sshd with a real forced-command key
  (`scripts/ssh-probe/`). An iOS client dialing that same fixture gets the
  same proof the Bun client got, against the same server, which is worth more
  than a second fixture written to be easy for Swift. testing.md §6 has the
  recipe, including how a probe pairs a build without a human.
- **What no harness can reach**: the accessory bar, a finger, and a real
  network. Those are a live probe with a device rather than a Mac. The enclave,
  NIOSSH and the suspension lifecycle turned out to be reachable from a
  Simulator on Apple silicon (§4), which is the difference between "unproven"
  and "unprovable".

One trap to write down before it is stepped in: **the Simulator's Secure
Enclave is not the device's.** A key-generation path that quietly falls back
to a software key when the enclave is unavailable is a path that ships, and
the symptom is a private key on disk in an app whose entire security story is
that there is not one. The fallback must be visible in the UI or must not
exist.

The lifecycle itself is testable and should be tested by hand every time §5
changes: background the app, wait past 60 seconds, foreground it, and check
that it dials, that the daemon is a new instance, and that a write made just
before backgrounding did not apply twice.

## 14. Phasing

Each phase leaves something that can be demonstrated, and the first two ship
inside the Mac app.

1. **Done. The transport split.** `Duplex`, `clientConnection`,
   `reconnectingClient`, `fedDuplex` and `ConnectionLost` are
   `shared/transport.ts`; the handler-map types moved to `shared/wire.ts` with
   the binary companion rule, so the portable half type-depends on nothing in
   `src/bun/`. `shared/portable.test.ts` holds the line.

   Two things changed rather than moved, both found by moving them. The codec's
   base64 is the TC39 builtins now (§2). And `fedDuplex` announced a hangup
   from its `onClose` setter without checking that a reader had attached, so a
   consumer that set `onClose` before `onData` was told the wire was gone
   before it was given the last bytes that came over it — invisible with one
   consumer, which is what phase 3 stops being.
2. **Done. The phone viewport.** The `phone` project runs the real view at
   390x844 with touch and no chords, and §6's affordances are behind it:
   a long press opens any row's menu (`lib/useRowMenu.ts`, one seam for every
   row kind, tabs included), the header's magnifier opens the overlay, and
   the destructive verbs run from their menus through the confirmations they
   already had. The claim §6 made on paper is now two tests: `phone.spec.ts`
   walks the surfaces, and `registry.test.ts` holds the invariant that no
   command hides behind a chord (interactions.md §1a).

   Two things the viewport caught that reading could not. A menu clamped its
   TOP to a guessed 88px above the bottom of the window, so a menu of any real
   height opened partly off a phone screen; placement is measured now
   (`lib/menuPlacement.ts`). And the click WebKit sends after every touch was
   reaching the row underneath, so a long press opened the note it was only
   asking about.

   Deliberately not done here: the 390pt layout. The sidebar keeps its 224pt
   and leaves the editor 161, which is bad and is not a reachability problem —
   every verb in the specs above runs at that size. Panes, the drawer and the
   single-pane tree §9 describes belong with the shell that has a real screen,
   not with a desktop window pretending to be small. (That said phase 3 when it
   was written, and phase 3 turned out to be the wrong home: see below.)
3. **Done. The Swift shell, without SSH.** `ios/` is a WKWebView loading
   `dist-ios/` over a scheme of its own (§12), a bridge of ten strings (§2),
   the six client seams answered by UIKit, and a `Duplex` fed by an
   `NWConnection` to a TCP fixture on the same network. `bun run ios` builds it
   and launches it in the Simulator.

   **That fixture opened a port and had to never become a shipping mode**:
   remote.md §3's first claim is that the server opens none, and a debugging
   convenience that survives into a release undoes the entire authentication
   design. It was safe because it could not ship — `scripts/` is in no build —
   and phase 4 deleted it, because a transport that is really ssh leaves it
   with no client. `ports.test.ts` now sweeps the whole repository rather than
   `src/`, which is the stronger claim that deletion made available.

   What it proved, on a Simulator against a scratch `LEDGE_NOTES_ROOT`: the
   note list arrives over the socket and renders; a keystroke in CodeMirror on
   the phone lands on disk on the Mac; the pasteboard round-trips through
   `UIPasteboard`; `linkOpen` refuses a `javascript:` URL at the Swift
   boundary, not just in the view; and killing the fixture mid-session takes
   the app to "reconnecting" and restarting it takes it back to "live" — the
   ladder in `shared/transport.ts`, over a wire that really dropped. §5 has the
   boot numbers.

   Deliberately not done here, and this is where phase 2's note above should
   have pointed: **the phone's screen.** Phase 3's charter is the shell and the
   transport, and the layout is neither. It is also not the small change it
   looks: making the sidebar an overlay changes how every row in
   `e2e/phone.spec.ts` is reached, so it needs its own specs, and it touches
   the Mac's most load-bearing component to do it. It belongs with the editor,
   below, because both are answers to "what does a phone show and how do you
   type into it".
4. **Done. SSH.** `SSHTransport.swift` is NIOSSH: a connect, a pinned host key,
   a P-256 key that lives in the Secure Enclave, and an exec request whose
   answer is the byte stream the page already knew how to read. `DeviceKey`,
   `HostKey` and `Pairing` are the three around it. The view changed by one
   boolean — its single connection row says `pinned` now — because a duplex
   does not know what carries it.

   What it proved, against `scripts/ssh-probe`'s container: the enclave signs
   the authentication (`SecKeyCreateSignature` reaches the SEP even in a
   Simulator); the forced command holds, checked by asking for `whoami` and
   getting `ledge-server serve`; a key removed from `authorized_keys` is
   refused in two seconds with the line to install; a host key that changed is
   refused in one, **before the phone's key is ever offered**, with both
   fingerprints on screen and no way to continue anyway; the fingerprints match
   `ssh-keygen -lf` exactly; a note written on the server appears on the phone
   with no interaction; and backgrounding, waiting and returning is a 211ms
   boot. §5 has the numbers.

   Three things went wrong that only a live run could have found, and all three
   were the same shape — a refusal that had nowhere to go. §3 has two of them
   (an error fired into a pipeline with no tail, and a delegate contract that
   wants a failed promise); §5 has the third (a restarted server ends the
   session, and the phone had no way to start another).

   Not done here: a real device. Everything above is a Simulator on Apple
   silicon, which has an enclave and a network but not a finger, a radio, or a
   provisioning profile.
5. **The screen, and the editor.** The single-pane tree §9 describes, a sidebar
   that overlays rather than takes a third of the width, the accessory bar, the
   disabled autocorrect, and §7's audit of what CM6 actually does on a current
   iOS. This is the phase whose size is genuinely unknown, and it is placed
   after the transport works so that the unknown is isolated.
6. **The rest of v1.** Search, tags, backlinks, the outline, daily notes,
   images through PHPicker, and unlocking.

Live command execution is not in this list. It is the phase after v1, and §5
says what it has to answer first: a client that can ask a server to hold its
sessions, and a server that times that request out on its own terms.
