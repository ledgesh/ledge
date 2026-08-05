# Ledge remote servers

**Implemented: §14 phases 1 to 5 are code. Phase 6, the iOS client, is
designed in `docs/contributor/ios.md`, whose own phases 1 to 4 have landed —
there is a Swift app, and it reaches a server over ssh, under §4's forced
command, with a key that never leaves a Secure Enclave.** The
connection grammar §8 called for now lives in `interactions.md` §4-1, the
state ownership §5 describes is the code's, and the resilience §7
promises is real: the server is a process behind a unix socket, a dropped wire
reconnects and replays, and terminal output rides binary frames. The server
runs on Linux and ships as an image, and `bun run probe:ssh` connects to one
over a real sshd with the §4 forced command enforcing itself.
This is a sibling standard beside `architecture.md` (whose process topology,
trust boundary, and state-ownership rules it revises), `interactions.md`,
`locking.md` (whose vault moves one hop away), and `testing.md` (whose
categories §13 instantiates). Code that disagrees with it is either ahead of
the doc or wrong.

It records two amendments to `architecture.md`, both in §5: `.window.json`
has left the server for the client, and pasted asset bytes now cross the wire
(§3's "the bytes never cross the RPC" held only for a local server). Both are
done, and `bun/server.ts` has no `osascript` call site left.

## 1. What a server is

A **Ledge server** is a headless process that owns a machine's notes and runs
its commands. It is `src/bun/` with the Electrobun import removed and a
transport added. One machine, one server, one set of notes: its workspace
registry, its `settings.jsonc`, its profiles, its vault, its interpreters,
its shells.

A **client** is the React app in `src/mainview/`, wrapped in whatever shell
the platform needs. It owns what the user sees and no machine state at all.

The relationship is the one `architecture.md` §1 already describes, with the
process boundary allowed to be a network:

| Case | Transport |
| ---- | --------- |
| Mac app, local notes | the server in this process |
| Mac app, remote notes | `ssh <target> ledge-server serve` |
| iOS app, your Mac | `ssh <target> ledge-server serve` |
| iOS app, your VPS | `ssh <target> ledge-server serve` |
| `serve` to the machine's own daemon | a unix socket in the app home |

The Mac app connecting to its own local server is not a special case. It is
the same client, the same protocol, and the same server binary, over a
cheaper transport. Keeping it that way is what stops the remote path from
becoming a second, less-tested code path.

**A server is a daemon behind a unix socket, and `serve` is a pump to it.**
`ledge-server serve` — what a client runs and what a forced command names (§4)
— connects to `.server.sock` in the app home, starting `ledge-server daemon` if
nothing answers, and then moves bytes between stdio and that socket. It parses
no frames, so an ssh session cannot desynchronize one.

That indirection is what makes §7 true rather than aspirational. Before it, an
ssh WAS the server: the wire dropping took the shells with it, which is exactly
the case §7 was written for. Now a run keeps going, the scrollback ring keeps
filling, and the op log that makes a replay safe is still there when the client
comes back.

Two rules fall out of it, and both are the honest version of something that
would otherwise be vague:

- **Several clients at once, held in a map keyed by client id.** A Mac and a
  phone pointed at one machine is the ordinary shape of this, and the daemon
  used to answer it by serving whoever dialled last and hanging up on the other.
  What actually needed a rule was much smaller than that: `attached` and the
  ring are per SESSION rather than per client, so the one thing two clients
  cannot share is a drawer's keyboard (§7, and it is `bun/server.ts`'s `Term`
  that owns it). Notes, search, tags, the registry and the vault never needed
  one.
- **A later connection from the SAME client replaces the earlier one.** That is
  all that is left of displacing, and it is the job displacing was doing
  underneath: what a reconnect reconnects past is a half-open wire nobody has
  noticed is dead. The replaced connection is told why and STOPS; §7 is where
  that half lives, and it is what keeps a policy from becoming a fight.
- **A connection registers on the hello, not on the socket.** A socket that has
  not said who it is is not a client yet. The distinction is load-bearing
  because probing whether a daemon is behind a socket file is a connect and an
  immediate hangup (`clearStaleSocket`), and on the accept that probe would
  count as somebody using the server — and, now, would be handed a set of
  handlers with no client to answer as.
- **An idle daemon exits after a minute**, unless something is running. A
  process per machine, started by an ssh nobody remembers making, is not a
  feature; a build that survives you closing the laptop is. `.server.pid` sits
  beside the socket so the answer to "how do I stop it" is a command and not a
  hunt.

**Both ends of that socket write through `socketWriter`** (`bun/transport.ts`),
and the reason is a bug that took an iOS client to find. Bun's `Socket.write`
writes what fits in the kernel's send buffer and RETURNS how much that was;
both sites here discarded the number, so every byte past the buffer was
dropped. Silently, and mid-frame: the reader was left waiting on a length
prefix whose bytes were never coming, and every response and push queued behind
it waited there too. A note stops loading, then the note list stops updating,
and the connection still looks live because it is.

The buffer is small and its size is the platform's — about 8KB for a unix
socket on macOS, about 208KB on Linux — so the size at which a note vanished
was a property of the machine the server ran on. Nothing caught it because a
reader that drains as fast as the writer fills never sees a short write, and
every client before iOS was that fast. `socketWriter` holds the remainder and
flushes it on the socket's `drain`. Its tests are the fast half (a fake socket
with a fixed buffer, including the ordering rule that a second write must not
overtake the first's remainder), because the real thing needs a reader slow
enough to provoke it — see testing.md §6.

**The Mac app's own local server stays in this process.** It is the one case
where the socket buys nothing: the same user, the same disk, and a quit that
takes the window with it anyway. Making it a child would put a second binary in
the app bundle and §11's upgrade question in front of every launch, which is
shipping work and belongs with phase 5.

**The desktop app is therefore split, not extended.** `bun/index.ts` becomes
two entry points: `serve` (RPC handlers, sessions, watcher, no UI) and the
Mac shell (menus, window, `Screen`, `Updater`, tray). Nothing in
`src/mainview/` changes. Nothing else in `src/bun/` imports Electrobun today,
which is what makes the split a move rather than a rewrite.

## 2. The client is the least-trusted end

