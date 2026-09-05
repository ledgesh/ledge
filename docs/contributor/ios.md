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

**Swift owns the socket, the keys, and the client-only RPC methods.
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

**The bridge is eighteen strings, and it is written down twice.**
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

| `sshDial` | Enforced on the Mac by | On iOS |
| --------- | ---------------------- | ------ |
| `command="ledge-server serve"` | the server's sshd | the server's sshd, unchanged |
| `StrictHostKeyChecking=yes` | OpenSSH | the app's host-key delegate |
| `UserKnownHostsFile` | OpenSSH | the app's own store |
| `GlobalKnownHostsFile=/dev/null` | OpenSSH | nothing to exclude |
| `BatchMode=yes` | OpenSSH | no prompt exists to suppress |
| `SSH_ASKPASS` and the password door | OpenSSH, from the keychain | `PasswordAuth`, from the keychain |
| `PreferredAuthentications=password,keyboard-interactive` | OpenSSH | only the first of the two exists here |
| no `-t` | OpenSSH | no pty is requested |

**The second-to-last row is a real gap and not a translation.** NIOSSH offers
`password` and public keys and has no keyboard-interactive at all, so a server
configured to answer with that alone refuses this client while the same account
works from a Mac, which names both methods because askpass serves both
(remote.md §4). Nothing in `ios/` can close it without implementing the method
against NIOSSH's user-auth delegate. It reaches the user as "refused that
password", with the second half of that sentence saying the server may not allow
one at all: from here the two are indistinguishable.

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

**A keepalive is not one of those blocks; it is not there at all.** NIOSSH sends
nothing periodically and exposes no way to make it:
`sendTCPForwardingRequest` is the only global request on the handler, and the
generic `sendGlobalRequestMessage` beside it is internal. There is no
`ServerAliveInterval` to configure, so `SSHTransport.swift` asks TCP instead,
with four socket options on the connection. `TCP_KEEPALIVE`, `TCP_KEEPINTVL` and
`TCP_KEEPCNT` cover a wire with nothing in flight; `TCP_RXT_CONNDROPTIME` covers
one with an unacknowledged write, because TCP probes only an idle connection and
lets the retransmit timer decide otherwise. Both paths land on the twenty seconds
remote.md §7 measures on the Mac, and `SO_KEEPALIVE` on its own — which is what
this asked for before — is the first of them at Darwin's default idle time of two
hours.

**What that buys on its own is not what the Mac gets, and the difference is a hop
that terminates TCP.** A keepalive proves the nearest TCP PEER is alive.
`ServerAliveInterval` proves the SERVER answered, because the reply has to come
from sshd. Anything in between that ends one TCP connection and begins another —
a published Docker port, a bastion forwarding a port, a load balancer — answers
the probes out of its own kernel, and the client learns nothing about the machine
behind it. The deployments remote.md §4 and `docs/user/` describe have no such
hop: the machine's own sshd answers, and the Docker one reaches into the
container with `docker exec` rather than publishing a port. The probe fixture is
the exception, which is why a cut wire there proves nothing about a phone (§13).

**What closes that gap is above ssh rather than under it.** The protocol carries
its own heartbeat now (remote.md §7): the client sends a `ping` after five
seconds of quiet and the daemon answers `pong`, three unanswered probes end the
connection, and all of that is in `shared/transport.ts` — which is to say it
runs in the webview and reached this client by being written once. A pong comes
from the process holding the notes, so no proxy, bastion or load balancer can
send one on the server's behalf, and neither can a healthy sshd in front of a
daemon that has stopped answering.

The four socket options stay, and the reason is §5. A suspended app runs no
timers, so its heartbeat does not beat; the kernel's keepalives do not care
whether anything is scheduled. The two mechanisms cover the two halves of a
phone's life, which is why this client has both and the Mac has ssh's as well.

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

**A password is the other door here too, and it is where the two clients'
keychains genuinely differ.** `ServerPassword` stores one item per server with
`SecItem` and no access group, so it belongs to this app alone and no other app
on the phone can ask for it. A Mac's item is reached through `/usr/bin/security`
and is readable by anything running as that user (remote.md §4), which is the
price of keeping the item's ACL off a code signature that changes when the app
is re-signed. iOS has no such problem: the owner is the application identifier
and that does not move.

`WhenUnlockedThisDeviceOnly` like the key, for the key's reasons. It is read at
dial time and held for the length of the handshake, so a stored password is not
sitting in the process between connections, and it is passed INTO `SSHTransport`
rather than looked up there: the pairing screen dials a record that does not
exist yet and so has no id to look one up by.

The list is the page's and the keychain is Swift's, which leaves a way for the
two to disagree. `ServerStore.save` sweeps every item whose record has gone,
rather than deleting one by id at each call site: a record can leave that list by
being removed, by failing to decode, or by an install being restored over
another, and only the survivors are knowable from here.

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

**Pairing is a line the user copies or shares, and the copy alone is the part
of v1 that did not survive contact.** The app shows its public key and the
whole `authorized_keys` line, forced command included, exactly as remote.md §4a
writes it. Getting that line onto the server is the user's problem, which is
the same problem the Mac client has and the same one
`docs/user/18-notes-on-another-machine.md` documents — except that it is not
the same difficulty. On a Mac the line is copied between two windows on one
screen; on a phone a pasteboard ends at the phone, and the machine the line has
to be pasted on is the one that is not in the user's hand.

