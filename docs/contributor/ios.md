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

**The bridge is fifteen strings, and it is written down twice.**
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

**The native pairing screen is the empty case, and only that.** It exists
because a phone with no server has no page to render a dialog in, and it is
reached on a first launch, after a host key changes under a record that still
exists, and after the last server is removed. Every server after the first is
added from the connection dialog like a Mac's (remote.md §8) — the same list,
the same fingerprint step — and the key line the pairing screen hands over is
the same line that dialog's form shows, carried across on `@hello` because it
is a fact about the device rather than about any connection to one.

**A pin on a phone is a key and no hostname.** There is no `known_hosts` file
here for a hostname to index (§3), so the record itself is the index, and
nothing in the pin says which machine it came from. That is why editing an
address onto a different host has to be pinned again rather than checked: the
Mac can compare a `known_hosts` line's first field and refuse the mismatch, and
this end can only compare the address it is being moved off.

**A probe is a dial that stops at key exchange** (`CapturingHostKey`). There is
no `ssh-keyscan` in this process, but the host key is offered before user auth,
so the fingerprint arrives without this phone's key going on the wire and
without the server having accepted it yet — which is exactly what a keyscan is.
The delegate refuses every key it is shown; the refusal is the point, and the
answer is read off `offered` afterwards.

**Swift holds the list's bytes and the page holds its shape**, the same split
`.layout.json` has on a Mac (architecture.md §6). `ServerStore` reads two fields
out of the selection — an address to dial and a key to pin — and three bridge
calls (`servers.list`, `servers.save`, `servers.probe`) are the whole of it. The
alternative, a verb per operation, would have put "may this be removed" in Swift
beside the Mac's copy of the same rule in TypeScript.

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
failure path, and five numbers decide what that costs:

| Clock | Length |
| ----- | ------ |
| Background execution after leaving the foreground | about 30s, then suspension |
| The reconnect ladder (`shared/transport.ts` `RECONNECT_DELAYS`) | 8 attempts, 31.75s |
| The daemon's idle exit (`daemon.ts` `IDLE_EXIT_MS`) | 60s |
| The session hold this client asks for (`mainview/ios.tsx` `SESSION_HOLD_MS`) | 5 min |
| The most a daemon will grant (`daemon.ts` `HOLD_MAX_MS`) | 10 min |

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
- **The server is gone in a minute unless the client asked it to stay.** Sixty
  seconds of no client and nothing running is the daemon exiting. `running()`
  means a block in flight or a shell inside a foreground command, so an idle
  drawer sitting at a prompt does not count. A client that declared a session
  hold moves that deadline out to what it was granted; the paragraph below is
  the whole of that mechanism, and past the grant the answer is what it always
  was. What is lost then is the PTYs and the scrollback ring; what is not lost
  is the notes, which is the right side of that trade.
- **The writes are already safe.** A reconnect that reaches a *different*
  daemon instance sees a different `Hello.instance` and fails what was in
  flight rather than guessing (remote.md §7). The op log's window is 120
  seconds, so a write retried across a short background trip either lands
  once or is refused, and never applies twice.

  The corollary is the phone's only dead end. A server that restarted is a new
  instance, so the ladder stops for good rather than adopting it: sessions the
  app believes in no longer exist, and nothing below the transport can rebuild
  them. Recovery is choosing the connection again, which on a Mac re-attaches
  and on a phone is the same boot as foregrounding — choosing the server already
  selected is an answer rather than a no-op, and `lib/connections.ts` flushes and
  reloads the page. Without that the connection row is a dead label and the app
  waits to be force-quit, which is what a live server restart actually did
  before this was written down.
- **A phone and a Mac on one server is a fight nobody wins**, until one of them
  concedes. The daemon serves one client and hands the session to whoever
  dialled last (remote.md §1), so each displaces the other; a phone that
  re-dialled a displacement would loop against the Mac forever, several times a
  second, and iOS would be paying for a full ssh handshake and a Secure Enclave
  signature each turn. remote.md §7 is where the concession lives: the server's
  goodbye ends the ladder, so the phone lands on `lost` naming the machine and
  stays there until it is chosen again. Nothing about it is iOS-specific, which
  is why none of it is in `ios/`.