`architecture.md` §2 says the view is the least-trusted end of the RPC. That
rule generalizes and gets stronger: **the client is the least-trusted end,
and every guard stays server-side.**

The reasons multiply in the remote case. A remote client runs on a different
machine, on a version the server did not ship, over a connection anyone with
the key can open. `assertNote`, `assertTrashed`, `assertRegisteredRoot`,
`assertWritableRoot`, `isProfileName`, `isHostName`, and `slugOf` all keep
their current homes and their current jobs.

Three rules follow, and each is a thing a remote transport tempts you to
break:

- **No guard moves client-side for latency.** A client-side pre-check to
  save a round trip is a cache, never an authority. The server re-validates
  whatever arrives.
- **Paths stay opaque handles.** The client holds only paths the server
  handed it and passes them back unmodified. This was already the rule; over
  a network it is also the reason a stale path from another server cannot
  address a file.
- **The client never names a file.** It sends a note's text and the server
  slugs the H1. A remote client gains no naming power a local one lacked.

## 3. The transport is SSH, and the protocol rides stdin and stdout

A server speaks the `rpc-schema.ts` protocol over stdin and stdout. Remote
clients reach it as `ssh <target> ledge-server serve`.

The server opens no port. That removes TLS configuration, certificate
rotation, a listening ingress, and an authentication system of Ledge's own,
and it inherits the properties of the most-audited daemon on the machine.
It is also what makes §4's capability restriction possible: an
`authorized_keys` forced command can only force a command.

That sentence is `src/bun/ports.test.ts`, and it sweeps the whole repository:
every `Bun.listen` anywhere in it is a unix socket, and `Bun.serve` and the
network builtins appear nowhere at all. It was narrower while an iOS client
without ssh needed something to talk to (`ios.md` §14 phase 3); that fixture
lost its only caller when the phone got a real transport, and deleting it made
the wider claim available. The one port a developer's machine opens is Vite's,
which `playwright.config.ts` asks for by name.

Reachability is the user's existing problem and Ledge does not solve it
again. A tailnet, a LAN, a jump host, or `~/.ssh/config` all work because
none of them are Ledge's business. This is the same stance `remoteSpawn.ts`
already takes for `host:` shells: Ledge is ssh's client, never its
replacement.

**Framing.** A 4-byte big-endian length, a 1-byte type, then the payload.
Type 0 is a JSON control frame (requests, responses, and the schema's push
messages). Type 1 is a binary payload tagged with the id of the control
frame it belongs to. Assets and terminal output ride type 1: base64 was free
in-process and costs 33% on a cell connection.

A binary frame is sent IMMEDIATELY BEFORE the control frame that claims it,
and a receiver holds at most one. Ordering on a stream is guaranteed, so that
rule turns "which payload is this" into "the one that just arrived": no
correlation table, and no partial state a peer can grow by sending bytes it
never claims. Two in a row, bytes nothing claims, and a claim on bytes that
never came are all fatal, for the same reason a bad length is.

Which fields ride it is a table in `shared/wire.ts` (`BINARY_FIELDS`), not a
rule per call site. The SCHEMA still says base64 everywhere and the view still
receives base64, because Electrobun's bridge is JSON either way — so this is an
optimization for the hop with a network in it and a no-op for the one without.

The codec is `shared/wire.ts`. The two ends of a connection are
`shared/transport.ts` for the client and `bun/transport.ts` for the server,
split along the line between what a webview can run and what it cannot
(`ios.md` §2); the symmetry is across the pair, not inside one file. A server
dispatches `req` frames into the handler map `createServer` returned, and a
client presents the answers as that same map, so `bun/index.ts` binds either
one to the webview's RPC without knowing which it got.

**Multiplexing is required, not optional.** The schema is already
bidirectional: `terminalOutput`, `runEvent`, `terminalExit`, `notesChanged`,
`vaultChanged`, and `openExternal` are server-initiated. Frames carry a
request id and are interleaved freely; nothing in the protocol is
request-response ordered.

**Terminal output coalesces, on Nagle's shape rather than a fixed delay.** The
drain loop pushes whatever a shell produced every 8ms, which is free in-process
and 125 frames a second down a wire. So the first chunk after a quiet moment
goes out at once — an echoed keystroke is never delayed — and only a shell that
is producing CONTINUOUSLY is batched, at one frame per 30ms or per 128 KB.

It lives in the transport, not in the server: the cost it exists to avoid is a
wire's, and the in-process case should not pay a millisecond for a problem it
does not have. Anything else the server sends flushes what is held first, which
is not a nicety — `terminalAttach`'s answer IS the scrollback up to that
instant, and output held back from before it would be painted on top of a
snapshot that already contains it. The ring (§7) remains the authority for
anything a client missed.

## 4. Authentication is ssh keys, and the notes key is not a shell

Auth is the user's ssh keys. Ledge holds no credentials, stores no
passwords, and runs no account system.

**A client gets two keys, and the second one is opt-in.** The notes key is
restricted to the protocol:

```
restrict,command="ledge-server serve" ssh-ed25519 AAAA... ledge@laptop
```

That key cannot open a shell, forward a port, or run `scp`. It can speak the
protocol and nothing else. A user who wants a client to also run arbitrary
commands beyond the notes protocol adds a second, unrestricted key as a
separate act. Most clients never need one: fences run through the protocol,
which the forced command already permits.

Restricting the key moves the security boundary onto the server's frame
parser, which is then the only new attack surface in the design. It stays
small: fixed frames, no dynamic paths, and the §2 guards behind it.

**The host key is pinned at pairing.** A client records the server's host key
when the connection is first configured and refuses a changed one with the
fingerprint shown. There is no blind accept and no "continue anyway" that
remembers.

The enforcement is ssh's own, which is the point of being ssh's client rather
than its replacement (§3). Pairing runs `ssh-keyscan`, describes the key with
`ssh-keygen -lf`, and stores the `known_hosts` line only after a person has
compared the fingerprint; every connection then runs with
`StrictHostKeyChecking=yes`, `GlobalKnownHostsFile=/dev/null`, and Ledge's own
`known_hosts` followed by the user's. Ledge parses no key material and computes
no hash of its own. The user's file is included because their entry for a host
IS a pin, and demanding they re-pin what they already trust is how you teach
someone to click through pinning; what Ledge pinned stays in a file of its own
so it can be read and revoked separately, and it is a projection of the
connection records, so removing a connection removes its pin in the same
breath.