**So the line leaves by the device's share sheet.** `Natives.share` is a
`UIActivityViewController` over one string: AirDrop to the Mac, a message, a
note to self, whatever that device has. Both forms offer it beside Copy line —
the native pairing screen directly, and the connection dialog across
`share.text`, the bridge's eighteenth string (§2) — because both show the same
line and the second one is reached from a phone too. It is the answer to
"emailed to yourself to finish the job somewhere else", which was the honest
description of what this screen used to ask for.

**What the step says was rewritten with it.** It opens on what the line IS,
this device's public key and why that server needs it, and puts the `restrict`
prefix second, as ports and files rather than as "cannot open a shell". The old
sentence explained the hardening option before naming the thing it is an option
on, and its last clause read as a guarantee remote.md §4a is explicit about not
making.

The answer is that it stops being the only door. remote.md §4 takes a password
or a key like every other ssh client, and on a phone that is three fields and
no other device. That is what phone ssh clients have always offered, and it
makes this screen's copy step optional rather than load-bearing. The enclave
key stays, because a key that cannot be exported is worth more than a stored
password and the phone is the one client that has to generate its own (§4). It
is the hardening a user accepts once they are already working, and the line
below is how they install it.

**The native screens are for the state where there is no page.** A phone with
no server has no web view to render the connection dialog in, and neither does a
phone whose saved server has stopped answering: the dialog is React, and React
is what a failed boot never reaches. Two screens cover it.
`ServerListViewController` lists the stored servers, marks the one that will be
dialled, and carries a row that adds another; `PairingViewController` is that
form. The form is the ROOT of the stack rather than a step off the list when
there are no servers at all, so a first launch is one screen and has no Back
button pointing at an empty list.

They are reached on a first launch, after a host key changes under a record that
still exists, after the last server is removed, and from a button on the page's
own refusal (`servers.choose`, `mainview/ios.tsx`). **The last of those is the
case a single pairing screen missed.** A phone could only manage its servers
from a connection it had already made, so an address that stopped answering — a
server moved, turned off, or behind a network the phone is no longer on — left
one control on the screen, and it was a retry that would fail the same way for
as long as anyone pressed it. Deleting the app was the way out, which takes the
enclave key with it.

**The native side selects and adds; it does not rename, edit or remove.**
Selecting is what Swift already does at every launch, and adding is the pairing
form, which is here anyway. The rest are rules — may this be removed, does this
address need pinning again — and a rule written twice in two languages has two
answers. A phone that can reach any server at all can reach the dialog that
holds them, so every server after the first is still added from the connection
dialog like a Mac's (remote.md §8): the same list, the same fingerprint step.
The key line the pairing screen hands over is the same line that dialog's form
shows, carried across on `@hello` because it is a fact about the device rather
than about any connection to one.