**The idle timeout stays at 60 seconds, and a client asks for longer.** Raising
the constant for phones would leave a process running on someone's Mac for every
client that may never come back. So the ask is the client's and the term is the
server's: a client's hello carries `hold`, the milliseconds it wants its
sessions kept once the connection ends, and a server's hello carries the longest
it will grant. Both ends apply `wire.ts` `sessionHold` to that pair. When the
client goes, the daemon arms its idle timer for what this connection was granted
rather than for `IDLE_EXIT_MS`.

Three parts of that shape are load-bearing:

- **The ask is stated at connect time, not on the way out.** iOS gives about
  thirty seconds of background execution and can give none at all: an app that
  is force-quit, or killed under memory pressure, runs no further line of code.
  An ask made when the connection ends would never be made in the cases that
  most need it.
- **The hellos cross rather than answering each other.** A server sends its own
  the moment the socket opens, before any client has asked, so no grant can
  travel back inside this handshake. Both ends computing the same number from
  the same pair costs no round trip, and neither end has to guess.
- **A hold applies to a session, not to a socket.** The daemon holds only while
  something is open to hold (`server.sessionsOpen()`: a note's inline shell or a
  drawer's, at a prompt or not). A client that asked for a hold and opened no
  shell has nothing to come back to, and gets the ordinary sixty seconds.

What a hold buys is exactly what `running()` is right to ignore: a shell at a
prompt, holding the cwd it was `cd`'d to and whatever the last block exported. A
run in flight was already keeping the daemon alive and still is, hold or no
hold.

**The ceiling is not the ordinary grant.** Five minutes is what a locked screen
and a message answered costs, and a phone is granted it whole; ten is there for
a client that asks for something nobody waits through. A number that always came
back clamped would teach nobody anything on the day it mattered.

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

| Mark | At | Cost | Phase 3 | On a phone |
| ---- | -- | ---- | ------- | ---------- |
| `bridge` | 70ms | loading and parsing the view | 190ms | 57ms |
| `hello` | 72ms | 2ms — who we are, where we point | 7ms | 58ms |
| `socket` | 141ms | 69ms — TCP, key exchange, authentication, exec | 14ms | 530ms |
| `server` | 191ms | 50ms — the protocol handshake | 7ms | 707ms |
| `view` | 200ms | 9ms — the whole boot prefetch | 16ms | 888ms |
| `paint` | 247ms | 47ms — the first composited frame | 109ms | 942ms |

The last column is an iPhone over Wi-Fi to the same fixture on the LAN
(phase 7), and it is the one to read for what shipping feels like. Everything
that is the phone's own work is faster than the Simulator's; everything that
crosses the network is four to ten times slower. `socket` is 472ms because a
real key exchange over Wi-Fi is, and `server` adds 177ms of Bun starting on the
other side. Still under a second to paint, which is the answer §5 needed.

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

Five defects were reported against CM6 on iOS, each needing a re-check before
anything was designed around it. **All five were re-checked on iOS 18.5, in
the shell, against a real server, and none of them reproduces:**

| Reported | On iOS 18.5 |
| --- | --- |
| Selection drag handles missing from the editor | Present at both ends, and dragging one extends the selection |
| The cut/copy callout failing to appear after a double tap | The callout appears over a selection, with Cut, Copy, Paste and AutoFill |
| "Select all" from the callout moving the caret instead of selecting, on large documents | Selects the whole of a 4002-line, 291KB note |
| Autocapitalize misfiring at the start of a line | A letter typed at column 0 stays lowercase |
| Swipe typing inserting a leading space | QuickPath inserts the word at column 0 with nothing before it |

So the risk this section was written around is gone, and the four decisions
below stand on their own merits rather than as workarounds for any of it.

One qualification, because it is the difference between "checked" and
"assumed": the double-tap GESTURE was never synthesized. The Simulator tooling
has no double tap, and two taps arrive more than 300ms apart, which iOS reads
as a caret placement rather than a word selection. What the table records is
that the callout that gesture is supposed to produce does appear, and that
everything reachable from it works. The last two rows needed the real software
keyboard, which the Simulator hides while a hardware keyboard is attached
(testing.md §6 has how to get at it).

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

  Built (`ios/Sources/AccessoryBar.swift`), and two things about it are worth
  knowing. **It carries command ids and no behavior**: a tap sends
  `{t: "verb", id}` over the bridge and the page's registry decides what that
  means, through the same seam the Mac's menu bar has always used
  (`mainview/lib/menu.ts`, `dispatchNativeCommand`). So Swift holds six
  strings, and a renamed command leaves a button that does nothing and says so
  rather than one that quietly does something else. **Indent and outdent were
  not commands before this**: they were Tab and ⇧Tab in CodeMirror's keymap,
  and the iPhone software keyboard has no Tab key, so they were not awkward on
  a phone, they were unreachable. `format.indent`, `format.outdent`,
  `format.wikiLink` and `image.insert` exist now, with no chords of their own,
  and the palette gets them too.

  **The bar knows what it is over, and phase 6 is why.** One content view is
  the first responder for every text field in the page, so the bar phase 5
  installed appeared over the search box, the rename field and the passphrase
  prompt as well — where Bold and Indent are not merely useless but wrong, since
  the command they dispatch acts on the note BEHIND the overlay. The page
  reports focus across the bridge (`@editing`, raised by a `focusin`/`focusout`
  watcher in `ios.tsx`), and the accessory getter answers nil when the answer is
  no. UIKit has to be told to ask again — `reloadInputViews()` — because moving
  between two fields on one page is not a responder change.

  **And it dismisses the keyboard**, which nothing else on the screen does: the
  editor fills the window, so there is no blank page to tap, and tapping the
  chrome does not blur a contenteditable. Without that button the keyboard takes
  a third of the phone for the rest of the session.
- **The web view is constrained to the keyboard, not to the safe area.** This
  is one line of Auto Layout and it was the largest single defect phase 6 found.
  A page pinned to the safe area keeps its full height when the keyboard
  arrives, so WebKit reveals the caret the only way left to it: by scrolling the
  document. On a full-height app that means scrolling the header and the tab
  strip off the top of the screen, and every affordance with them.

  Constrained to `keyboardLayoutGuide.topAnchor` instead (`WebHost.swift`), the
  page is simply shorter while the keyboard is up. The chrome stays where it is,
  dialogs re-centre in what is left, and the editor's own scroller does the
  revealing. Two constraints rather than one, because the guide sits at the
  view's bottom edge when no keyboard is up, which is BELOW the safe area: the
  safe-area one is required and is the floor, the keyboard's is high-priority
  and can lose to it.

  It also fixed something that looked unrelated. **A tap on a search result did
  nothing**, because the layout moved between the touch and the click WebKit
  synthesizes after it, and the click landed on whatever had slid under the
  finger. The desktop suite could never have caught it: it presses Enter.

  The install is the ugly part and is confined to one function. The first
  responder while you type in a web page is not the `WKWebView` but a private
  content view inside its scroll view, so overriding `inputAccessoryView` on a
  WKWebView subclass gets a method UIKit never calls. `installAccessoryView`
  makes a subclass of whatever class that content view actually is — discovered
  from the live object, not named as a symbol — and re-points the instance at
  it. Every step can fail without consequence: a miss logs a line and the app
  keeps the system's own bar, which matters because the alternative failure
  would be a crash on the first keystroke. It runs on every `didFinish`, not
  only the first, because §5 makes foregrounding a reload.
- **Autocorrect, autocapitalize and spellcheck are off on the editor.**
  Markdown is not prose to iOS's dictionary, and an autocorrected fence is a
  broken one. This needed no code: CodeMirror sets `spellcheck="false"`,
  `autocorrect="off"` and `autocapitalize="off"` on its `contentDOM` itself,
  and Ledge adds no `contentAttributes` entry that would override them. The
  decision is pinned by an assertion in `e2e/phone.spec.ts` rather than by an
  implementation, so it fails the day someone adds one — and the two table rows
  above are the evidence that iOS honors all three.
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
| Adding, editing and removing servers | |
| Unlocking a locked note (§10) | |

**Every cut is a boolean, and each one makes a verb ABSENT rather than present
and failing** (`mainview/lib/shell.ts`). They come from different places
because they answer different questions.

`runsCommands` is the SHELL's own answer about itself, set before the first
render (`ios.tsx`), and it withholds the terminal toggle from the chrome and
the palette, the two run verbs from both, the run pair from every fence, the
run chords from CodeMirror's keymap, and the profile editor — which is the
environment a block runs in, so it has nothing to edit for. Nothing is deleted
to achieve it: the daemon on the other end spawns PTYs perfectly well, and the
phase after v1 turns the boolean back on.

`deviceKey` is the shell's too, and it is not a cut at all but a fact about
which key authenticates. A phone adds, edits, removes and switches servers like
any other client (remote.md §8) — `nativeBridge.ts` implements all six methods
over `servers.list`, `servers.save` and `servers.probe`, and every rule about
what may be removed is there rather than in Swift. What differs is the form:
this client has exactly one key, in the Secure Enclave, which cannot be read out
of it and so has no path (§4). So the form asks for no path and shows the
`authorized_keys` line instead, because installing that line on the new server
is the step before any new connection can work. One string rather than a
boolean, because "which key" is the whole of the difference.

Two rules follow from a phone having no local server to fall back to. Removing
the last one is allowed and returns the app to the pairing screen, because
otherwise a phone could never forget an address it typed wrong; and there is no
boot-time fallback to report in `connectionList`, because a phone that cannot
reach its server never renders the dialog at all — it shows `ios.tsx`'s sentence.
Choosing the server already selected stays a real answer rather than a no-op:
that is how a phone reconnects after the ladder gives up (§5).

`softKeyboard` is the shell's third, and the only one that changes an editor
rather than a verb. The read-only documentation editor stays focusable on a Mac
on purpose — find, ⌘C and ⌘↩ on the manual's own runnable blocks all need it —
and a phone has none of those chords while the focus costs half the screen to a
keyboard that can type nothing. So `EditorView.editable` goes off there, and iOS
selects and copies the text natively instead (interactions.md §1a).

`folderDialog` is the SERVER's, and rides back on `workspaceList` at boot. It
is false wherever nobody is sitting at the machine that holds the notes, which
withholds Attach Folder and Move Workspace Folder. That one is not a phone
question at all — a Mac pointed at a VPS gets the same answer, and used to get
`bun/server.ts`'s refusal sentence instead, which is a good sentence to read
and a bad one to discover by running the only verb that looked like it would
help.

The harness can be either shell: `harness.html?shell=ios` is the iOS one, and
`e2e/phone.spec.ts` uses it to hold both halves of the claim — the cut verbs
absent, and every v1 verb still there, because a gate written too wide would
cut the editor along with the terminal.

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
permanently that case, which is why the flag that hides the verb is the
server's rather than the shell's.

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

**One pane at a time, and the rule is a width rather than a device**
(`mainview/lib/viewport.ts`). Below 640 points the sidebar and the right-hand
panel stop taking width and cover the editor instead: a 280-point drawer over
a scrim, dismissed by a tap on what it covers, by Escape, or by picking
something out of it. The editor keeps the full width underneath either way, so
opening and closing a drawer reflows nothing.

Three things follow, and each is a test in `e2e/phone.spec.ts`:

- **The drawer starts shut**, because a phone that booted showing its chrome
  would not be showing the note the last session left focused. Phase 2 shipped
  the desktop arrangement at this size and called it bad: 224 points of
  sidebar, 161 of editor.
- **Two drawers never stack.** Single-PANE is meant literally, so opening one
  closes the other rather than laying a second scrim on the first.
- **640, not 390-440.** The sidebar's floor is 180 points, so the side-by-side
  arrangement stops being usable well before it stops being possible, and a Mac
  window dragged that narrow has the same problem and gets the same answer. It
  also leaves an iPad in portrait (744) on the pane branch, which §7 wants. The
  query is on width alone and deliberately not on `(pointer: coarse)`: a
  touchscreen laptop is a coarse pointer at 1920 points, and covering its editor
  because it can be touched would be the wrong answer to the right question.

What did NOT change is focus. Opening a note from a list row shows it without
taking focus off the row (`workspace/PaneTree.tsx`), and the drawer keeps that
rule rather than making an exception to it — which is also why a tap that
navigates leaves focus nowhere instead of summoning the software keyboard over
the note it just opened.

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
- **Images arrive from the photo picker, not a pasteboard.** Its own client
  method rather than a different `assetPaste`: `assetPick` is that one with a
  picker where the pasteboard was, and the two are identical below the first
  line. The bytes still ride `assetWrite` on a type-1 frame and the server
  still names the file, seals it if the note is locked, and refuses a read-only
  root. remote.md §2's "the client never names a file" is unaffected.

  It is a seam and not just an iOS path because the Mac has an answer to the
  same verb — Insert Image… opens a file dialog there — and because
  `CLIENT_METHODS` is total by construction: a name every shell must implement
  cannot be one only one shell has.

  **PHPicker, which is why there is no permission prompt and no
  `NSPhotoLibraryUsageDescription`.** It runs out of process and hands back
  only what the user chose, so the app never asks for library access and never
  has it — iOS says as much on the picker itself. A usage string would describe
  something this app does not do.

  **JPEG, not PNG, and that was measured.** The first picture ever inserted from
  a phone was 3 MB on the device and 28 MB after a lossless re-encode: ten times
  the bytes over ssh, ten times the disk on the server, and nothing anybody can
  see. The picker sends JPEG at 0.9 and `writePastedImage` reads the magic to
  choose the extension, so the name follows the bytes. A screenshot pasted on a
  Mac is still PNG, because there the source really is one. Re-encoding also
  drops the EXIF, so the GPS a phone stamps on every picture does not travel to
  the server with it.
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

**A device build is that same directory with seven things different**, and
`bun run ios -- --phone` is all seven. The Simulator checks almost none of
them; a phone checks every one, and the shared symptom of getting one wrong is
an install that succeeds and a launch that does not.

| What | Simulator | Device |
| --- | --- | --- |
| SDK and triple | `iphonesimulator`, `arm64-apple-ios17.0-simulator` | `iphoneos`, `arm64-apple-ios17.0`. The suffix selects an ABI, not a name |
| Back-deployment shims | the toolchain's `iphonesimulator` copies | its `iphoneos` copies. A simulator dylib in a device bundle is the same dyld abort by another route |
| Signature | ad hoc | the certificate the profile names |
| Entitlements | `__TEXT,__entitlements` at link time | in the signature, and `--generate-entitlement-der` with them: iOS 15 and later read the DER copy and kill a process whose signature has only the plist |
| Identifier | `dev.ledge.ios`, no team prefix | `<TEAMID>.dev.ledge.ios`, and it is the profile that decides |
| The profile | none | `embedded.mobileprovision` in the bundle root |
| Info.plist | as committed | plus `CFBundleSupportedPlatforms` and the `DT` keys Xcode writes. installd refuses a bundle that does not claim the platform, and says the bundle is invalid rather than which key is missing |
| Install and launch | `simctl` | `devicectl`, whose `--console` is `--console-pty` |

**Everything specific to this Mac is read out of the profile rather than
written down.** The entitlements are generated from what it grants, so there is
no second checked-in plist to disagree with it; the signing identity is its
certificate, matched into the keychain by SHA-1, so a Mac holding several Apple
Development certificates signs with the one this profile will accept. Three
claims go in and deliberately not a fourth: `keychain-access-groups` is absent
because `DeviceKey.swift` never names an access group, so its items land in the
app's default one, which `application-identifier` grants on its own. Claiming
the group as well would put Keychain Sharing on the App ID for nothing.

**The profile itself lives outside the checkout**, at
`~/.config/ledge/ios-dev.mobileprovision` unless `--profile` or
`LEDGE_IOS_PROFILE` says otherwise, on releasing.md §3's rule. It is not a
secret, but it belongs to one Apple team and one phone and it expires in a
year.

**What is one-time and human**, and cannot be automated away because it is an
Apple account rather than a build:

1. An **Apple Development** certificate, minted from Xcode > Settings >
   Accounts > Manage Certificates so that its private key is on this Mac. A
   Developer ID certificate is a macOS one and cannot sign this.
2. The phone's UDID registered, an App ID for `dev.ledge.ios` with **no**
   capabilities, and an iOS App Development profile over the two.
3. **Developer Mode on the phone**, under Settings > Privacy & Security, which
   needs a restart. The entry does not appear until something has tried to
   install, so the first attempt always fails and cannot be prevented.

The script checks what it can before building anything: that the profile
exists, has not expired, is for this bundle id, lists devices at all, names the
phone being installed to, and was issued to a certificate this keychain holds.
Each of those is otherwise an install failure with a number in it.

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
- **A real device, against that same fixture on the network**:
  `bun run probe:ssh -- --serve` publishes it on every interface instead of
  loopback, prints the destination and the host key fingerprint for the pairing
  screen, and appends whatever `authorized_keys` line is pasted into it. A
  Simulator shares this Mac's network stack and can dial `127.0.0.1`; a phone
  cannot, and that is the only reason the fixture has a second mode.
- **What no harness can reach**: WebKit's own tap heuristics. iOS withholds the
  click of a tap whose synthetic hover changed the rendering
  (interactions.md §1a), and that decision lives in WebKit's UI process, not in
  the engine Playwright drives — the harness taps and the click always lands, so
  the two-tap tab bug ran green through every phone spec that existed. The
  Simulator reproduces it exactly, which makes this one of the few things worth
  driving there by hand rather than asserting from a spec. What a spec CAN hold
  is the cause: this project reports `hover: none`, so it can assert that no
  hover style applies and no hover-revealed control exists, which is the
  condition WebKit is reacting to.
- **What no harness and no Simulator can reach**: a finger, a radio, the
  phone's own enclave, and a suspension that really suspends. Those are a live probe with a device
  rather than a Mac. NIOSSH and the lifecycle turned out to be reachable from a
  Simulator on Apple silicon (§4), which is the difference between "unproven"
  and "unprovable" — but the enclave a Simulator reaches is the host Mac's SEP,
  so the trap below stays untested until a phone runs this.

One trap to write down before it is stepped in: **the Simulator's Secure
Enclave is not the device's.** A key-generation path that quietly falls back
to a software key when the enclave is unavailable is a path that ships, and
the symptom is a private key on disk in an app whose entire security story is
that there is not one. The fallback must be visible in the UI or must not
exist.

The lifecycle itself is testable and should be tested by hand every time §5
changes: background the app, wait past 60 seconds, foreground it, and check
that it dials, that the daemon is a new instance, and that a write made just
before backgrounding did not apply twice. Once a phone opens shells, the same
walk with one open should find the SAME instance inside the session hold and a
new one past it.

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
   `dist-ios/` over a scheme of its own (§12), a bridge of fifteen strings (§2),
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
5. **Done. The screen, and the editor.** The single-pane tree §9 describes: a
   breakpoint in `mainview/lib/viewport.ts`, drawers instead of panes below it,
   and seven tests in `e2e/phone.spec.ts` that hold the arrangement. The
   accessory bar is `ios/Sources/AccessoryBar.swift` and three new registry
   commands (§7). Autocorrect turned out to need no code at all.

   **The unknown this phase was placed last to isolate was not there.** §7's
   five reported CM6 defects were the reason for the ordering, and re-checking
   them on iOS 18.5 found that none of the five reproduces — the table in §7 is
   the audit. The work that remained was the layout, which was known, and the
   bar, which was awkward for a reason nobody had written down: the first
   responder inside a WKWebView is a private content view, so an
   `inputAccessoryView` has to be installed on a class discovered at run time.

   Two things the phone said that the harness could not. **Indent and outdent
   had no commands**, only Tab and ⇧Tab in the editor's keymap — invisible as a
   gap until the software keyboard turned out to have no Tab key, at which
   point they were not chords a phone lacked but verbs it could not reach at
   all. And a **291KB note that opened blank** turned out to be neither the
   editor nor the phone: `bun/daemon.ts` was discarding the count `Socket.write`
   returns, so everything past the kernel's send buffer was dropped mid-frame.
   Every client before this one drained fast enough never to fill it; a client
   that crosses every frame as base64 through `evaluateJavaScript` does not.
   remote.md §3 has the fix.

   Not done here, and now the only thing between this and §8's v1 list: a real
   device. Everything above is still a Simulator.
6. **Done. The rest of v1.** Search, tags, backlinks, the outline, daily notes,
   images through PHPicker, and unlocking, every one of them exercised by a
   finger against a real server. Six of the seven already existed; what did not
   exist was any proof they could be REACHED that way, and the desktop suite
   could not supply it because it drives all of them from a chord. Ten specs in
   `e2e/phone.spec.ts` tap instead.

   **The largest defect was the keyboard, and it was not in any of the seven.**
   The web view was pinned to the safe area, so raising the keyboard scrolled
   the whole document to keep the caret visible and took the header and the tab
   strip off the top of the screen with it. §7 has the one line that fixes it
   and the second defect it turned out to be causing: a tap on a search result
   did nothing, because the layout moved between the touch and the click.
   Two more of the same shape — the accessory bar appearing over the search box
   and the passphrase prompt, and nothing on the screen able to put the keyboard
   away — were phase 5's, invisible until phase 6 put a second text field on the
   screen.

   **§8's cut became two booleans** (`mainview/lib/shell.ts`), because a v1 that
   shows a terminal button has not cut the terminal. One is the shell's own and
   one is the server's, and the second fixes the Mac's remote case at the same
   time.

   The one genuinely new build is the picture picker (§11), and the number worth
   keeping is the one it cost to learn: a camera photo re-encoded as a lossless
   PNG is 28 MB where the JPEG is 1.7.

   Not done here, and still the only thing between this and a shippable v1: a
   real device. Everything above is a Simulator against a container.
7. **In flight. A real device.** The three phases above each end with the same
   sentence, and this is that sentence. `bun run ios -- --phone` builds, signs
   and installs for hardware (§12); `bun run probe:ssh -- --serve` puts the
   fixture somewhere a phone can dial (§13).

   The build is proven and so is what runs on it. `vtool` reads `IOS` rather
   than `IOSSIMULATOR`, the signature is an Apple Development identity carrying
   the team, the entitlements in it are the three the profile grants and no
   more, and the profile is in the bundle. On the phone: `[pair] key in the
   Secure Enclave` with `ecdsa-sha2-nistp256`, which clears §13's trap about a
   software key that quietly ships; the fixture accepts that algorithm; and the
   dial works over both a tailnet and the LAN. The install itself has one
   unavoidable failure in front of it — the first one onto a phone that has
   never had a development build fails on Developer Mode, and the Settings entry
   for it does not appear until that failure has happened, so it cannot be
   turned on in advance.

   **iOS's Local Network prompt is indistinguishable from a routing failure,
   and it is not a release blocker.** A dial to a LAN address before the
   permission is granted returns `EHOSTUNREACH` — the same errno as no route at
   all — and the prompt fires on that first local-subnet connection, by which
   time the dial that triggered it has already failed. Granting it and dialing
   again is the whole fix; nothing in the app needs to change. It is written
   down because "could not reach" with a prompt behind it reads exactly like
   "could not reach" without one, and retrying is what nobody thinks to do.

   **What the device found that no harness could**: switching notes cost two
   taps. WebKit withholds the click of any tap whose synthetic hover changed the
   rendering, and the tab strip's close ✕ fades in on `group-hover`
   (interactions.md §1a). The manual raised a keyboard over a document nothing
   can type into, and had no way out but the strip inside the drawer it was
   covering. And the connection dialog offered to add a server on the one client
   that cannot. All four are §13's "what no harness can reach" in practice —
   though the first is reproducible in the Simulator, which is where it was
   caught in the act.

   What still waits on a hand: §5's lifecycle across a suspension that really
   suspends, the accessory bar under a finger rather than under Playwright's
   pointer events, and the geometry of a 14 Pro Max against a keyboard fix built
   on a 16.

Live command execution is not in this list. It is the phase after v1, and the
first thing §5 said it had to answer is built: a client asks for its sessions to
be held and the server sets the term (`Hello.hold`, `HOLD_MAX_MS`). It holds
nothing for a phone yet, because §8's cut means a phone opens no shells to hold.

What the phase still has to answer is the rest of that cut. A run's output is a
push keyed by its id with no attach beside it, so a foreground reload leaves an
inline run going on the server that the new page cannot see and cannot
`cancelRun`, because it never learned the id — dismissing a panel is what sends
that today, and a reload is not a dismissal. A software keyboard has no Ctrl, no
Escape, no Tab and no arrows, and the accessory bar carries seven Markdown verbs
over `.cm-content` only (§7). The hatches interactions.md §6a gives for taking
the keyboard back from a running block are ⌘Escape and a double Escape, neither
of which exists on a phone. And the host picker and the run confirmation
(interactions.md §4a, §4b) are dialogs built around a keyboard grammar, on the
one surface where being wrong runs a command on the wrong machine.