**That last claim is about a client that spawns OpenSSH, and it does not
generalize.** A client with no subprocesses has to link an SSH library and
compare the offered host key itself, which is what `ios.md` §3 does and what
makes it the only end of this design with new cryptographic surface. The
forced command is unaffected either way: it is enforced by the server's sshd,
which does not care what dialled it.

`BatchMode=yes` belongs to the same list, for a different reason: this ssh has
no terminal, its stdout IS the protocol, and a passphrase prompt would either
hang the connection forever or write a question mark into a frame header. So
would a pty — there is no `-t`, because newline translation on a
length-prefixed protocol corrupts rather than breaks.

**Enabling Remote Login exposes sshd to everything that can reach the
machine.** For a VPS that is the public internet, on a box whose purpose is
to execute code from notes. The documented posture is binding sshd to the
tailnet interface, not `0.0.0.0`, and it belongs in `docs/user/` rather than
in a footnote.

## 5. State ownership: server or client

`architecture.md` §5 splits state three ways by lifetime. The boundary now
splits again, by machine:

| State | Owner | Notes |
| ----- | ----- | ----- |
| Notes, assets, `.ledge-trash` | server | unchanged |
| Workspace registry (`.workspaces.json`) | server | the trust artifact for that machine |
| Vault and locked notes (`.vault.json`) | server | §9 |
| Profiles (`~/.config/ledge/profiles/`) | server | never transmitted, §10 |
| PTYs, sessions, scrollback | server | §7, and they outlive a connection |
| How long they outlive it | server, on the client's ask | §7, `Hello.hold` |
| Which inline runs are still worth executing | server, on each client's claim for its own | §7, `inlineClaim` |
| Which client a drawer's bytes go to | server | §7, `Term.attached` |
| The dedupe window for replayed writes | server | §7, spans reconnects |
| The watcher | server | pushes `notesChanged` as today |
| Behavior settings (shell, interpreters, trash TTL, daily workspace) | server | facts about that machine |
| Appearance settings (theme, font sizes, `editor.livePreview`) | **client** | facts about that screen |
| Window frame (`window.json`) | **client** | amends `architecture.md` §6 |
| Clipboard, rich paste, pasted image bytes, link opening | **client** | §10 |
| Whether the connection is up | **client** | §7, `CLIENT_PUSHES` |
| Pane and tab layout (`.layout.json`) | server, keyed by client | see below |

**Settings split along the machine boundary.** `settings.jsonc` stays one
file on the server and keeps the knobs that describe that machine. The
appearance subset moves to a client-local file, because a phone's font size
is not a VPS's font size and following the Mac's dark mode is not a fact the
server can know. `shared/settings.ts` keeps one shape with two homes; the
migration reads the existing single file and splits it on first launch.

**Layout is stored server-side and keyed by a client id.** The client mints
an id once and keeps it (`bun/clientHome.ts`, in the client home beside the
connections). A phone must not inherit a three-pane desktop layout, and
reconnecting from the same Mac must not lose one. Keying on the client
satisfies both without a second storage location. The ownership line moves by
exactly one step: `bun/layout.ts` now owns the MAP (which client, and the
atomic write) and `workspace/persist.ts` still owns each value's shape.

**The id rides the handshake, not the call.** Identity is a property of the
connection: a client cannot forget to send it, no handler needs a parameter it
would only ever fill one way, and the view never learns it is one of several
possible screens. That is what `Hello.client` is for. The handshake carries the
server's identity too — `Hello.instance`, which names the RUN rather than the
machine, and which §7 uses to decide whether a replay is safe. The protocol
version is 3.

**The client home is `.client` inside the app home**, not a second top-level
directory: on every machine Ledge ships to, the client and its local server are
the same user on the same disk, so one `~/.ledge` to back up beats two. It
holds the id, the connection list, Ledge's own `known_hosts`, the client's
`settings.jsonc`, and `window.json`. Deriving it from `APP_HOME` also means
`LEDGE_NOTES_ROOT` moves the client's files too, which is what lets a scratch
probe run without touching the real ones.

**Pasted asset bytes now cross the wire, amending `architecture.md` §3.**
`assetPaste` used to read the pasteboard Bun-side and return only the markdown
reference. A remote server has no pasteboard. So the client reads its own and
calls `assetWrite`, whose bytes ride a type-1 frame, and the server writes,
seals, and names the file. What the client still does not do is name it:
`uniqueName`, the read-only-root refusal, and the `.ledge-assets` guard stay
server-side, and whether the paste is sealed is read off the NOTE rather than
taken from the sender. The amendment costs one byte path and no authority.

The pasteboard's own temp file moved with it, from the workspace's assets
folder to the client home. It is transient plaintext for a paste into a locked
note either way, unlinked immediately: the caveat `locking.md` §5 already
documents, now one directory over.

## 6. Servers and execution hosts are different things

Two things in Ledge are now called a host, and conflating them is a
correctness bug rather than a naming annoyance.

- **The server** is where a note's file lives and where its shells spawn by
  default. There is one per connection.
- **The execution host** is `host:` frontmatter: an ssh destination a note's
  blocks may run on (`shared/frontmatter.ts`, `bun/remoteSpawn.ts`). There
  may be several per note, and the picker interposes on every run when there
  is more than one (`interactions.md` §4a).

They compose without changing either. A note stored on a VPS can carry
`host: prod-db`, and **the server makes that outbound ssh connection, not the
client.** The client holds one restricted key to one server; it never holds
credentials for a production machine, and `~/.ssh/config` on the server is
what resolves the destination.

`LOCAL_HOST` keeps its spelling and gains a precise meaning: local to the
server. A block with no `host:` runs on the machine holding the note, which
is the behavior a user already expects and the only one that stays true when
the note moves.

## 7. Sessions outlive connections

Shells belong to the server and survive a client going away. This is already
how `bun/index.ts` works: each session keeps a 256 KB rolling scrollback,
`attached` names which client that output is pushed to, and `terminalAttach`
replays the buffer. Nothing about that design needed changing; what it needed was a server
that outlives a connection, which is §1's socket.