The same call carries what this phone calls itself, which every other client on
the server it dials is pushed (remote.md §7): it is what a Mac's notice says when
the phone takes its terminal drawer. `UIDevice.current.name` answers it, and
since iOS 16 that is the MODEL name — "iPhone" — for an app without the
user-assigned-device-name entitlement. That is the right answer to ship: the
sentence it has to make is "iPhone took this shell", which needs a device and not
a person. An app that later earns the entitlement gets the user's own name for it
with no other change. A Simulator answers with its own name instead
(`as "iPhone 16"` in the `[shell]` line at launch, which is where a probe reads
it, since what it names is only ever visible on somebody else's screen).

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
out of the selection — an address to dial and a key to pin — and the whole of the
bridge's half is the list itself (`servers.list`, `servers.save`), the keychain
item that cannot travel in it (`servers.password`), the fingerprint a form needs
before it can pin one (`servers.probe`), and the way back to the native screens
(`servers.choose`). The alternative, a verb per operation, would have put "may
this be removed" in Swift beside the Mac's copy of the same rule in TypeScript.

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

  The reload takes every inline run panel with it, which is a problem the
  drawer does not have — it re-attaches and replays its ring, while a run is
  only a push keyed by an id the old page owned. So the boot claims the runs it
  can still show and the server interrupts the rest (remote.md §7,
  `inlineClaim`). The hold below is untouched by that: what a hold keeps is the
  shell, and a run in flight was never the thing it was for.
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

  What used to follow from that was the phone's only dead end: a restarted
  server is a new instance, so the ladder refused it, and recovery meant a
  person choosing the connection again. The refusal is gone (remote.md §7). What
  is still failed is what was in flight under an op, which is the op log's rule
  and the whole of it; the CONNECTION is adopted, and the two announcements it
  arrives as (`lost`, then `live`) are what drive the reconnect mechanisms the
  view already has — buffers settled, runs reconciled, shells re-claimed, vault
  re-read. Sessions the app believed in do not come back, because they do not
  exist; a phone learns that from `terminalClaim` and `inlineClaim` answering
  the way they answer for a shell that ended, which is a sentence on screen
  rather than a dead connection row.

  Foregrounding still reloads (§5 below), and that is unchanged and still the
  simpler answer on a phone: the shell closes the socket on the way out, so the
  wire is never live on the way back in. What the adoption fixes is the app that
  was NOT foregrounded — one running with the wire dropping under it — and it
  fixes the Mac, which has no foregrounding at all.
- **A phone and a Mac on one server used to be a fight nobody wins.** The daemon
  served one client and handed the session to whoever dialled last, so each
  displaced the other; a phone that re-dialled a displacement looped against the
  Mac forever, several times a second, and iOS paid for a full ssh handshake and
  a Secure Enclave signature each turn. The daemon now holds both (remote.md §1),
  so the fight has no participants. What outlived it is the rule that ended it,
  and the phone still meets that rule elsewhere: a server's goodbye stops the
  ladder (remote.md §7), which is the answer to a server shutting down or
  refusing the handshake. The phone lands on `lost` naming the machine and stays
  there until it is chosen again, rather than climbing a ladder against an answer
  it already has. Nothing about any of it is iOS-specific, which is why none of
  it is in `ios/`.

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
  (interactions.md §2), the `[[` that opens the wikilink picker, and the ```
  that opens a code block. It is a native `inputAccessoryView` rather than
  HTML, because HTML that tries to sit above the keyboard is fighting the
  visual viewport for the whole life of the app.

  Built (`ios/Sources/AccessoryBar.swift`), and two things about it are worth
  knowing. **It carries command ids and no behavior**: a tap sends
  `{t: "verb", id}` over the bridge and the page's registry decides what that
  means, through the same seam the Mac's menu bar has always used
  (`mainview/lib/menu.ts`, `dispatchNativeCommand`). So Swift holds eight
  strings, and a renamed command leaves a button that does nothing and says so
  rather than one that quietly does something else. **Indent and outdent were
  not commands before this**: they were Tab and ⇧Tab in CodeMirror's keymap,
  and the iPhone software keyboard has no Tab key, so they were not awkward on
  a phone, they were unreachable. `format.indent`, `format.outdent`,
  `format.wikiLink`, `format.codeBlock` and `image.insert` exist now, with no
  chords of their own, and the palette gets them too. The last one to arrive is
  the sharpest case of the same argument: the backtick is not on the letter
  page, so ``` is three trips through the numeric page with a long press each —
  and `format.codeBlock` writes `sh` with it, because the ▶ comes from the info
  string's first word and a bare fence is the one block that cannot run
  (`mainview/editor/fences.ts`).

  **The bar knows what it is over, and phase 6 is why.** One content view is
  the first responder for every text field in the page, so the bar phase 5
  installed appeared over the search box, the rename field and the passphrase
  prompt as well — where Bold and Indent are not merely useless but wrong, since
  the command they dispatch acts on the note BEHIND the overlay. The page
  reports focus across the bridge (`@focus`, raised by a `focusin`/`focusout`
  watcher in `ios.tsx`). UIKit has to be told to ask again —
  `reloadInputViews()` — because moving between two fields on one page is not a
  responder change.

  Phase 6 answered that with no bar at all, and that was half an answer. A
  keyboard with no way to dismiss it is a trap on this client specifically: the
  page is full height, so there is no blank space to tap, and its chrome does
  not blur a field. So `none` is a FACE and not an absence — one button, Hide
  Keyboard, and no verbs (`AccessoryBar.bare`). The rule the three faces encode
  is that the note's verbs need the note, and putting the keyboard away never
  needs anything.

  **And the bar has a second face, because a running block wants a different
  keyboard.** A software keyboard has no Ctrl, no Escape and no arrows, so a
  phone could answer a run by typing (a password, a `[y/N]`, a pager's `q`) and
  had no key at all for the program that wanted any of those — the gap phase 7
  opened with. While a run holds the keyboard the strip carries `^C ^D esc ↑ ↓ ←
  →`, and **Back to note** where Hide Keyboard sits on the other face: the same
  act as the run panel's own button, on the bar because the panel's header rides
  the note's scroller and a run pinned to 24 rows can put it off the top of the
  screen.

  Three things hold this together. The report is a FACE and not a boolean
  (`BarFace`: `none`, `note`, `run`), because a run's panel is a CodeMirror block
  widget and therefore inside `.cm-content` — asking "is this the editor?" first
  is what put Bold over a password prompt, one layer below where phase 6 found
  it (`barFaceOf`, ordered run-first, proved in `e2e/phone.spec.ts`). A key tap
  sends `{t: "key", k}` and not a verb, because these are not commands: the
  registry would have to find the focused panel, and the palette entry it would
  earn is a row that takes away the focus it was meant for. And **Swift never
  learns what a key sends** — `mainview/editor/inlineTerm.ts` turns the name into
  bytes against the live terminal's cursor-key mode, which is the same division
  the verb face has and the reason neither side holds a second opinion.

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

  **The provider hangs off the view, not off the class**, and this cost a
  session to find. A class pair can be registered once under a name and never
  again, so a closure baked into the getter answers for the first web view the
  process ever built — and there is a second whenever pairing swaps the root
  controller out, which a changed host key or an emptied server list does. It
  fails silently rather than loudly: the old `WebHost` is kept alive by the
  message handler its own web view retains, so the getter goes on reading a
  `face` that nothing updates, and the WHOLE bar is missing until the app is
  killed. An associated object on the content view, set on every install, is
  the fix; the symptom to recognise is a phone whose keyboard has no strip
  above it at all after a re-pair.
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

## 8. What a phone does, and what it cuts

**A phone reads, edits, creates, searches and navigates notes, and runs their
blocks inline. It has no terminal drawer.**

| On a phone | Not on a phone |
| ---------- | -------------- |
| The note list, quick open, full-text search | The terminal drawer |
| Tags, backlinks, the outline | Attaching a workspace folder |
| Editing, with live preview | Moving a workspace |
| Daily notes, templates, wikilinks | |
| Rendered images, and adding them from the photo library | |
| Running a block inline, with the host picker and the confirmation | |
| Editing the note's profile, which is what a run's environment is | |
| The trash | |
| Workspace and connection switching | |
| Adding, editing and removing servers | |
| Unlocking a locked note (§10) | |

v1 shipped with the whole right-hand column one row longer: running was cut too,
and the phase after it put running back (§14). What follows is how a cut is
made, which is the same machinery either way.

**Every cut is a boolean, and each one makes a verb ABSENT rather than present
and failing** (`mainview/lib/shell.ts`). They come from different places
because they answer different questions.

`runsBlocks` and `hasTerminal` are the SHELL's own answers about itself, both
set before the first render (`ios.tsx`), and a phone says true to the first and
false to the second. `runsBlocks` withholds Run Block Inline from the palette
and CodeMirror's keymap, the ▶ from every runnable fence, and the profile editor
— which is the environment a block runs in, so it has nothing to edit for.
`hasTerminal` withholds the toggle from the chrome and the palette, Close
Terminal, and Run Block in Terminal, which is the one verb that needs both
answers because it takes a block out of the note and puts it in the drawer.
Restart Note Shell needs either: both surfaces spawn the shells it kills.

**Two booleans rather than one, because the cut lifted in two steps and stopped
between them.** A phone runs blocks and has no drawer, and that is not a
transitional state to be tolerated but where a phone stays: inline output is a
panel under the fence, and a drawer is a second arrangement, a second focus
domain, and a keyboard grammar (Ctrl-`` ` ``, Escape) a phone cannot type. One
boolean could not describe that client without either offering it a drawer it
does not have or withholding the runs it does.

Nothing was deleted to achieve any of it, which is what made the second step one
line: the daemon on the other end spawns PTYs perfectly well, and turning
`runsBlocks` back on is the whole of what running on a phone took, once the
touch column of the surfaces it lights was built (§6, interactions.md §1a).

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

`shareSheet` rides beside it and is the same fact one step along: the line has
to reach a machine that is not this one, and a phone's pasteboard cannot carry
it there. A callback rather than a boolean, because the only client with a sheet
reaches it across the bridge and nothing else in the view can; a client that
says nothing has none, so the button is absent on a Mac rather than present and
failing.

`softKeyboard` is the last of the shell's own, and the only one that changes an editor
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

The harness can be either shell. `harness.html?shell=ios` is a phone's, and
`e2e/phone.spec.ts` uses it to hold both halves of the claim — the cut verbs
absent, and every verb a phone does have still there, because a gate written too
wide would cut the editor along with the terminal. It holds the middle
configuration in one place too: the ▶ on a fence with no terminal button beside
it, Run Block Inline in the palette without Run Block in Terminal, and the
drawer gone from the chrome. Anything else is the desktop, which keeps every
verb. There was a second phone shell, `?shell=ios-runs`, for as long as the
client was a step behind the view; it is gone, because the two now describe the
same client.

**A run outlives the app being backgrounded.** A block that is running holds the
daemon open through `running()`, so the run itself survives, and its output is
still in the ring when the app comes back, as long as the phone returns before
the next idle check finds nothing running. That grace is anything from zero to
sixty seconds after the run ends, depending on where it fell in the window
relative to the last check. A run also survives the page it was started from: a
foregrounded reload claims the panels it can still show and the server ends the
rest (`inlineClaim`, remote.md §7). What does not survive is an idle drawer,
which is one of the reasons a phone has none.

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
- **`menuSet` is a no-op, and `windowNew` answers no.** There is no menu bar,
  and a phone shows one app at a time, so a window and a client are the same
  thing here in a way they stopped being on the Mac (remote.md §8a). Both are
  already client-only methods the server refuses, so this costs nothing but two
  stubs. `windowNew` returning false is what keeps New Window out of the
  palette rather than in it and silent.
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
`Info.plist`, compiles the icon, copies the view in beside it, and hands the
result to `simctl`.
A project file would be a second, generated description of facts that are
already legible — unreadable in a diff and unverifiable except by opening
Xcode. Phase 3 got away with a bare `swiftc` over a glob; phase 4 has a
dependency to resolve, which is the one thing a glob cannot do, and SwiftPM is
the smaller of the two answers to that.

Five things that build has to do that Xcode would have done quietly. The first
four announced themselves as launch failures with no obvious cause; the fifth
announces itself as nothing at all:

| What | Why |
| ---- | --- |
| `-sdk` and `-target` pushed through `-Xswiftc`, `-Xcc` and the link | SwiftPM builds for its host and has no iOS destination. The last `-target` wins, which is why the output lands in a directory named for macOS and is an iOS Simulator binary |
| The back-deployment shims copied into `Frameworks/` | A binary built with this toolchain and deployed to iOS 17 links a compatibility dylib for every standard-library type the runtime there lacks. Missing, it is a dyld abort at launch. The list is read out of the binary, because it belongs to the toolchain |
| An ad hoc signature | The keychain answers `errSecMissingEntitlement` to a process with no application identity, and the device key is a keychain item (§4) |
| Entitlements as a Mach-O section, not in the signature | The Simulator's rule, and not the device's. A signature carrying them is refused at launch with a POSIX 153 |
| The icon catalog compiled with `actool` | `assets/Ledge.icon` is a source and iOS reads a compiled `Assets.car`. Missing, there is nothing to go wrong: the app installs, launches and works, and sits on the home screen as the grey placeholder, because an icon iOS cannot find is not an error to it |

**A device build is that same directory with eight things different**, and
`bun run ios -- --phone` is all eight. The Simulator checks almost none of
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
| The icon catalog | `actool --platform iphonesimulator` | `iphoneos`. The weakest row here: the two catalogs differ in their bytes, but a device one rendered on the Simulator when it was tried, so this is matched because it is the correct input and not because a mismatch is known to cost anything |
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

One trap about the fixture rather than the Simulator: **the probe's cut wire is
behind a hop that terminates TCP.** `scripts/probe-ssh.ts` publishes the
container's port 22, and on Docker Desktop the client's connection therefore ends
at a proxy process on this Mac. Cutting the container's egress — `[drop]`, and
`--serve`'s `cut` — severs the inner connection and leaves the outer one
perfectly healthy, so that proxy goes on acknowledging the phone's keepalive
probes and the phone notices nothing. The Mac client is unaffected, because ssh's
ServerAlive needs an answer from sshd and no proxy can forge one. It is the same
asymmetry §3 describes, arriving as a test that cannot be written rather than as
a bug.

**`--serve`'s `stall` is the way around it, and it is a better instrument than
the cut.** It sends SIGSTOP to the daemon in the container and leaves everything
else running: TCP is established, Docker's proxy is healthy, sshd answers its
own keepalives, and `ledge-server serve` goes on pumping bytes into a socket
whose reader is not scheduled. Every mechanism under the protocol therefore
reports a working connection, correctly. The phone's bar reaches "reconnecting"
in about twenty seconds anyway, because the heartbeat's pong has to come from
the stopped process and cannot (§3). `resume` sends SIGCONT and the ladder
climbs back. The assertion run does the same thing to itself in `[stall]`, so
the Mac's version of this claim is not a manual one.

What the cut does still prove on a phone is the other half: the daemon keeps
running, the shells keep printing, and the requests made during the gap are held
rather than failed. What proves the DETECTION is a black hole with nothing in the
middle to answer, and the cheapest one is taking this Mac off the network while
the phone holds a connection to it. A Simulator has no equivalent: its server is
on loopback, and loopback cannot be black-holed without a packet filter and a
password.

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
   `dist-ios/` over a scheme of its own (§12), a bridge of its own (§2),
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
   suspends, both faces of the accessory bar under a finger rather than under
   Playwright's pointer events — including whether eight buttons and a fixed
   44-point one are comfortable at 393 points, and whether a run started by a
   tap brings the keyboard up at all, since a phone shows one for a
   programmatic focus only inside a gesture — the geometry of a 14 Pro Max
   against a keyboard fix built on a 16, and whether the fence's run button
   survives WebKit's first-tap rule.
   That last one is the tab strip's defect again, one layer down: `.ledge-btn`'s
   hover style is hand-written CSS rather than a Tailwind utility, so
   `hoverOnlyWhenSupported` never gated it, and Playwright's touch emulation is
   not the ContentChangeObserver. It taps fine in the harness, which is exactly
   what the ✕ did.

   And one more, which is a device's for a different reason: **the twenty
   seconds §3's keepalive OPTIONS are supposed to take.** The protocol's
   heartbeat is provable in a Simulator and is proved there, with `--serve`'s
   `stall` (§13). The socket options are not, and they are the half that covers
   a suspended app: the options are the Mac's numbers and Darwin stores them,
   but the only black hole a Simulator can be pointed at is behind a published
   Docker port that answers the probes itself. A phone holding a connection to
   `--serve` while this Mac leaves the network is the one setup with nothing in
   the middle. A radio has the real version of it anyway: a tunnel, a lift, a
   dead zone.

Live command execution is the phase after v1, and it is in the client now:
`ios.tsx` says `runsBlocks: true`. The two things §5 said it had to answer first
were built before it. A client asks for its sessions to be held and the server
sets the term (`Hello.hold`, `HOLD_MAX_MS`), which is what a backgrounded phone
comes back to. And a run's output being a push keyed by its id, with no attach
beside it, no longer leaves a foreground reload with a run the new page can
neither see nor `cancelRun` — dismissing a panel is what sends that, and a
reload is not a dismissal, so the boot claims what it can still show instead and
the server ends the rest (`inlineClaim`, remote.md §7).

**The cut it lifts is inline runs and not the drawer**, which is why §8's
`runsCommands` is now `runsBlocks` and `hasTerminal`: the ▶ without the terminal
button beside it, Run Block Inline without Run Block in Terminal, and Restart
Note Shell back, which a phone was offered nothing to restart throughout v1.
The specs held all of it before there was a phone behind it, against a second
harness shell — `?shell=ios-runs` — which existed for exactly as long as the
client was a step behind the view. Flipping the boolean retired it: `?shell=ios`
is that client, and one shell cannot drift from the thing it stands in for.

**The two questions asked before a command runs are answered.** The host picker
and the run confirmation (interactions.md §4a, §4b) were built around a
keyboard: ⌘↩ then Enter repeats the last machine, an arrow leaves it, Escape
backs out of either. A finger keeps the ordering and loses the whole economy —
every row is one tap, so the preselection is no longer the cheap answer, and the
focus ring is holding a fact that nothing else on the screen states. So the
preferred machine is now marked as well as focused, and the controls a finger
chooses BETWEEN grow to 44 points: the picker's two rows, and the
confirmation's Cancel beside the button that runs the block. Seven specs drive
both by tap at 390x844.

Writing them is what established that a finger can open either one, which was
the assumption worth testing rather than restating: the fence's ▶ was
`opacity: 0` until the block was hovered or held the caret, and a phone has only
the second, so asking for a run there cost a tap in the block and then a tap on
the button. Fixed below. The size rule found the other thing no reading would
have: every rem in this app is 0.875 of its name — the document's root is
`font: 14px` — so `min-h-11`, the utility that spells 44, renders 38.5. A tap
target is a physical measurement and is written in pixels.

**A running block can be left without a chord.** interactions.md §6a handed the
keyboard to a run when it first spoke, so a `sudo` prompt is answered by
typing, and took it back on ⌘Escape or a double Escape — a phone has neither,
and its one inherited exit, tapping the prose, is exactly what a full-screen
program removes by pinning the panel to 24 rows. The panel's header now carries
the exit as a **Back to note** button on touch, in place of the line of text
that names those keys, and grows to 48 points to hold a 44-point one. (The
claim itself came off this client later in the phase, below; the exit did not,
because a tap can still put the keyboard in the panel.)

Two things came out of building it. The panel did not fit the screen at all: an
xterm opens at 80 columns, the editor scrolls sideways to its widest thing, and
the re-fit then measured the overflow it had caused and kept it — 605 points
inside a 370-point editor, with the run's own header off the right edge, and
invisible on a Mac where 605 fits inside 1005. It opens at 2 columns now and
grows into whatever it is given (interactions.md §1a). The second is that the
overlay's copy and ✕ were centred by arithmetic against a header height that was
a constant. The header is now handed to them as their own height and flexbox
centres them in it, which is what lets the header — and the buttons — be two
sizes without a number in `editor/blocks.ts` knowing either.

**And the fence's own controls are a finger's now.** They were a hover-revealed
group of 22-point buttons, which on a phone meant a tap in the block to light
the ▶ and a second one to use it, with Copy a pixel away from both. They are lit
without being asked and 44 points on touch, and so are the panel's Copy Output
and ✕ (interactions.md §1a). Three things had to give for that. The card grows a
lane at its top rather than the group growing over the first line of the code it
runs: 22 more points of top padding and the same 22 of lift, kept together in
`index.css` while `editor/blocks.ts` goes on anchoring the group to the opening
fence. The reserved width the run panel's header holds for the overlay pair had
to stop being able to shrink — flex took it back and drew the ✕ over the Back to
note button. And "typing here" is gone on touch: the button is the disclosure
there, and the width it costs is what the pair needs (§6a).

A fourth thing came off the device, and it is the lane's own consequence. The
group draws a bordered, filled box around itself, which at 22 points is what
separates two small glyphs from the code they float OVER; around 44-point
buttons in a lane of their own it is a 50-point empty panel with a speck in it,
and it floats over nothing. It is transparent on touch rather than removed,
because its 2px padding and 1px border are what put the glyph column 13px inside
the card, where `editor/blocks.ts` puts the output panel's pair to line up.

The profile chip is the one control in that layer that went the other way:
absent, `display: none`, because Edit Note Profile… is note-scoped and its
palette entry needs nothing pointed at first — which is not true of the ▶, and
is the whole of why one is lit and the other is gone.

`.ledge-btn:hover` moved behind `@media (hover: hover)` in the same pass. It is
hand-written CSS, so Tailwind's `hoverOnlyWhenSupported` never covered it, and
it is the tab strip's first-tap defect one layer down: a hover background is a
rendering change, and WebKit withholds the click behind the synthetic mousemove
that caused one. The headless project cannot see that, and only a device can
settle it (phase 7).

**The keyboard a RUNNING block needs is a different keyboard, and the bar wears
it as a second face.** A software keyboard has no Ctrl, no Escape and no arrows,
so a phone could answer a `sudo` password, a `[y/N]` or a pager's `q` by typing
and had no key at all for the program that wanted one of the others — the ✕ was
the whole of the way out of a full-screen program, and it kills the run rather
than answering it. Over a run the strip is now `^C ^D esc ↑ ↓ ← →` with **Back
to note** where Hide Keyboard sits, which is §7's list of what a phone could not
say, made pressable.

Building it turned up the defect underneath: the bar was already appearing over
a running block, wearing the note's verbs. The `@editing` boolean phase 6 added
asks whether `.cm-content` has focus, and a run's panel is a block widget INSIDE
`.cm-content` — so Bold was on offer over a password prompt, one layer below
where phase 6 found the same thing at the search box. The report is a face now
(`none`, `note`, `run`) and the classifier asks the run first, which is the
whole of the fix and is what `e2e/phone.spec.ts` pins.

Two decisions are worth keeping. There is **no sticky Ctrl**, which is how a
terminal app on iOS usually reaches Ctrl-anything: an armed modifier is state
the page holds and a native button has to draw, and the two would part company
the first time a run ended while it was held — so the two control keys anyone
actually presses are keys of their own and the rest stay unreachable. And **an
arrow is not one byte**: `ESC [ A` outside DECCKM, `ESC O A` inside it, which is
the mode vim, less and every ncurses program set while they own the screen, so
the bytes are chosen against the live terminal's mode rather than assumed
(`inlineTerm.runKeyBytes`).

The same pass answered the other thing a finger could not do, one surface over:
`format.codeBlock`, because ``` is three trips through the numeric page with a
long press each (§7). The drawer is on neither list and is not waiting for
anything: a phone stays without one (§8).

Both were driven end to end in the Simulator against the Docker fixture
(testing.md §6), which is where the two faces exist at all: one tap on the code
button wrote a `sh` block with its closer and a lit ▶, and running `echo ready;
cat` swapped the strip to the run's face by itself. `^C` on it ended the `cat`
on the Linux server — the panel said `Interrupted` and the terminal echoed the
`^C` — and the strip went back to the Markdown face with the focus. **Back to
note** on the bar moved the focus without touching the run, which stayed
`Running`. Eight buttons and the fixed one fit 393 points with room to spare.
What the Simulator cannot show is the geometry under a real software keyboard
(it docks the bar at the bottom while a hardware keyboard is attached, which is
also iOS's own behavior), so the comfort of eight is still phase 7's to settle.

**Running a block trapped the phone behind its own keyboard, and two separate
defects had to line up for it.** The report was a screenshot: a finished run, a
software keyboard over half the note, and no strip above it to put the keyboard
away. Each half is worth keeping.

The bar was missing entirely, on every face, and the cause is one line of
`installAccessoryView`. A runtime class pair can be registered once under a
name, so the branch that reuses an existing one re-points the content view at a
class whose `inputAccessoryView` still calls the FIRST closure ever installed —
which reads a `face` belonging to a `WebHost` that pairing replaced. It cannot
even fail loudly: the old host is kept alive by the message handler its own web
view retains, so the getter answers `none` forever instead of nil. Any re-pair
(a changed host key, an emptied server list) cost the whole bar until the app
was killed. The provider is an associated object on the content view now, set
on every install.

And `none` stopped meaning "no bar". Phase 6 chose nil so the note's verbs
would not sit over a search box, which was right about the verbs and wrong
about the strip: this page is full height, so there is nothing to tap that
would dismiss a keyboard, and its chrome does not blur a field. The third face
is one button — Hide Keyboard, no verbs — and it is what makes "the keyboard
can always be put away" true rather than usually true.

The keyboard should not have been up at all, which is the second defect and the
older one. A run claims the keyboard when it first prints if the editor still
has focus and the caret has not moved (interactions.md §6a). On a Mac that
tests whether the user is typing there; on a phone it tests almost nothing,
because the editor takes DOM focus when a pane opens (`workspace/PaneTree.tsx`)
and takes it back after every run ends (`inlineTerm.freeze`), both with no
keyboard up. So the claim was always live, and honoring it focused a text
field, which is how iOS is asked to RAISE the keyboard — over the output the
finger had just asked to see. `startInlineRun` does not claim on a client whose
keyboard is on screen; the panel takes the keyboard when it is tapped, and
offers `Tap to type` while it is live and has not been, since with no claim
nothing else announces a program waiting on an answer.

That invitation is a button, and only after it shipped as a line of text was it
obvious why it had to be: an instruction beside a terminal is aimed at, not just
read. The words say to tap, so the thumb goes to the words. Tapping the output
still works and is the path most people take; both go through one `focusTerm`,
which is the honored claim's path as well.

Verified in the Simulator against the same fixture: a run started by tapping ▶
leaves the focus where it was and the panel invites a tap, and a tap on the
terminal moves the focus into it and swaps the strip to the run's face.

**The size rule had been applied to the four controls someone had looked at.**
Fixing the ▶ and the run panel left the rest of the chrome where phase 2 found
it, and the next report was the obvious one: everything else is small too. What
answered it was a measurement rather than another reading — a script that boots
the harness at 390x844, walks it through the states a phone can reach, and asks
the DOM for the box of every interactive element in each. It found a 38-point
header of seven 25-point buttons, 26-point note rows in the one drawer that
reaches another note, 27-point tabs with no gap between them, a 21-point
machine switcher, a 13-point Trash disclosure, a 28-point workspace icon grid
three points apart, and a connection row whose third adjacent target removes a
server. None of that is subtle, and none of it was going to be noticed by
reading a diff.

The sizes now live on `MenuItem` and on the shadcn `Button` variants rather
than at the call sites, which is what covers the dialog nobody has written yet:
every dialog's action pair is `size="sm"`, so Cancel beside Save was the same
28 points in six files. Two things came out of it worth keeping. The tab strip
at `h-[44px]` gives its tabs 43, because `items-stretch` fills the content box
and the bottom border is inside the border box — the same point the run panel's
header paid for at 48. And the pane controls took §1a's other answer: three
21-point buttons half a point apart, `touch:hidden`, because a split at 390
points is two 195-point editors and all three verbs are pane-scoped entries in
the palette. The measurement is a spec now (`e2e/phone.spec.ts`), and it names
no control — a list of remembered selectors is exactly what produced the list of
four.

Two of those three. Close Pane came back, because hiding it was hiding an exit
rather than an offer: a phone still splits from the palette and from a tab's
menu, and with the ✕ gone it reached a two-pane layout whose only way out was
knowing to type `>close pane`. The ✕ is 44 on touch and `canClosePane` keeps it
off the strip until a second pane exists, so the arrangement a phone actually
lives in pays nothing for it, and Close Pane now sits beside the two splits in
the tab menu. The sweep would never have caught this: it measures the controls a
state puts on screen, and the bug was a control that was not there.

Asking what else had been shut in the same way turned up one more, and this one
predates the touch column entirely. The find panel is the app's only chrome that
Tailwind does not style: `editor/find.ts` builds it as DOM and `editor/setup.ts`
sizes it in the JS style object it hands to `EditorView.theme`, so no `touch:`
rule has ever reached it and it stayed a 26-point row at every width. At 390 that
row measures 508. The × that closes it ended 118 points past the right edge of
`.cm-panels`, which does not scroll sideways, and the panel's other exit is
Escape. So Find and Find and Replace, both in this client's palette, opened a
panel it could not close. The theme has an `@media (hover: none)` block of its
own now: the field sits between the chevron and the ×, the six option buttons
are on the row under it, and everything is 44. Neither the sweep nor the audit
that produced it had opened this panel, which is the general lesson —
`e2e/phone.spec.ts` measures the states someone thought to walk, and a state
nobody walks is not a state nobody can reach.

It took two goes, and the second one is the reusable part. The first left the
two rows to flex: the widths added up to a break in the right place at 390
points, and a screenshot from a 430-point phone came back with the × stranded
between the field and the arrows, the checkboxes orphaned on the row below, and
the find field starved to its 160-point basis while the replace field under it
ran to 245. A wrap point is a sum, so it moves with the screen. The break is an
element now — the options are one box at `flex-basis: 100%`, ordered after the ×
— which gives the same arrangement at every width and lets the field take the
row's remainder (274 at 390, 314 at 430). The panel's specs run at both widths
for that reason. The same screenshot showed the chevron wearing a hover
background: these rules are outside Tailwind, so `hoverOnlyWhenSupported` never
gated them, and iOS's synthetic mousemove had painted one. They are behind
`@media (hover: hover)` now, which is §1a's two-tap rule and not a cosmetic one.

Gating them turned out to be half a change. Four of these controls carried no
border on purpose — the chevron, the ×, and the three checkbox pills — because a
pointer finds a control's edges by moving across it and the hover was the box.
With the hover gated, nothing draws them, and the second row read as three
buttons with three specks beside them. All six take a border at rest on touch,
which is the general form: before gating a hover, ask whether it was hiding a
control or drawing one. The other thing a phone cannot ask for is a title, and
two buttons here said "All" — one selects every match, one rewrites every match.
The one that changes the note is "Replace All" now, on every client.

The next one the audit had walked past is the overlay, and it is the same shape
of miss one layer up: the surface was reachable and half of what it does was
not. The magnifier opens quick-open, and crossing from there to the command
palette or to full-text search meant typing `>` or `#` — both of which are on
the iPhone keyboard's THIRD plane (`123`, then `#+=`), so each crossing cost two
plane switches to reach one character and a third tap to get back to letters. A
sweep cannot see that: the control is 44 points and the tap lands: what is
expensive is the KEY, which is not a thing on the page at all. The audit had
walked the overlay and typed into it with a hardware keyboard, so the cost never
showed up. Punctuation on a software keyboard is a chord, and §1a's rule about
chords already covered it — nobody had noticed it applied.

The fix is three chips under the field, one per mode, and it is worth naming
what it bought a Mac. The mode had been invisible state (`Overlay.tsx` derived
it from the query and rendered nothing), so a lit chip is the first thing that
says which of three lists is on screen — including when a SIGIL is what put you
there. And crossing now carries the typed query, because retyping is what costs
where the keyboard is on screen. The last piece is the one that needs nothing
learned at all: a title search that matches nothing now ends in *Search “…” in
note text* rather than in "No notes match", which is the crossing offered at the
moment the want appears. The sigils and the chords are untouched; the chips
simply stop being the only ones who know about them, and they drop the sigil
they name where `softKeyboard()` says the character is not a keystroke.