Three consequences to hold onto:

- **A dropped connection does not kill a run.** The PTY keeps running, the
  ring keeps filling, and the next `terminalAttach` replays what was missed.
  A client that reconnects to a finished run sees its output.
- **`docId` stays the session key** (`architecture.md` §4) and stays stable
  across reconnects. A client that reconnects with the same client id
  re-attaches its sessions rather than spawning new ones.
- **The ring is the only buffer.** Output older than 256 KB is gone, on
  reconnect exactly as it is on pane switch. A client that needs more asks
  for a longer ring, not for a replay log.

**Inline runs have no attach, so a client reconciles them instead.** All three
bullets above are the drawer's: it has a ring and `terminalAttach` to replay it.
An inline run has neither. It is a `runEvent` push keyed by a run id, and the
only thing that knows that id is the panel the page is drawing. A page that
reloaded knows none of them, which leaves the run executing with nothing on
screen able to show it, no id anywhere able to stop it, and `running()` keeping
the daemon alive underneath. So the client sends `inlineClaim` at boot and after
every reconnect, naming the runs it can still show, and the server interrupts
the ones it did not name — the same interrupt dismissing a panel sends, so the
note's shell keeps the cwd and the exports the block left it.

**A claim reaches only the runs that client started.** The pool files each run
under the client that asked for it (`bun/inlinePool.ts`), and `inlineClaim`
answers within that scope. An unclaimed run is an orphan only to the client
that started it: another client cannot show it, cannot stop it, and was never
told it existed, so saying nothing about it is the whole of what that client
has to say. Unscoped, a phone finishing its boot interrupts the build a Mac is
watching, and the only trace is a line in the server's log. What the scope does
not do is collect a run whose client never comes back — no boot arrives to ask
— and it is the idle exit that ends that one, which already waits on
`running()`. A run id is therefore unique per PAGE and not per run counter
(`mainview/editor/blocks.ts`), since the pool keys shells by it and two clients
that collided would drive each other's.

The answer settles the other direction. A push with nowhere to go is dropped
rather than queued, so the `ended` event for a run that finished while the wire
was down is simply gone, and its panel would sit on Running for good with that
block's run button disabled behind it. `inlineClaim` replies with the claimed
runs the server is actually executing, and the client closes the rest out with
no exit status, which is exactly what it knows.

The cost is worth stating plainly: coming back to a server collects what you
left running on it. Leaving kills nothing — switching to another connection
leaves that machine's runs alone, and a wire that merely dropped reconnects into
panels that are still there — but the boot that returns finds them unshowable
and ends them. What the alternative preserves is a run nobody can watch, stop,
or read, which is not a kept run.

**Every push is addressed** (`Audience` in `bun/server.ts`). With more than one
client, "send this" stopped being a complete instruction, and the answers are
not uniform because the messages are not alike: what a note list needs everyone
to know, a run event needs exactly one client to know. The daemon does the
fanning out and decides nothing; `bun/server.ts` names the audience at each push
site, because who is a fact about a session or a run and it is the only thing
holding those.

| Push | Goes to | Why |
| ---- | ------- | --- |
| `notesChanged` | everyone | a file that moved moved for every client |
| `vaultChanged` | everyone | the vault is the server's, so unlocking on the Mac unlocks the phone's locked notes too |
| `openExternal` | everyone | `ledge <title>` names a note rather than a screen (§8) |
| `terminalBusy` | everyone | a fact about the note's shell, and it grays out a button on any client with that note open |
| `terminalOutput`, `terminalExit` | the client attached to that drawer | one stream, one reader |
| `runEvent` | the client that started the run | keyed by a run id that only that page's panel holds |
| `menuCommand` | nobody | it is the Mac shell's own AppKit menu (`bun/index.ts`), never a server's |

A push addressed to a client that is not connected is dropped, exactly as every
push was while nobody was attached at all, and the state it described is re-read
at that client's next boot.

**The drawer is the one thing two clients cannot share.** `Term.attached` holds
one client id and the bytes follow it, so today the last to attach takes it.
That is deliberately half an answer: the client it was taken from is not told,
and is not stopped from typing into a shell it can no longer see. The other half
is an owner with watchers, a push that says the drawer was taken, and a button
that does the taking.

**A client that loses the wire re-dials rather than failing.** The ladder is
250ms doubling to 8s and then holding there, eight attempts and 31.75 seconds
in total, and that number is not arbitrary: it has to finish inside the
daemon's idle timeout, or giving up would mean reconnecting to a process that
had already decided nobody was coming. The margin is the smaller half of a
minute, so lengthening the ladder is a change to `IDLE_EXIT_MS` as well.

Both numbers assume a client the operating system leaves running. One that
gets suspended, as iOS suspends an app that leaves the foreground, is a
different case: its timers do not fire, so it re-dials on waking rather than
climbing a ladder, and the daemon it left behind is gone unless it asked for
it to stay (the session hold below). `ios.md` §5 carries that case, and its
answer is that a client says what it needs and notes are never at stake either
way. Requests made while it climbs are HELD, not failed. When it runs
out, the state is `lost`, what was held is refused with the last reason, and
nothing new is accepted — an app that keeps taking requests for a server it
cannot reach looks like it is working. Recovery from there is choosing the
connection again (`interactions.md` §4-1), which rebuilds everything from boot.
That recovery has to work on a connection the manager still considers active,
which is why a wire giving up is reported to `connectionManager.ts`: choosing
the server already being served is otherwise a deliberate no-op.

**A client can ask for its sessions to be kept, and the server sets the term.**
The handshake carries two numbers under one name (`wire.ts` `Hello.hold`): from
a client, how long it wants its sessions after this connection ends; from a
server, the longest it will grant. Both ends apply `sessionHold` to the pair,
because the two hellos cross rather than answering each other, so no grant can
travel back inside the handshake that asked. When the last client goes, the
daemon arms its idle timer for the furthest deadline any departed connection was
granted, or `IDLE_EXIT_MS` if that is further out.

Three rules make it a policy rather than a lever:

- **A hold is a deadline set when its own connection ends, not a duration read
  off whoever leaves last.** With several clients those are two different
  moments: a phone backgrounds while a Mac stays connected, and the Mac quits a
  minute later. Read off the Mac, the phone's five minutes would be sixty
  seconds for no better reason than the order they quit in.
- **A hold over nothing is no hold.** It applies only while a session is open
  to hold (`sessionsOpen()`: a note's inline shell or a drawer's, at a prompt or
  not). Keeping a process for a client that opened no shell is the "started by
  an ssh nobody remembers making" that the idle timer exists to end.
- **A hold is a deadline, not an exemption.** `running()` still overrides both,
  and a hold that expires exits exactly as the sixty seconds would have.

The client that needs this is a phone: iOS suspends an app shortly after it
leaves the foreground and can kill it outright, so the ask has to be on file
before the connection ends by any means (`ios.md` §5, and `HOLD_MAX_MS` for the
ceiling and why it is where it is).

**The ladder does not start over unless the connection lasted.** A ladder that
resets on every success is not bounded, because a connection that dies the
moment it is made buys a fresh one each time: eight attempts becomes eight
attempts forever, at an ssh handshake and a process on the server per turn. So
a connection has to hold for ten seconds to earn a new ladder, and one that does
not resumes the old one where it left off and reaches the end. Ten seconds is
well below any link a person would call working and well above a flap, which
was measured at three a second.

**A server that says goodbye is not dialled again.** A wire that broke cannot
say anything, so a reason means the server decided: this client replaced its own
connection with a later one (§1), it is shutting down, or it refused the
handshake. The
ladder is for the wire, and running it against a decision is an argument with
a server that has already answered. The state goes straight to `lost` in the
server's own words. The difference is carried on the connection
(`farewell()`) rather than by matching on the wording of an error, for the same
reason `ConnectionLost` is a type.

The measurement that produced this rule was two clients on one daemon, back when
the server handed the session to whoever dialled last: each displaced the other,
and since both re-dialled, neither ever stopped. That particular fight went with
the rule that caused it (§1) — two devices are two clients now — but the shape
did not, and a client replacing its own connection can still meet it. Measured
over real ssh into the Docker fixture, before and after:

| | Connections in 12s | Indicator changes | End state |
| --- | --- | --- | --- |
| Both re-dial | 29 | 82 | none, forever |
| The displaced one stops | 2 | 1 | one client served, the other told why |

**Mutating calls carry an `op` and the server dedupes them.** A client that
retries a write after a reconnect must not apply it twice: the second attempt
would find its own bytes on disk, fail the `baseMtimeMs` divergence guard,
and trash-copy the user's own save. Each such request carries a per-client id;
the server keeps a short window of completed ones (`bun/opLog.ts`) and returns
the recorded outcome — including a recorded REFUSAL — instead of re-executing.
The divergence guard then means what it has always meant, which is that
somebody else wrote the file.

Three details decide whether that is safe rather than merely plausible:

- **The list is stated as the READS** (`READ_ONLY_METHODS`), so a method nobody
  classified defaults to being deduped. That costs an entry in a bounded window;
  the other default costs a note saved twice.
- **The window belongs to the server, not to a connection.** One scoped to a
  connection would be forgotten at the exact moment a replay needs it.
- **The handshake names the server's RUN** (`Hello.instance`). A different
  instance answering means the op log is empty and a replay cannot be told from
  a first attempt, so what was in flight is failed instead. That case needs the
  daemon to have died and restarted between two dials, and it is the one case
  where guessing is a corrupted note.

**Only a transport failure is replayed.** A handler saying no is an ANSWER and
it is final; the difference is carried by a type (`ConnectionLost`) rather than
by matching on the wording of a message.

## 8. One connection at a time

A client is bound to exactly one server. Switching tears the session down and
rebuilds it.

**Connections are client-side configuration**: a display name, an ssh
destination, a key reference, the pinned host key, and when it was last
reached (`bun/connections.ts`, stored in the client home). Nothing about a
connection is stored on a server, so a server has no opinion about who connects
to it. The local server is a connection too, and not a stored one: always
present, uneditable, unremovable, which is what stops "no connection
configured" from being a state anything has to render.

**Every client keeps a list, and the rules for it are written once.** A phone's
list is a phone's (`ios/Sources/ShellConfig.swift` holds the bytes; ios.md §4),
a Mac's is `connections.json`, and both are driven through the same six schema
methods, so "can this be deleted" has one answer rather than one per client. The
half of a connection that is a fact about *ssh* rather than about a machine's
files — what may be an ssh destination, which host a pin belongs to — is
`shared/connections.ts`, reachable from Bun and from a webview, because two
implementations of that predicate would be two answers about the same string.

**A pin does not follow a connection to another host.** Editing an address is
therefore two steps whenever the host half changed, and one step whenever it did
not: `dev@box` to `ledge@box` is the same machine and the same key. Carrying a
pin across would not fail safe in any useful sense — it would refuse every later
connection with a message about a CHANGED host key, which is the most alarming
possible wording for "you typed a new name" and teaches exactly the
click-through §4 exists to prevent. `connectionUpdate` takes `hostKey` as
null-to-keep, so the refusal is enforced on the stored pin as well as on a
supplied one.

**Editing the connection being served re-opens it**, on the same terms a switch
gets: the new address is reached before the old session is torn down, and a
failure leaves the user exactly where they were. Anything less and the row would
name one machine over a session talking to another, which is the one lie the
indicator exists to prevent. A rename re-opens nothing, because nothing about
how the connection is made has changed.

**A connection that will not open never costs the one that works.** The new
server is reached before the old one is torn down, and at boot a failure falls
back to the local server with the reason kept, so the app opens onto this
machine and says what happened. An app that refuses to open teaches nothing;
one that opens on the wrong machine and says so can be fixed from inside
itself.

**Everything workspace-scoped becomes server-scoped**, one level up: the
registry, search, tags, backlinks, wikilink resolution, daily notes, trash,
and the docs workspace. This falls out of resolution already being per-root
and needs no new scoping rule.

Explicit non-goals, so nobody assumes otherwise: no cross-server wikilinks,
no federated search, no moving a note between servers from inside the app,
and no client connected to two servers at once. (Two clients connected to one
server is the opposite arrangement and is supported; §1.) Each is individually
plausible and
collectively a different product. Moving notes between servers is what `rsync`
and `git` are for, and the plain-files ethos is what makes that true.

**Which machine you are typing into must be legible without looking for it.**
The failure mode is running a command on the wrong box, so the connection
indicator is persistent chrome, not a menu item, and it is distinct from the
`host:` badge a drawer already wears. The switching verb lives in the command
registry like everything else (`interactions.md` §1); its full grammar is
`interactions.md` §4-1.

**Switching is a reload.** The view's boot builds every server-scoped thing
there is — the registry, the note lists, the tags, the layout — so a switch
flushes pending saves and starts the page over against the new machine. The
alternative, tearing the same state down in place, would mean a second and
less-tested teardown path for every module holding a `configureX` singleton.

**`ledge <title>` on a server reaches every connected client.** The open-request
file (`bun/openRequest.ts`) stays exactly as it is for the local case. When
clients are attached, the server also pushes `openExternal` to all of them,
which is the message the view already handles. Everyone rather than a guess at
one: the request was typed at that machine's own shell and names a note, not a
screen, so picking a client would be guessing which device the person is
holding — and the cost of guessing wrong is a verb that does nothing visible,
against a cost of one tab on a device you were not looking at. A request expires
at 60 seconds either way.

## 9. Locking across the wire

The vault lives on the server and `bun/vault.ts` does not move. The
passphrase crosses the connection once per unlock, as it crosses the RPC once
per unlock today, and the master key stays in the server's memory.

Two facts change and both are stateable in one line each in `locking.md` when
this lands:

- **The passphrase now leaves the client machine.** It travels inside ssh to
  the machine that holds the notes, which is the only machine that can use
  it. A user whose server is a VPS is trusting that VPS with their notes
  already.
- **A remote client is a UI surface, not an agent surface.** `locking.md`
  §8's invariant is about MCP, the CLI, and prompt fences, all of which run
  on the server and keep refusing there. Adding a remote client does not add
  an agent, and the refusals stay where they are because they live at the
  `notes.ts` seam.

Idle relock is the server's timer and is unchanged. A client that
disconnects does not relock the vault; walking away does, which is what the
timer already measures.

## 10. What never crosses the wire

- **Profile values.** A note carries the profile name; the server resolves
  the file at spawn. The values do not exist in the client process, remote or
  local, and `profile:` and `envFile:` still do not travel to an execution
  host either, because a secret on a remote command line sits in that
  machine's process table.
- **`.workspaces.json` and `.vault.json` bytes.** Both are server-shaped
  trust artifacts and the client has never seen them.
- **Locked plaintext to an agent surface**, per §9.
- **A path the client constructed.** Per §2.

**Seven RPC entries are the client's outright** and never become frames
(`bun/clientSeams.ts`, whose `CLIENT_METHODS` is the list both ends read):
`clipboardWrite`, `clipboardRead`, `clipboardReadRich`, `assetPaste`,
`assetPick`, `linkOpen`, and `menuSet`. Opening a URL happens on the device the
user is holding, not on the VPS; the picture you want to insert is in that
device's photo library or on its disk (ios.md §11); and a headless server handed
the view's menu would swallow ⌘Q with it. The six connection entries (§8) join
them for a different reason: a server has no business knowing which servers this
client can reach.

The server implements all thirteen as REFUSALS rather than omitting them, because
the handler map is total by construction; reaching one means a client forgot
its overlay, and `{text: ""}` back from a clipboard read would look exactly
like an empty clipboard until somebody went looking. `bun/server.ts` now has no
`osascript` call site at all.

**One push is the client's too**, for the mirror-image reason: `connectionState`
says whether the wire is up, and the end on the far side of a dropped one is in
no position to report it. `CLIENT_PUSHES` in `shared/wire.ts` is that list, and
it is subtracted from the `ServerPush` type rather than stubbed — a server
handed a method whose only correct implementation is not to call it is a
mistake waiting to be made.

## 11. Deployment and portability

**The server ships as one binary** (`bun build --compile`) for macOS arm64
and Linux x64/arm64, and as a Docker image for the hosts that want one. Build
the image on debian-slim rather than alpine: the PTY layer is `bun:ffi` over
`posix_spawn` and `forkpty`, and musl is a fight that buys nothing. musl also
has no `posix_spawn_file_actions_addchdir_np` at all, which is the same rule
seen from the other side. The floor is glibc 2.29 (Debian 11, Ubuntu 20.04,
RHEL 9), set by that symbol.

**The port is three names and one value.** `pty.ts` reaches libc by name, and
almost nothing else about it differs: `O_RDWR`, `POLLIN` and `struct pollfd`
agree, and every function in the table is POSIX. What does not agree is where
`openpty` lives (libutil below glibc 2.34, libc at and above it, so it gets a
handle of its own because `dlopen` resolves a table all at once), which header
declares `login_tty` (`<util.h>` on BSD, `<utmp.h>` on glibc), and
`POSIX_SPAWN_SETSID` (0x0400 against 0x0080, a value whose divergence is
silent). `TIOCSWINSZ` differs too and never reaches TypeScript, because the
`ioctl` goes through the trampoline and the compiler substitutes the right
one; that is a second reason for the trampoline beyond the variadic one. The
table is `ptyNative.ts`'s `PLATFORM`, and the rest of `src/bun/` is `node:fs`,
`node:crypto`, and TypeScript.

Two things the port found that reading could not, both of which shipped
broken and neither of which is visible from macOS. A pty master whose child
has exited reads 0 on macOS and fails with EIO on Linux, so `exited` never
latched there: no `terminalExit`, and a session that stayed in the map
forever. The portable answer is POLLHUP, which both kernels raise and which
`poll` was already being called for. And nothing waited on a pty's child, so
every closed drawer left a zombie — invisible in a window's lifetime, a pid
leak in a server's.

**Two deployments, and the image is built for one of them.** The binary on a
VPS is reached by ssh, and `serve` autostarts the daemon on the first
connection. The container's PID 1 IS the daemon and `docker exec` runs the
pump, so the image ships no sshd: §3's argument for ssh is that Ledge
inherits the most-audited daemon on the machine rather than writing an
authentication system, and a second sshd inside a container gives that back
for a second set of host keys and a second published port. The forced command
§4 describes names `docker exec -i ledge ledge-server serve` instead.

A daemon somebody STARTED does not idle out, which is what `--autostart`
distinguishes: the timeout exists for the daemon an ssh conjured, and a
supervisor restarting a container every minute for correctly deciding nobody
was home is not a design anyone would choose.

**A server's toolchain is the user's, and TypeScript was not the exception it
looked like.** The image carries zsh because that is settings.jsonc's default
shell, and openssh-client because `host:` frontmatter dials out from the SERVER
(§6); every language a note actually runs is added in a `FROM ledge-server` of
the user's own, since guessing at that list is a maintenance claim on somebody
else's toolchain. `blocks.interpreters` maps `ts` to the token "bun", which the
app resolves to `process.execPath` because its main process IS a bun — and a
server's `process.execPath` is `ledge-server`, that same bun with the server
compiled into it, whose only verbs are `serve` and `daemon`. So a ```ts fence
on a server answered with the server's own usage text and exit 2. `runner.ts`'s
`bundledBun` resolves the token by binary name and gives a server "", which
falls back to the PATH's `bun`: it runs where an admin installed one and says
"command not found" where nobody did, which is what every other language on
that machine was saying all along.

**The CLI is not in that binary either, and the palette says so first.** A
`ledge` shim execs the exact runtime and entry that wrote it (`bun/cliShim.ts`),
which in the app is `Contents/MacOS/bun` plus the `cli.js` that
`electrobun.config.ts` copies beside `index.js`. A compiled `ledge-server` has
no such neighbour, so `cliInstall` there could only fail, and it used to fail by
naming a path inside `/$bunfs` and advising a rebuild. `workspaceList` now
reports `cliShim` alongside `folderDialog`, on the same round trip and for the
same reason: Install Shell Command is absent on a connection to a server rather
than present and failing (interactions.md §8). The call still refuses if it
arrives, in a sentence about where the CLI lives. Giving a server a CLI is a
different piece of work than hiding a verb that cannot run — it needs the CLI
compiled into the server binary behind a verb of its own, which is the same
restructuring `serve.ts`'s argv guard would need to run a file.

**Clients install and upgrade the server the way VS Code Remote does.** The
client connects, reads the server's version from the handshake, and offers to
push a matching binary when it is missing or mismatched. A user who prefers
to manage it themselves runs the same binary from a package. Not built:
today's answer is `docs/user/18-notes-on-another-machine.md`'s two commands,
which is honest for this audience and does not stay honest at a download page.

**The handshake is the first frame in each direction** and carries the
protocol version, the schema version, and the build. A schema mismatch
refuses the connection with the two versions named and the upgrade offered.
It does not negotiate a subset: a partially-understood protocol is how
silent data-shaped bugs happen.

The compiled-in docs corpus (`bun/docsContent.ts`) ships with the server, so
a VPS serves the manual that matches its own version.

## 12. The round-trip budget

**No interactive path costs more than one round trip.** Every call is free
in-process today and costs 40ms or more against a VPS, so this is the rule
that decides whether the whole design feels like software or like a remote
desktop.

A round trip is a WAIT, not a request. Requests issued concurrently are one
round trip however many there are, because frames interleave (§3); requests
awaited one after another are as many round trips as there are requests. That
distinction is the whole rule, and it is what the points below are about.

What it means in practice:

- **The server pushes; the client does not poll.** `notesChanged` already
  works this way. Nothing new may be built on a timer.
- **The note list and tag set are client-side caches**, invalidated by
  watcher pushes rather than re-fetched per keystroke. Wikilink resolution
  already resolves view-side against the store's metas and is the model to
  copy, not an exception to it.
- **Batch instead of iterating.** Anything that AWAITS an RPC call inside a
  loop is a bug at this boundary. Reading a list of things concurrently and
  applying the answers afterwards is not — and it is usually the smaller
  change, because the per-item guards stay exactly where they were.
- **Assets cache by content.** `assetRead` per image per render is a round
  trip per image; the data-URL cache `locking.md` §3 already evicts on relock
  is where the answer lives.
- **Writes echo locally.** The editor is the authority on what the user just
  typed. A save is optimistic, and the divergence guard arbitrates the rare
  disagreement, as it does now.

An interactive path that cannot meet the budget gets a stated exception in
this section, not a quiet extra round trip. There is one:

**`terminalStatus` before a run reaches the drawer costs a second round trip**,
because the answer decides whether the host picker interposes (`interactions.md`
§4a) and therefore WHICH MACHINE the command runs on. The obvious fix is the
one above — cache it in the view, invalidated by `terminalExit` — and it is
wrong here: a cache that wrongly says "live" skips the picker and runs the
block on the first host in the list without asking. Trading the one failure
this whole design exists to prevent for 40ms is not a trade. It stays two round
trips, on a path that ends in a modal the user has to answer anyway.

The audit that produced this section found one genuine violation, since fixed:
`reloadOpenNotes` awaited one `noteRead` per open tab, serially, on every window
focus and every watcher push — Ledge's own saves included.

## 13. Testing

Per `testing.md`'s categories:

- **Unit (colocated `bun test`)**: the frame codec (length, type, partial
  reads, oversized frames); handshake version negotiation and refusal; the
  `op` dedupe window; terminal-output coalescing; the settings split and
  its migration; the binary-companion rule and its three ways of being broken.
- **Invariant tests, scratch root**: every §2 guard still refuses when the
  call arrives over the transport rather than in-process, which is the test
  that keeps "the client is the least-trusted end" honest;
  `"../../.ssh/id_rsa"` throws over the wire exactly as it throws today; a
  forced-command key cannot obtain a shell; a replayed write applies once.
- **Filesystem, over a real socket** (`daemon.fs.test.ts`, `serve.fs.test.ts`):
  two clients are both served and a client's second connection replaces its own
  first and is told why; a socket that never says who it is replaces nobody;
  each of the seven pushes reaches the clients §7's table says it does and no
  others; an idle daemon exits, a busy one does not, and one client leaving does
  not end the daemon another is using; a push with no client attached is dropped
  rather than thrown, which is a bug this suite caught rather than prevented;
  and a whole `serve` process killed and restarted, with the server's state
  still there.
- **The reconnect ladder, at both of its ends** (`transport.test.ts`): a bye
  is not dialled again; a connection that dies as soon as it is made does not
  buy a fresh ladder; and a connection that HELD gets the whole ladder back,
  which is the half that would otherwise disconnect a working session on its
  ninth ordinary drop. The clock is injected beside `sleep`, so none of the
  three waits for anything.
- **e2e (headless WebKit)**: the harness gains a real server over an
  in-process transport beside `FakeStore`, so the same specs run against both
  and disagreements surface as failures rather than as drift; connection
  switching tears down and rebuilds workspace state; a dropped connection
  replays scrollback on reattach.
- **The PTY, against a real shell** (`pty.fs.test.ts`): a controlling
  terminal, an interrupt that stops a foreground job, a ^C character the line
  discipline turns into a signal, resize reaching the program inside, the
  write queue, the exit latch, and the collection of the corpse. Everything
  interesting about the PTY is a property of the kernel rather than of this
  code, so it is also the port's proof: the same assertions run on both libcs,
  and the container is where the second one answers.
- **The whole server suite on glibc**: `docker build --target build` and
  `bun test src/bun src/shared` inside it. It found the two Linux bugs §11
  records, and a latent flake in `notes.fs.test.ts` that had put a pause
  AFTER the write it was meant to separate rather than before it.
- **Live probe (`testing.md` §6, scratch `LEDGE_NOTES_ROOT`)**: a real ssh
  round trip, `bun run probe:ssh`, since ssh, the forced command, and
  host-key pinning are native seams the harness cannot fake. It builds the
  shipped image and a fixture that adds an sshd to it
  (`scripts/ssh-probe/`), mints a throwaway key under the forced command, and
  connects with the argv `connections.ts` actually builds. A probe that
  hand-wrote an ssh command line would prove that ssh works, which was never
  in doubt.

What it establishes, and each of these was a claim in this document before it
was a fact: a key carrying `command="ledge-server serve"` runs that and not
`whoami`, and not a shell; a changed host key refuses the connection with
nothing offering to continue anyway; a note round-trips; the same `op` twice
makes one note; a Linux pty answers a command typed from macOS through ssh and
a daemon; and `docker exec` reaches a container whose PID 1 is the daemon.

The gap that was worth naming through phases 2 to 4 is closed: the ssh hop is
real, the sshd is real, and the forced command is enforced by sshd rather than
asserted by a test. What remains unexercised is the part a container on
loopback cannot supply — the round trip is sub-3ms here, and a wire that drops
mid-frame, a middlebox that idles a connection out, and a laptop that sleeps
mid-build are what the reconnect ladder was written for.

## 14. Phasing

Each phase leaves the app shippable.

1. **Done.** `bun/server.ts` is the headless core and `bun/index.ts` is the Mac
   shell around it. No user-visible change, and the whole existing suite was
   the regression test.
2. **Done.** The framed protocol (`shared/wire.ts`), the handshake, and both
   ends of a connection (`shared/transport.ts` and `bun/transport.ts`, split
   in phase 1 of `ios.md`), with `bun/serve.ts` as the
   `ledge-server serve` entry point. `LEDGE_CONNECT` points the Mac app at one
   instead of building its own. What is still owed here is the Mac-to-Mac pass
   with a forced-command key, which needs a second machine (§13).
3. **Done.** Connections (`bun/connections.ts` for the records and the ssh
   argv, `bun/connectionManager.ts` for which one is live), the settings split
   (`shared/settings.ts` SETTINGS_HOMES, `bun/clientSettings.ts`), the
   client home and the client id (`bun/clientHome.ts`), layout keyed by
   client, the §10 moves (`bun/clientSeams.ts`), and the switching grammar in
   `interactions.md` §4-1. Server-scoped state needed no scoping rule, as
   predicted: switching reloads the view, and the view's boot is the rebuild.
   What is still owed, with phase 2's Mac-to-Mac pass: nothing here has run
   against a real sshd, so the argv in `sshCommand` is proved by assertion and
   not by connecting. The `docs/user/` page waits on that too — the connection
   chrome is in the app, and documenting "connect to your other Mac" before
   anyone has is publishing a claim the suite does not back.
4. **Done.** Resilience. The unix socket and the daemon behind it
   (`bun/daemon.ts`), which is the piece the rest hang off: reconnect with
   replay (`reconnectingClient`), the `op` dedupe window (`bun/opLog.ts`) and
   the `instance` in the handshake that says when a replay is safe, output
   coalescing, binary frames for the base64 payloads, and `assetPaste` moving
   to the client, which leaves `bun/server.ts` with no `osascript` at all. The
   §12 audit found and fixed one serial-read loop and recorded one stated
   exception.
   What phases 2 to 4 all owed was the ssh hop itself, and phase 5 paid it.
5. **Done.** Linux, and the debt. The PTY port (`ptyNative.ts`'s `PLATFORM`,
   the `#if defined(__linux__)` in the C, the `.so` that
   `scripts/build-native.ts` now also builds), the `Dockerfile`, and
   `docs/user/18-notes-on-another-machine.md`. `pty.fs.test.ts` is the port's
   proof and runs on both libcs; the whole server suite runs on glibc in the
   container.
   The ssh round trip is `bun run probe:ssh` (§13): a real sshd, a real
   forced-command key, real host-key pinning, and a Linux pty answering a
   command typed from macOS. Every §4 claim about what that key can and
   cannot do is now enforced rather than asserted.
   What is still owed: a wire that actually drops. A container on loopback
   answers in under 3ms and never sleeps, so the reconnect ladder is still
   proved by killing a process rather than by losing a network.
6. **The iOS client**, which is `docs/contributor/ios.md` and depends on
   nothing above being redone. That document is written and none of it is code
   yet; its own §14 phases the work, starting with a move of this transport's
   portable half into `src/shared/` so a webview can run it. Writing it
   amended two sentences here, both marked below: §4's "Ledge parses no key
   material" is true of a client that spawns OpenSSH and false of one that
   links an SSH library, and §7's reconnect ladder is sized for a client the
   operating system leaves running.
