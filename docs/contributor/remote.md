# Ledge remote servers

**Implemented: §14 phases 1 to 5 are code. Phase 6, the iOS client, is
designed in `docs/contributor/ios.md`, whose own phases 1 to 4 have landed —
there is a Swift app, and it reaches a server over ssh, under §4's forced
command, with a key that never leaves a Secure Enclave.** The
connection grammar §8 called for now lives in `interactions.md` §4-1, the
state ownership §5 describes is the code's, and the resilience §7
promises is real: the server is a process behind a unix socket, a dropped wire
reconnects and replays, and terminal output rides binary frames. The server
runs on Linux, installs as `BUN_INSTALL=/usr/local bun add -g ledge-server`
(§11), and ships as an image; `bun run probe:ssh` connects to one over a real
sshd with the §4 forced command enforcing itself, and `bun run probe:npm`
installs the published package on a machine with no toolchain and no Bun, then
drives its terminal.
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
  What actually needed a rule was much smaller than that: the drawer and the
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
Type 0 is a JSON control frame (requests, responses, the schema's push
messages, and the heartbeat of §7). Type 1 is a binary payload tagged with the id of the control
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
drain loop pushes whatever a shell produced every 8ms while bytes are moving,
which would be 125 frames a second down a wire. So the first chunk after a
quiet moment goes out at once — an echoed keystroke is never delayed — and only
a shell that is producing CONTINUOUSLY is batched, at one frame per 30ms or per
128 KB.

**The 8ms is the busy cadence, not the loop's period.** A pty is polled rather
than waited on, so the tick IS the read, and a fixed one ran 125 times a second
for the life of the process whether or not a shell existed: measured on an idle
Linux server, ~0.8% of a core with nothing open at all and ~1.8% with one shell
sitting at a prompt, forever. So the loop backs off to 100ms once everything has
been quiet for two seconds, and every path that writes to a shell or spawns one
calls `wake` first, which is why an echoed keystroke is still never delayed —
the cadence is fast again before the byte it has to carry exists. What CAN
arrive up to 100ms late is output nobody asked for after a long silence, a
background job's first line, and the burst behind it streams at full rate. The
same measurements after: 0.23% empty, 0.50% with the shell.

It lives in the transport, not in the server: the cost it exists to avoid is a
wire's, and the in-process case should not pay a millisecond for a problem it
does not have. Anything else the server sends flushes what is held first, which
is not a nicety — `terminalAttach`'s answer IS the scrollback up to that
instant, and output held back from before it would be painted on top of a
snapshot that already contains it. The ring (§7) remains the authority for
anything a client missed.

## 4. Authentication is the user's own ssh credentials

Ledge issues no identity, runs no account system, and invents no credential
model. What authenticates a connection is whatever already authenticates that
user to that machine: a password, a private key file, or a key their agent is
holding.

**That set is the convention and is chosen for being the convention.** Every
app of this shape offers exactly it — a database client tunnelling to a
Postgres box, an editor's remote-file browser, VS Code Remote-SSH — and none
of them ask the user to prepare the server first. A notes app is not where a
person should meet a new way of proving who they are, and being the odd one out
here buys nothing that §4a cannot buy as an option.

**Ledge mints no keys**, for the same reason. The clients above do not, and a
key the app generated is a key the user has to be taught about, back up, and
find again after a reinstall. `keyPath` names a file they already have and can
already point every other tool at.

The one exception is a phone, and it is the phone's convention rather than an
exception to the rule. There is no `~/.ssh` on iOS for a user-managed key to
live in, so phone ssh clients generate in-app as a matter of course; Ledge's is
generated in the Secure Enclave and cannot be exported (`ios.md` §4). With the
password door beside it, that key stopped being the only way onto a server and
became the better one.

**All three doors are built, on both clients.** A connection carries an `auth`
of `key` or `password` (`shared/connections.ts`); `key` covers the key file and
the agent, which need no secret from Ledge, and `password` is the one that does.
The record says which door the user chose rather than inferring it from whether
a secret happens to exist, so a credential that has gone missing fails with a
reason instead of silently becoming a connection that offers nothing.

**A connection carries a port, and unset is not 22.** It is its own field on
both clients rather than a `host:port` destination, because that is what ssh
takes (`-p`) and what every other client's form asks for separately. Unset
means no `-p` on the argv and the phone's own default, so ssh's configuration
decides: a destination may be a `~/.ssh/config` alias carrying its own `Port`,
and a form that defaulted to 22 and always sent it would override the user's
configuration with our guess.

The port is part of a PIN, which is the half that is easy to get silently
wrong. `known_hosts` indexes a non-default port as `[host]:port`, so
`ssh-keyscan -p` is what takes a pin in the shape ssh will look for at connect
time, and moving a connection to a different port on the same machine
invalidates its pin exactly as moving it to another machine does. Two sshd
instances on one box really can offer different keys.

**Secrets at rest go in the platform keychain**, macOS's on the Mac and iOS's
on the phone. A password has to survive the reconnect ladder, which re-dials
from scratch on every rung (§7) and which a closed laptop lid is enough to
start, so "ask the user each time" is not an option that exists. This is a
smaller change than it sounds: `keyPath` already names a private key on disk,
usually without a passphrase, which is a credential at rest carrying more
authority than a password to one host. A keychain is a better home for a secret
than a file with mode 600, not a worse one.

**On the Mac the keychain is reached through `/usr/bin/security`, and the
item's ACL names that binary rather than Ledge.** A keychain ACL trusts the
program that created the item; both the write and the read go through Apple's
`security`, so Ledge's own code signature never enters it. Measured in a real
bundle: every read is silent with no `SecurityAgent` prompt, a relaunched app
reads back what an earlier launch wrote, and a process with no relationship to
Ledge reads the same item as easily as Ledge does.

Two things follow. Re-signing Ledge cannot lock it out of its own secrets,
which is the failure `locking.md` §3 warns about for items created with
`SecItemAdd` inside the app. And any process running as that user can read the
password with that one command, so the mode 600 comparison above is exact: a
file that user can read, and an item that user can read. Narrowing the ACL with
`-T /Applications/Ledge.app` would bring the signing problem back with it, so
it is not used. What the measurement did not cover is a hardened-runtime
release build making the same spawn, which is the one thing to re-confirm on
the first signed build; that build already spawns `ssh`, `ssh-keyscan` and
`ssh-keygen` from fixed paths.

**The askpass helper reads the keychain itself.** `SSH_ASKPASS` names a script
written into the client home at 0700, the connection id arrives in its
environment, and the script answers with what `security find-generic-password
-w` prints. The secret's path is keychain to helper stdout to ssh: it is never
in Bun's memory and never on an argv. A helper handed the password instead
would need it in both.

**The stored value is the hex of the password's UTF-8 bytes**, which is one
decoding rule instead of a guess. `security find-generic-password -w` prints
its value as text when the bytes are printable ASCII and as hex when they are
not, with nothing in the output saying which happened: `pässwörd` comes back as
`70c3a4737377c3b67264`, and so does a password that IS that string. Storing hex
makes the stored value printable always, so the read is always hex and the
helper always decodes. Getting this wrong would not error, it would send the
wrong password.

**The write goes in on stdin, not on an argv.** `security`'s own usage text
calls `-w <password>` insecure and it is right, for the reason §10 gives about
profiles. What goes down the pipe is the whole command rather than the value
alone: `security -i` reads `add-generic-password … -w <hex>` as one line, and
the secret is still in no process's argv — `ps` shows `security -i`.

**The prompting form of `-w` cannot be used, and this is measured rather than
reasoned.** `-w` last, with no value, makes `security` prompt — and a prompt is
not read from a pipe. With a controlling terminal it opens `/dev/tty`, prints
`password data for new item:` there and waits forever, so the value written to
its stdin is never read, the write never returns, and the user sees an app that
stopped and a stray prompt in whatever terminal launched it. Only a process with
NO controlling terminal falls back to stdin. That is every `.app` launched from
Finder, which is why the prompting form worked in the shipping shape and hung
under `bun run start` — and why it passed the probe below every time, since a
probe driven over ssh has no tty either. `security` also exits 0 for failures it
merely prints, so the write is read back before it is called a success.

**Changing a password puts the new one in before the dial and the old one back
after a failed one.** The dial is what PROVES a password, and proving it means
the new value has to be in the keychain when ssh runs, so an edit that mistypes
one would otherwise destroy the working one on its way to reporting the failure.
`connectionStore.swapPassword` returns the way to undo itself and
`connectionManager` calls it on any error after the swap; the record is written
only once the wire is up. A key connection reaches the same safety for free,
because the credential is a file the user owns and Ledge does not move it.

Reading the old password back to be able to restore it is the ONE place in the
app that reads a stored password into memory, and it is bounded by how long one
ssh takes to fail.

**A passphrase on an existing key already works through the agent.**
`IdentitiesOnly=yes` restricts ssh to the identity named by `-i`, but that
identity may be served by `ssh-agent`, so a loaded key authenticates with no
prompt. An unloaded passphrased key fails, and fails with the agent's own
message.

**One ssh option is not negotiable, whichever door is used.** There is no
`-t`, because the protocol rides stdout and newline translation on a
length-prefixed stream corrupts rather than breaks.

**`BatchMode=yes` is negotiable, and a password connection turns it off.**
This section used to claim the opposite: that `SSH_ASKPASS` with
`SSH_ASKPASS_REQUIRE=force` needs no terminal and therefore needs no
relaxation. Measured against a password-only sshd, that is false. Under
`BatchMode=yes` OpenSSH suppresses askpass entirely, `force` included; the
helper is never spawned and the connection fails without a password ever being
offered.

Narrower options cover what `BatchMode` was there for, which is what makes
turning it off affordable:

| The hazard | What covers it instead |
| ---------- | ---------------------- |
| A host-key question that hangs forever | `StrictHostKeyChecking=yes`, which refuses outright and asks nothing, `BatchMode` or no |
| Retrying up to sshd's `MaxAuthTries` | `NumberOfPasswordPrompts=1`. A wrong password ends the dial in about three seconds |
| A prompt eating stdin, or an answer landing in a frame header | Neither occurs. askpass answers on its own descriptors, and the protocol comes up over the same connection |

So the argv is per-connection rather than one shape for every door
(`sshDial`, which returns the environment with it so that a caller cannot build
one and forget the other). A key or agent connection keeps `BatchMode=yes`
unchanged. A password connection sends `BatchMode=no`,
`NumberOfPasswordPrompts=1`, `PubkeyAuthentication=no` so a running agent does
not spend the auth budget offering keys before a password is tried, and
`PreferredAuthentications=password,keyboard-interactive`.

**Both of those methods, because a password reaches OpenSSH by two code paths
and many servers use the second.** `password` is the ssh protocol's own method;
`keyboard-interactive` is the one PAM answers with, and a Debian sshd with
`KbdInteractiveAuthentication yes` and `PasswordAuthentication no` accepts the
same password by a route that naming only `password` would exclude.
`SSH_ASKPASS` serves both, and `NumberOfPasswordPrompts` bounds both, because
ssh counts kbdint attempts against it too. `probe:ssh`'s `[password]` step
stands up one sshd per method, each offering that method alone and no public key
at all, so a connection that comes up has proved which route carried it (§13).

Three further options are on the argv and are not security at all:
`ServerAliveInterval`, `ServerAliveCountMax` and `ConnectTimeout`. They are
what makes a lost network an event rather than a hang, and §7 carries them.

**The host key is pinned on first connect**, which is also the convention: every
ssh client asks once and remembers, and Ledge's version of asking shows the
fingerprint. A changed key is refused with the fingerprint shown, and there is
no blind accept and no "continue anyway" that remembers.

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
makes it the only end of this design with new cryptographic surface.

**Enabling Remote Login exposes sshd to everything that can reach the
machine.** For a VPS that is the public internet, on a box whose purpose is
to execute code from notes. The documented posture is binding sshd to the
tailnet interface, not `0.0.0.0`, and it belongs in `docs/user/` rather than
in a footnote.

## 4a. Restricting the key is the user's move

A connection can be narrowed to the protocol and nothing else, with an
`authorized_keys` option on the key it authenticates with:

```
restrict,command="ledge-server serve" ssh-ed25519 AAAA... ledge@laptop
```

**Ledge documents that line and never writes it.** Two reasons, and either
would be enough. `authorized_keys` is the file that decides who may log into a
machine, so a client that rewrites it is a client that can lock its user out of
their own server; the blast radius of a bug there is not proportional to the
convenience. And no comparable client does it — the database clients, the
remote-file browsers and VS Code Remote-SSH all connect with what they are
given and edit nothing on the far side. A verb that prepares somebody's server
is a paradigm this app has no specific need to invent.

**It is hardening and not a gate, which is a fact about sshd rather than a
policy.** A forced command OVERRIDES what the client asked to run; it does not
enable it. `sshCommand` already ends with `ledge-server serve`
(`bun/connections.ts`), so sshd runs the requested command when there is no
forced one and the forced one when there is, and the connection works either
way. Nothing in `src/` reads or requires the option.

**What it buys, stated accurately.** No port forwarding, which is the one that
matters most: it is what stops a stolen client key from becoming a route into
whatever private network the server can see. No agent forwarding. No `scp` and
no sftp subsystem. And a credential scoped to Ledge, so a client compromise
does not hand over a key that was also the user's general-purpose one.

**What it does not buy, which this section used to overstate.** "That key
cannot open a shell" is true at the ssh layer and much weaker than it reads.
The protocol behind the forced command carries `terminalAttach`,
`terminalInput` and `runBlock`: it is arbitrary code execution as that user, by
design, because that is the product. The restriction narrows the ssh feature
set around the protocol. It does not narrow the protocol, and a document that
implies otherwise is selling a guarantee the design does not make.

What survives of the older claim is the part about surface area: restricting
the key leaves the server's frame parser as the only new attack surface, and it
stays small — fixed frames, no dynamic paths, and the §2 guards behind it.

**A password cannot carry it.** `restrict,command=` is an `authorized_keys`
option and attaches to a key; password authentication has no entry there, so it
has no restriction and no forced command. An administrator who wants the same
shape uses `Match User` with `ForceCommand` in `sshd_config`, which is a fact
about how they run their servers and not something this app should be steering.
Both belong in `docs/user/` as optional hardening for somebody who wants it.

**The Docker deployment needs a different line**, `docker exec -i ledge
ledge-server serve`, because the forced command reaches into the container
(§11). Since the only thing Ledge does with the line is show it, the whole cost
of that difference is showing the right one.

**Considered and dropped: a pairing flow that wrote the file itself.** The
server would open a short enrollment window, hand out a QR carrying the
destination, its own host key line and a one-shot credential, and write the
real key when the client presented it. It reads well, it deletes every typed
character, and it fails both tests above at once: it is Ledge writing somebody's
`authorized_keys`, and under Docker it additionally needs that file bind-mounted
into the container, which widens what a container compromise reaches. The two
problems it was really solving are answered elsewhere and more cheaply — a
fingerprint nobody wants to compare is the ordinary first-connect prompt every
ssh client shows (§4), and a server binary that is not installed yet is §11's
one-step install, which a password door reaches without touching the file.

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
| Which client owns a drawer (bytes, keystrokes, winsize) | server | §7, `Term.owner` |
| Which clients are connected | server | §7, `presence`, and only the daemon has more than one |
| What a device calls itself | **client** | §7, `Hello.label`: a hostname, a device name |
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
atomic write) and `workspace/persist.ts` still owns each value's shape. The
key is per CLIENT and not per machine, which is what lets one Mac keep a
different arrangement on every server it reaches: §8a mints a client id per
connection, so selecting a server again restores what was left on it.

**The id rides the handshake, not the call.** Identity is a property of the
connection: a client cannot forget to send it, no handler needs a parameter it
would only ever fill one way, and the view never learns it is one of several
possible screens. That is what `Hello.client` is for. Beside it rides
`Hello.label`, the readable half: the id keys files and stays opaque, while the
label is what the OTHER clients on that server put on screen (§7). The handshake
carries the server's identity too — `Hello.instance`, which names the RUN rather
than the machine, and which §7 uses to decide whether a replay is safe. It
carries `Hello.methods` and `Hello.pushes`, which are what the server can be
asked to do (§11). The protocol version is 5.

**The client home is `.client` inside the app home**, not a second top-level
directory: on every machine Ledge ships to, the client and its local server are
the same user on the same disk, so one `~/.ledge` to back up beats two. It
holds the id, the connection list, Ledge's own `known_hosts`, the client's
`settings.jsonc`, and `window.json` (one frame today; the window list and their
frames under §8a). Deriving it from `APP_HOME` also means
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
`owner` names which client that output is pushed to, and `terminalAttach`
replays the buffer. Nothing about that design needed changing; what it needed was a server
that outlives a connection, which is §1's socket.

Three consequences to hold onto:

- **A dropped connection does not kill a run.** The PTY keeps running, the
  ring keeps filling, and the next attach or claim replays what was missed.
  A client that reconnects to a finished run sees its output.
- **`docId` stays the session key** (`architecture.md` §4) and stays stable
  across reconnects. A client that reconnects with the same client id
  re-attaches its sessions rather than spawning new ones.
- **The ring is the only buffer.** Output older than 256 KB is gone, on
  reconnect exactly as it is on pane switch. A client that needs more asks
  for a longer ring, not for a replay log.

**A drawer that is already open has to ask for the ring, not just have one.**
The bullets above are the drawer's, but only a drawer that MOUNTS collects on
them: attaching is what replays the buffer, and a wire dropping mounts nothing.
An open drawer sits there while the shell prints into a connection that has
gone, and comes back to a terminal with a hole in it, so the client sends
`terminalClaim` for that session after every reconnect.

Claiming is deliberately not attaching. Attaching takes the shell and spawns one
if there is none, and a reconnect may do neither: the shell may have been taken
by a device whose user deliberately opened that drawer, and it may have ended,
in which case a spawn answers with a new shell's empty scrollback and the
history on screen is the only copy of the old one's. So the claim has three
answers, and each is a push that was dropped — the bytes, the `terminalDetached`,
or the `terminalExit`. What arrives late is the same news, through the same
paths in the view.

**Inline runs have no attach at all, so a client reconciles them instead.** The
drawer has a ring and two ways to replay it. An inline run has neither. It is a `runEvent` push keyed by a run id, and the
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

**The vault is re-asked too, and it is the one where being stale is not
cosmetic.** The vault belongs to the server and relocks itself after fifteen
idle minutes (`bun/vault.ts`). That relock is a `vaultChanged` push, dropped at a
dead wire like any other. Idleness is measured in note-RPC traffic, so a client
that cannot send any is precisely the client the timer fires behind: it is both
the likeliest to miss that push and the one certain to. The view's mirrored
state is what evicts decrypted buffers (`mainview/workspace/editorPool.ts`), so a
client that never asks goes on showing a locked note's plaintext for as long as
the tab stays open, which is the thing the idle relock exists to prevent. The
client therefore calls `vaultState` after every reconnect and feeds the answer
through the same mirror the push feeds.

No third mechanism was needed for it, unlike the drawer's claim and the runs'
reconcile. `vaultState` already crossed the wire at boot, the mirror already
notifies only on a change, and both the eviction and the reload that fills held
faces back in already hang off it. A reconnect that finds the vault where it left
it costs one round trip and moves nothing on screen.

The cost, stated as plainly as the runs' above: this can evict an edit made
during the outage. The idle relock's argument for evicting dirty buffers is that
fifteen minutes of wire silence proves autosave has long since flushed, and a
dropped wire breaks that proof — silence on the wire is not silence in the
editor. What it does not break is the outcome: a locked note's save needs the
vault open (`bun/notes.ts`), so from the moment the server relocked those
keystrokes could not have been written anyway. Evicting makes a loss visible at
the reconnect instead of leaving it pending behind a save that will keep
failing. Not evicting would trade it for plaintext left on screen by the relock
that was supposed to clear it, which is the wrong side of that trade.

**The note store is re-read too, and it is the one with a belt already on it.**
Every `notesChanged` for every root that moved while the wire was down was
dropped, and nothing re-sends them: the next push names the next change, never
the backlog. So the lists and every open buffer go on showing what was true when
the wire went. The client answers by running the refresh it already had — one
`listNotes` per folder plus `reloadOpenNotes`, all issued concurrently, so the
whole sweep is one round trip (§12) however many folders and tabs are open.

The belt is window focus, which runs that same refresh, and it is worth being
precise about why it is not enough. It never fires when the wire returns to a
window that never left, which is the case whenever somebody is sitting there
watching the bar say "reconnecting…". And a phone has no such event to wait for
at all (`ios.md` §5) while being the client whose wire drops constantly, so on
the client with the worst staleness the belt is not fastened.

The refresh reloads CLEAN buffers only (`reloadCandidates` in
`mainview/notes/store.ts`), which is why reusing it matters rather than writing a
second one: a reconnect that reloaded unconditionally would take a half-typed
paragraph away every time a phone changed cell. A buffer that IS dirty keeps
what was typed and settles it the ordinary way, through the divergence guard on
the next save. That is also the ceiling on this whole bug's severity, and why it
was the second of the two to fix: a missed `vaultChanged` leaves plaintext on
screen, while a missed `notesChanged` leaves a stale list and a save that
displaces the other version into the Trash with a notice.

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
| `terminalOutput`, `terminalExit` | the client that owns that drawer | one stream, one reader |
| `terminalDetached` | the client that just lost the drawer | the only screen with a terminal on it that stopped |
| `presence` | everyone, each told about the others | "who else is here" is a different list for every client |
| `runEvent` | the client that started the run | keyed by a run id that only that page's panel holds |
| `menuCommand` | nobody | it is the Mac shell's own AppKit menu (`bun/index.ts`), never a server's |

A push addressed to a client that is not connected is dropped, exactly as every
push was while nobody was attached at all, and the state it described is re-read
at that client's next boot.

**The drawer is the one thing two clients cannot share, so it has an owner.**
`Term.owner` holds one client id, and three things follow it at once: where the
bytes go, whose keystrokes the shell accepts, and whose window sets its winsize.
One field because it is one question. A client typing into a shell whose output
is on another screen is typing blind, and a second window sizing the pty reflows
the screen the first one is reading.

Attaching is what takes it, and it never fails and never asks: the scrollback
comes back with the attach, so the taker has the whole session on screen the
moment it arrives, and a confirmation would be a dialog on the device nobody is
holding. The one obligation is to tell the client that lost it —
`terminalDetached`, which becomes a notice over its now-motionless terminal with
a button that attaches again (`interactions.md` §4-2). Its `terminalInput` and
`terminalResize` answer `ok: false` from the moment it loses the drawer, because
a window keeps its focus after the shell has moved on.

Ownership is by client id, so it outlives connections the way sessions do: a
phone that drops the wire and re-dials still owns the drawer it had, which is
what makes a reconnect invisible rather than a fight over a shell.

What is about the NOTE rather than about the view stays open to every client:
`terminalPaste` (running a block in the note's shell, which every client's Run
buttons already reach through `runBlock`), `closeSession`, and `sessionRestart`.
A phone closing a note it has open should not be refused because a Mac is
holding that note's drawer.

**Every client is told who else is here.** The `presence` push carries a list of
`{client, label}`, and it is sent whenever the set changes: a client arriving, a
client leaving, a client replacing its own connection. Two things need it. The
connection bar names the company, because "who else is on this machine" is the
same question as "which machine" one step further in, and the device it names is
the one that can take a shell out from under you. And `terminalDetached` carries
only the taker's ID, which the receiving client turns into a name through this
list: the server sends ids because an id is what it has, and the label is a fact
about a device that belongs in exactly one place.

Four decisions inside that:

- **Presence is the daemon's, not the server's.** It is a fact about
  connections, and the daemon is the only thing that has more than one. A server
  in the app's own process has exactly one client and nothing to say, so the
  local case is empty by construction rather than by a special case.
- **Each client is told about the OTHERS**, never about itself. The alternative
  is every client knowing its own id in order to subtract itself before
  rendering a sidebar, which is an id the view has no other reason to hold.
- **The whole list each time, not a delta.** It is two or three entries; a delta
  stream that misses one is wrong until the next reconnect.
- **It arrives with the connection.** The push that announces a new client goes
  to that client too, so nobody spends a round trip asking for a list the
  arrival already changed (§12).

The label is the one string in the handshake that a client chooses and another
client's screen displays, so `wire.ts` bounds it at 64 characters and strips
control characters on arrival — a newline in a sidebar row is a broken row, and
an escape sequence in a line somebody tails from a server log is a terminal
doing what the label said. It is cleaned rather than refused: hanging up on a
phone over its device name would cost a session to gain nothing. A client that
sends no label is simply "another device" on screen.

On the client, presence is cleared whenever the link is not `live`. A wire that
is down cannot report who else is up, and the reconnect that follows is itself
an arrival, which announces the list to everybody.

**A wire that stops carrying bytes is noticed in about twenty seconds, and the
protocol is what notices.** Everything else here is armed by a connection
ENDING, and a network going away does not end one: no FIN, no RST, nothing
exits, the socket simply stops carrying bytes. So the client asks. A client that
has heard nothing for five seconds sends a `ping`; the server answers `pong` the
moment one arrives; three unanswered probes in a row end the connection, and the
ladder below picks it up as it would any other drop
(`shared/transport.ts`, `PROBE_EVERY_MS`). Measured end to end that is twenty to
twenty-five seconds, because the beat that finds the silence is on its own
cadence and not aligned with the moment the silence began. `ServerAliveInterval`
has the same property for the same reason.

Adding the two frames moved the protocol version to 4, which is what that number
is for: an older server would meet its first `ping` at the default arm of its own
`handle`, hang up on a client that "may not send ping", and be re-dialled into
the same refusal. Refusing at the handshake instead names both versions and says
what to do about it (§11). It is at 5 now, for the hello that carries a method
list instead of a schema hash.

The probe is a frame rather than a request, and the server answers it in the
transport rather than in a handler. Both follow from what it has to prove. A
request would queue behind the handler map, which arrives only once the vault
has loaded, so a probe sent during a slow boot would report a dead server that
was merely starting. And what a pong proves is that the process holding the
notes is reading its socket and writing to it — which is the question, and which
no hop between the two ends can answer on that process's behalf.

**A client speaks when it has been quiet in EITHER direction.** The two
questions are asked for different ends: what ARRIVED is how this client knows
the server is there, and what LEFT is how the server knows this client is. A
phone watching a build scroll past is busy inbound and silent outbound, and a
client sitting at a prompt is the reverse, so a rule that watched one direction
would leave one of them looking dead to somebody.

**Two mechanisms below the protocol do a smaller version of the same thing, and
both stay.** `sshCommand` sets `ServerAliveInterval=5` with
`ServerAliveCountMax=3`, and ssh hangs up once three keepalives go unanswered;
the phone has no ssh to configure (NIOSSH ships no keepalive and no way to send
one), so `ios/Sources/SSHTransport.swift` sets Darwin's per-socket options
instead — probes on an idle wire, and a cap on the retransmit episode for a wire
with a write outstanding, because TCP splits into two mechanisms what ssh does
with one. All three carry the same numbers. What separates them is who answers:

| Mechanism | Answered by | What only it covers |
| --- | --- | --- |
| `ping`/`pong`, both clients | the daemon itself | a server that stopped answering behind a wire that is perfectly healthy |
| `ServerAliveInterval`, the Mac | sshd on the far machine | a wire that went away while this app's own timers are wedged |
| `TCP_KEEPALIVE` and friends, the phone | the nearest TCP peer | a wire that went away while iOS has the app suspended, running no timers at all |

The bottom two cannot see a stalled server, and a hop that terminates TCP (a
published Docker port, a load balancer) answers the phone's keepalives itself
and hides a drop from it entirely (`ios.md` §3). The top one cannot run while
the operating system has the app suspended. That is why there are three and not
one, and why the one in the protocol is the one that decides.

`ConnectTimeout=10` bounds the other half of the same failure, because dialling
INTO a hole hangs the same way and a rung that never returns is a ladder with
one rung. The heartbeat closes the last of that: a dial that CONNECTS to a
server which then says nothing had no bound at all before, since the dial
succeeded and `ConnectTimeout` was already satisfied. Neither lengthens the
ladder against `IDLE_EXIT_MS` below, because a server on the far side of a hole
never saw its client leave and its idle clock is not running.

Twenty seconds is chosen against what each mistake costs, and the two are not
comparable. Hanging up on a link that was only stalled costs a reconnect: the
ladder re-dials, what was in flight replays under its own op ids, the instance
matches and the sessions are still there. Not hanging up costs the session.
An ordinary blip is far shorter than twenty seconds and is never noticed at
all, which is what TCP retransmission is for.

**The server collects a client it has not heard from in forty seconds**
(`bun/transport.ts`, `SILENT_MS`). It never probes, because it does not have to:
a live client says something every five seconds on its own schedule, so silence
for eight of those is a client that is gone. The connection is closed with no
`bye`, since a farewell is a decision a client is meant to READ and stop
re-dialling over, and this one is not reading anything.

What that ends is the mirror of the bug above, on the machine that can least
afford it. A wire that black-holes leaves the daemon a connection nobody will
ever close: its sessions stay open, `clients` never empties, the idle exit is
never armed, and a shell keeps running on somebody's server for as long as the
machine is up. TCP will not end it either — a black hole has no FIN to send, and
sshd probes its own clients only if somebody configured it to. Forty seconds is
twice what a client allows itself, so a client that has already decided is
always the one that decided first, and it is under `IDLE_EXIT_MS` so a ghost
delays an unattended daemon by less than one idle window rather than forever.

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
rebuilds it. A window is a client, so two servers at once is two windows and
not two connections in one (§8a).

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
server is the opposite arrangement and is supported; §1. Two windows on two
servers is that same arrangement rather than an exception to this one, because
each window is a client; §8a.) Each is individually plausible and
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

**A dial that fails reports what ssh said, not what the transport saw.** Every
way of failing to reach a server happens before the first frame arrives, so all
the protocol can report is that a wire it never had is gone — one sentence, and
it is equally true of a missing binary, a refused key, a firewall and a typo.
ssh knows which, and writes it to stderr, so `spawnDuplex` captures stderr when
a caller asks for it and `explainDial` (`bun/connections.ts`) puts the last line
in front of the transport's. Exactly one case is rewritten rather than passed
through: `command not found` is the remote login shell reporting a package
nobody installed there, and that is a sentence about §11 rather than about the
shell. Everything else goes through as ssh wrote it, because "Permission denied
(publickey)" and "No route to host" are already the diagnosis and a table of
guesses would only be a worse one. The capture is opt-in because a piped stderr
nobody drains is a child that blocks once the buffer fills.

**Except a refused handshake, which keeps its own words.** "Every way of
failing happens before the first frame" is true of the dial and false of the
protocol, and §11's version check is the failure on the other side of that
line: the far end ran, spoke, and was understood well enough to be disagreed
with. By then the last thing on stderr is that far end's own `serve` banner, so
the rule as written reported "Could not reach v1: `[serve] ledge-server 0.1.0
attached to …`", which says a machine is unreachable by quoting the line where
it says it is up. Two changes, because either alone leaves the other half
wrong. A refusal is a type (`Refused`, `shared/transport.ts`), raised whichever
end decided it, and `bun/index.ts` gives it precedence over stderr. And the
banner joins the lines `explainDial` already drops as true of connections that
went on to work, so the fallback is honest for the failures nobody has typed
yet.

**`ledge <title>` on a server reaches every connected client.** The open-request
file (`bun/openRequest.ts`) stays exactly as it is for the local case. When
clients are attached, the server also pushes `openExternal` to all of them,
which is the message the view already handles. Everyone rather than a guess at
one: the request was typed at that machine's own shell and names a note, not a
screen, so picking a client would be guessing which device the person is
holding — and the cost of guessing wrong is a verb that does nothing visible,
against a cost of one tab on a device you were not looking at. A request expires
at 60 seconds either way.

## 8a. New Window

The fork this whole section turns on is a window is a client, not a second view
of one. Everything below follows from that sentence. `bun/index.ts` is the
shell that holds the windows, `bun/connectionStore.ts` is the list they share,
`bun/connectionManager.ts` is one per window, and `bun/audience.ts` is the
routing the local server needed once there was more than one of them.

**A window is a client.** New Window opens a second window with its own
connection, its own client id, and its own row in `presence`. Two windows can
point at two servers at once, which is what the verb is for: a laptop, a build
box and a VPS are three machines one person uses in the same hour, and reaching
them by switching (§8) costs a full reload each way.

§8's non-goal survives unchanged. A client is still bound to exactly one
server, and no view ever holds two connections. What stops being true is that
a Mac is one client. Two windows are the arrangement §1 already describes and
`interactions.md` §4-2 already gives a grammar for — two clients, presence
between them, one owner per drawer — now reachable without a second device.

**What a window owns, and what the process owns:**

| State | Owner |
| ----- | ----- |
| The connection, and which server it points at | window |
| The client id, and so the layout it reads (§5) | the connection, held by whichever window points at it |
| The label other clients display (`Hello.label`) | window |
| The window title | window, and it is the connection's name (the manual's window is titled for the manual) |
| The webview's RPC, and the pushes routed to it | window |
| The window frame | window |
| The connection list and its pinned host keys | process |
| The client home: `known_hosts`, client settings, the window list, the connection-to-client-id map | process |
| The local server, its watchers, its vault, its PTYs | process |
| The menu bar | process, driven by the focused window |

**A window is titled by the connection it is on**, so a title bar says "This
Mac" or "v1" rather than "Ledge". Three windows all called after the app tell a
person nothing in the Window menu, in App Exposé, or in a tabbed window's tab
bar, and the one thing a second window exists for is being on a second machine.
The manager reports the name through its `onName` seam and `bun/index.ts` puts
it on the window: at boot, before the window is built, so no window is ever
titled for a machine it is not on; on a switch; and on a rename of the
connection being served, which is the one case `onSelect` cannot carry, since
the window went nowhere and the string on it is what changed. A window that
fell back is titled for the machine it landed on, not the one it wanted — the
indicator is what explains the difference.

**The list is shared and the selection is not.** `connections.json` holds the
list and the pins for the whole app, because a machine you have paired with is
a fact about this Mac rather than about one of its windows. Which connection a
window points at is stored with the window instead of in that file's `selected`
key: two windows writing one selection would mean the last one to switch
decided where the next launch opened. That key is still read and still written
back unchanged, because it is the only record an install upgrading across this
change has of where it was, and the only thing left if the window list cannot
be read.

**Two refusals about connections in use**, both of them the store's rather than
one window's, since only the store can see every window. A connection a window
is on cannot be removed, which is the old rule with "a window" where "the
window" used to be. And a connection another window is on cannot be
RE-ADDRESSED: that window's wire was built the old way and cannot be re-opened
from here, so leaving it pointed at the old machine while the row names the new
one would be the lie the indicator exists to prevent. A rename is never
refused, because it changes nothing about how a connection is made.

**One local server, however many windows.** `attach` builds a server in this
process for the local connection (`bun/index.ts`), and a second one over the
same notes root would give the machine two watchers, two vaults, two PTY maps,
and two consumers of the open-request file. So it is built on the first local
attach and each window takes an overlay of it through
`createServer(...).forClient(id)`, which already took a client id. It is torn
down when the last of those overlays is released, which is what keeps a window
switching away from this Mac costing exactly what it always cost, its shells,
while a second window on this Mac costs nothing. The audience that addresses
those overlays is `bun/audience.ts`, shared with the daemon: routing between
clients was the daemon's alone only while a Mac was one client.

**Identity follows the connection, not the window.** `bun/clientHome.ts` keeps
a map of connection id to client id, each minted the first time that connection
is opened and kept until it is removed. The map is its own file beside the id,
not a field in `connections.json`, for the reason `CLIENT_ID_PATH` already
documents: a connections file that gets corrupted or hand-edited must not take
the ids with it and orphan every saved arrangement. A window sends the id of
whatever connection it points at. The arrangement a server has on file
therefore comes back whenever that server is selected again, in whichever
window selects it. That is the behavior worth having: a layout is three panes
of THAT machine's notes, and it means nothing in front of another machine's.
The existing machine id is the local connection's rather than an entry in the
map, so an install upgrading across this change keeps the layout it has.

**Switching a window's connection changes its id mid-session**, and §8 already
does the work that makes that free. A switch is a reload, the id rides the
handshake rather than the call (§5), so the new connection is greeted as the
client that server knows and the view boots onto the arrangement it left there.

**A new window is blank; a re-selected server is not.** New Window opens on the
local connection, the way a fresh launch does, and gets whatever that server
has on file. Selecting a server another window is already pointing at is the
one case that cannot restore: two windows cannot both be the client a server
files one layout under. The second gets a fresh id for as long as it is open,
starts empty, and saves nothing over the first — its `layoutGet` answers null
and its `layoutSave` is dropped by the client rather than filed under an id
nothing will ask for again. One window per server is the ordinary arrangement
and never reaches that rule.

**The manual has a window, and it is the one window that is not a place to
work.** The built-in documentation used to be a hidden workspace that took over
whichever workspace you were in — the one surface in the app that answered "what
does this do" by putting away what you were doing. It is a window now
(`interactions.md` §1, Documentation), which is what a window is for: two
things at once, one of them the notes and the other the manual about them.

Everything else about it follows from what a window is here. It is a CLIENT,
so it needs a server, and it is always the LOCAL one: the corpus is compiled
into this build and synced to the local docs root at every launch
(`bun/docsContent.ts`), and a remote server's copy is whatever version happens
to be installed over there. It is titled for what it is rather than for the
machine it is on, breaking the title rule above for its own reason: every copy
of the manual is the same one, so which machine is not the question its title
has to answer. There is at most one — asking again raises it and lands it on
the page asked for (the `windowDocs` request and the `docsShow` push, both of
them the shell's own: no server has windows) — because a second window onto
four read-only pages is two windows scrolled to different places in the same
thing.

It also holds no arrangement anybody chose, and two rules fall out of that.
It never takes its connection's client id, so it neither reads nor writes that
server's layout and a window opened after it still gets the layout on file —
the blank-client rule above, applied for a different reason than "another
window got there first", which is also why it is not counted as that other
window. And it is not in `window.json`: a launch never reopens it, since it is
one click away, and a session that ended with only the manual up would
otherwise come back as an app showing its help with no notes in sight.

The view learns which window it is in at boot, from the shell, through
`windowRole` — a question about a window, which is not a fact about the notes
and so never becomes a frame. What it does with the answer is small and
entirely chrome: the manual's window has no workspace strip, no connection
bar, and none of the verbs that would act on a workspace it does not have or a
machine it cannot be pointed at (`interactions.md` §1 lists them). A client
with one window and no way to have two answers false and opens the manual in
the window it has, which is what a phone does (`ios.md` §4).

**The map is bounded by the connection list**, one entry per connection rather
than one per window ever opened, and `connectionRemove` drops the id alongside
the pin. A layout still filed on a server this Mac has forgotten is that
server's to prune, and is the same orphan a phone that never comes back already
leaves (§5).

**Quitting saves the set of windows**, in `window.json` beside the frames it
already held (`bun/windowFrame.ts`). Launch restores the windows that were
open, each dialling the connection it was pointed at, and §8's boot rule
applies per window: a server that will not open costs that window a fallback to
the local server with the reason kept, and costs the others nothing. Closing a
window retires no identity, because its arrangement was filed under the
connection. Closing the last window quits, and that last close saves nothing:
a list saying "no windows" would open the next launch onto a window it had to
invent anyway, with the wrong connection and the wrong frame.

The list is written whenever it changes rather than only at quit — a window
opened, closed, switched, or dragged. A switch a crash swallowed would
otherwise reopen that window on the machine it left. Windows are opened one at
a time, since the id a window sends and the label it presents both depend on
which connections the others are already on.

**Two windows on one server send different labels.** `Hello.label` is the
hostname, read once at launch, so the second window on a connection would send
the string the first one sent, and `interactions.md` §4-2's "iPhone took this
shell" notice would name the machine the user is already looking at. The second
appends an ordinal. The rule stays the client's: a server displays what it is
told (§5).

**Pushes route to one window, except the ones that already describe a server.**
`runEvent`, `terminalOutput`, `terminalExit` and `terminalDetached` are
addressed to the client that asked for them, by id. `notesChanged`, `presence`,
`vaultChanged` and `terminalBusy` reach every window on that server, because
they describe the server's state and a second window is the second screen they
exist for. A drawer is busy for everyone watching it, which is why that one is
not addressed even though its four neighbours are. So does `openExternal`, for
§8's reason unchanged: `ledge <title>` names a note, not a screen. None of this
is new work in `bun/server.ts`: it already said which, for the daemon, and what
changed is only that the app process now answers the question too.

**Presence over the local server is the shell's**, for the daemon's reason
(`announcePresence`): it is a fact about who is CONNECTED, and only the thing
holding the connections knows. Two windows on one Mac need it as much as a Mac
and a phone do, because without it the drawer the other window took was taken
by nobody in particular (`interactions.md` §4-2).

**The menu bar belongs to the focused window.** macOS gives an application one
menu bar, the view owns its contents (`interactions.md` §10), and two views
pushing into it would leave the menu describing whichever one last re-rendered.
Bun remembers every window's last push, applies only the focused window's,
re-applies it when focus moves, and routes `menuCommand` back to the focused
window alone. It is the one place the process arbitrates between windows rather
than routing between them. Focus is never handed back on blur, because macOS
blurs the window you left before focusing the one you arrived at and a click
landing in between would have nowhere to go.

**Almost nothing here reaches the daemon or the phone.** A server already
serves several clients and has no interest in whether two of them are windows
on one Mac (§1); what it gained is a second caller for the routing it already
had. iOS has one window and one connection list (`ios.md` §4), and gains one
stub: `windowNew` answers false there, which is what keeps the verb out of the
palette rather than in it and silent.

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

**Eight RPC entries are the client's outright** and never become frames
(`bun/clientSeams.ts`, whose `CLIENT_METHODS` is the list both ends read):
`clipboardWrite`, `clipboardRead`, `clipboardReadRich`, `assetPaste`,
`assetPick`, `linkOpen`, `menuSet`, and `windowNew`. Opening a URL happens on
the device the user is holding, not on the VPS; the picture you want to insert
is in that device's photo library or on its disk (ios.md §11); a headless
server handed the view's menu would swallow ⌘Q with it; and a machine with no
screen has nowhere to put a window (§8a). The six connection entries (§8) join
them for a different reason: a server has no business knowing which servers this
client can reach.

The server implements all fourteen as REFUSALS rather than omitting them,
because the handler map is total by construction; reaching one means a client
forgot its overlay, and `{text: ""}` back from a clipboard read would look
exactly like an empty clipboard until somebody went looking. `bun/server.ts` now has no
`osascript` call site at all.

**One push is the client's too**, for the mirror-image reason: `connectionState`
says whether the wire is up, and the end on the far side of a dropped one is in
no position to report it. `CLIENT_PUSHES` in `shared/wire.ts` is that list, and
it is subtracted from the `ServerPush` type rather than stubbed — a server
handed a method whose only correct implementation is not to call it is a
mistake waiting to be made.

## 11. Deployment and portability

**The server ships three ways, and the package is the ordinary one.**
`ledge-server` on npm carries a bundle and a prebuilt trampoline per target
(`scripts/build-npm.ts`); `bun build --compile` still produces one binary per
target for anyone who wants a build of their own; and a Docker image serves the
hosts that want one. All three are the same `src/bun/`, and the targets are the
same four: macOS and Linux, arm64 and x64.

Build the image on debian-slim rather than alpine: the PTY layer is `bun:ffi`
over `posix_spawn` and `forkpty`, and musl is a fight that buys nothing. musl
also has no `posix_spawn_file_actions_addchdir_np` at all, which is the same
rule seen from the other side. The floor is glibc 2.29 (Debian 11, Ubuntu
20.04, RHEL 9), set by that symbol.

**A complete package can only be assembled on a Mac**, and the asymmetry is
Mach-O's rather than a limitation of the script. `cc -arch arm64 -arch x86_64`
is a flag, so both Mach-O slices come from one build; ELF has no fat binary, so
each Linux slice comes from its own container (`Dockerfile`'s `native-lib`
stage, exported with `--output type=local`). `npmPackage.ts`'s `routeFor`
states it and `build-npm.ts` refuses rather than shipping three targets out of
four. The architecture each container produced is read back out of the ELF
header before it is packaged, because `docker build --platform` is a request a
daemon without that emulator can answer with the host's architecture.

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

**The install is a package, and the reason is that npm already solves both
problems the compiled binary had.** Two commands ending in `bun add -g
ledge-server` are what `docs/user/18-notes-on-another-machine.md` now says, and
`src/bun/npmPackage.ts` is what makes it true.

The two things this section used to name as prerequisites were both real, and
both were about the ARTIFACT rather than the wire: the release had to produce a
server build at all, and that build had to be ONE file, because the `.so` beside
it was an adjacency rule a copy could get wrong. A package answers them
together. npm ships every architecture in one tarball, so "one artifact per
target" stops being a matrix somebody has to assemble and pick from; and it
installs a directory rather than two loose files, so adjacency is not something
a user can get wrong. `pty.ts` gained one candidate for it
(`native/<platform>-<arch>/`, `ptyNative.ts`'s `nativeDir`), which is the whole
of the code change on the loading side.

What it costs is a runtime on the far machine, and that is the honest trade:
the compiled binary needed nothing over there and this needs Bun. For this
audience it is one curl, and what it buys is the architecture matrix, the glibc
floor as a user-facing rule, and the adjacency rule all leaving the manual at
once. The compiled binary stays supported and stays documented; it is a build
of your own rather than the ordinary path.

**A published command is only reachable if an incoming ssh can find it**, so
the install line is what decides that and not a step after it. Bun places
global commands beside ITSELF, which makes `BUN_INSTALL` the whole of the
question: `curl … | sudo BUN_INSTALL=/usr/local bash` followed by `sudo
BUN_INSTALL=/usr/local bun add -g ledge-server` puts both names in
`/usr/local/bin`, and the same two commands without the variable put them in
the running user's `~/.bun/bin`, which no default sshd PATH contains. The
variable is needed on BOTH commands: `bun add -g` reads it rather than
deriving anything from where the `bun` running it lives, so under `sudo`
alone the package lands in `/root/.bun/bin`. All three shapes were measured on
a bare `debian:12` with the documented commands, and `scripts/probe-npm.ts`
now runs those commands rather than an image that came with Bun in the right
place. The same PATH has to hold `bun` too, since the package's bin begins
`#!/usr/bin/env bun`; a forced command with an absolute path settles the first
half and not the second.

**The `command -v` check stays in the manual** because the install line cannot
reach a machine that already had a per-user Bun on it, which is the field
report this rule came from: an install that was completely fine, reported by
the app as a server that is not installed. `explainDial` is right that the
remote shell said `command not found` and right that a user who has not
installed the server needs that sentence; what it cannot see from one line of
stderr is that the binary is sitting in `~/.bun/bin`. Diagnosing that from the
client was considered and rejected — a probe that goes looking for an install
the PATH denies is scaffolding around a broken install line, and the install
line was the thing to fix.

**Clients that install the server themselves are still not built.** The design
is VS Code's: connect, read the server's version from the handshake, offer to
push a matching build when it is missing or mismatched. §4's password door is
what would carry it to a machine with nothing on it yet. What changed is that
the fallback is now two commands a user can actually run, rather than a git
checkout and a compiler.

**The handshake is the first frame in each direction** and carries the
protocol version, the build, and the list of methods and pushes the server
serves.

**One thing refuses a connection: the protocol version.** It covers the
framing, the shape of the control messages, and the shape of any payload under
a name that stays the same. Those are the incompatibilities a caller cannot see
coming, where carrying on means one end reading the other's bytes as something
they are not. It does not negotiate a subset: a partially understood protocol
is how silent data-shaped bugs happen.

A mismatch refuses with both numbers, the peer's build, and a sentence naming
which end to update: always the older one, since two builds that disagree do
not meet in the middle. The numbers are for whoever reads the log and the
sentence is for whoever reads the connection row, and a message with only the
first was reported as a bug the first time a version moved under a deployed
server.

**A method one end has and the other does not is not one of those, and does not
refuse anything.** It is loud, local, and survivable, so it is handled where it
happens instead. The server declares its `WIRE_METHODS` and `PUSH_MESSAGES` in
its hello; the client intersects that with its own names and refuses a call to
anything missing from it, before the call goes out, with the method and the
server's build in the message (`Unsupported`, `shared/transport.ts`).
Everything else on that connection keeps working. `supports()` answers the same
question ahead of time, so a command that needs a method this server lacks can
be absent from the palette rather than present and then apologetic
(interactions.md §8).

The declaration is a LIST rather than a hash of one. A hash can only answer
"same or different", and different is not incompatible — which was the whole
problem. A list answers the question a client actually has, which is whether
this server can do the thing it is about to ask for.

Three consequences worth stating, because each one used to be a refusal:

| The two ends differ by | What happens |
| --- | --- |
| A client-only verb (`CLIENT_METHODS`, `CLIENT_PUSHES`) | Nothing. Never declared, never on the wire, invisible to the handshake. |
| A method the client has and the server does not | Connects. That one call fails, named, with no round trip. |
| A method the server has and the client does not | Connects. The client never calls it; an unknown push is ignored. |

Why this changed: a fingerprint over the whole method surface refused every
deployed 0.1.0 server the moment `windowDocs` and `windowRole` were added, and
neither is a method any server has ever answered. A rule that stops a whole
connection over a method nobody was going to call makes the client and the
server a matched pair that has to ship together forever, which is not a
property this design can afford.

**The cost is that `PROTOCOL_VERSION` is now bumped by a person, not derived.**
A payload shape changing under a stable name is the one incompatibility nothing
else catches, so `shared/rpc-schema.shape.test.ts` is the tripwire: it pins a
digest of the schema's types, ignoring comments and formatting, and fails when
they move without the version moving. It cannot tell an additive change from a
breaking one, and it is not supposed to. It exists so that nobody is never
asked.

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
  every push reaches the clients §7's table says it does and no others; a
  drawer has one owner, so the client that loses it is told, its keystrokes and
  its resizes are refused, its detach leaves another client's drawer alone, and
  the owner's resize reaches the pty's own winsize (the shell is asked, through
  `stty`); presence is announced on arrival and on departure, each client is
  told about the others and not itself, a client with no name is still in the
  list, a reconnect does not look like a device leaving, and the id in
  `terminalDetached` is a key into the list that names it; an idle daemon exits,
  a busy one does not, and one client leaving
  does not end the daemon another is using; a push with no client attached is
  dropped rather than thrown, which is a bug this suite caught rather than
  prevented; and a whole `serve` process killed and restarted, with the
  server's state still there.
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
- **The published package, on a machine that could not have built it**
  (`bun run probe:npm`). `npm pack` the assembled tree, install it with the
  README's own two commands inside a container that has NO Bun, NO compiler
  and NO libc headers, and drive the result with Ledge's own client over
  `docker exec`. The fixture is chosen for what it lacks: `pty.ts` has two
  ways to get its trampolines and only the prebuilt one can work there, so a
  terminal that resizes proves the packaged library loaded. Bun is absent for
  a second reason — an image that ships Bun in `/usr/local/bin` passes the
  PATH claims whatever the manual says, which is how a per-user install
  reached a user. That is a claim `bun test`
  cannot make from a checkout, because a checkout has a toolchain.
  Its own negative control is `mv`ing one slice out of `dist-npm` and
  re-running, and doing that is what corrected two things this repository had
  wrong. The resize is the discriminator; Ctrl-C is NOT, because the fallback
  spawn is a session leader that opens the slave without `O_NOCTTY` and
  acquires a controlling terminal anyway. `pty.ts` had claimed the opposite in
  two comments and a warning string, and the probe had a check that passed
  either way.
- **Live probe (`testing.md` §6, scratch `LEDGE_NOTES_ROOT`)**: a real ssh
  round trip, `bun run probe:ssh`, since ssh, the forced command, and
  host-key pinning are native seams the harness cannot fake. It builds the
  shipped image and a fixture that adds an sshd to it
  (`scripts/ssh-probe/`), mints a throwaway key under the forced command, and
  connects with the argv `connections.ts` actually builds. A probe that
  hand-wrote an ssh command line would prove that ssh works, which was never
  in doubt.
- **A wire that actually drops**, in the same probe's `[drop]` step. The
  fixture carries `iptables` and the probe runs it with `NET_ADMIN`, so the
  container can cut its own wire: a rule dropping the server's replies leaves
  the connection open, the daemon running and the shells printing, while
  nothing reaches the client and nothing tells it why. It is the only step here
  that drives `reconnectingClient` rather than one connection, and so the only
  place the ladder, the held requests and the instance check have ever climbed
  anything but a duplex a test wrote.
  Dropping ONE direction rather than both is what makes the interesting case
  reproducible instead of lucky: a write sent into the dark still reaches the
  far machine and runs, and only its answer is lost, which is the exact
  condition `opLog.ts` exists for.
- **The password door, against sshd instances that take no keys at all**, in
  the same probe's `[password]` step. Two containers, one offering `password`
  and one offering `keyboard-interactive`, both with `PubkeyAuthentication no`,
  so a connection that comes up has proved which method carried it rather than
  merely that something did. It writes a real item to the login keychain with
  `security`, spawns the real helper through `SSH_ASKPASS`, and sweeps the item
  in teardown: it is the one thing a probe here touches that is not under the
  scratch `LEDGE_NOTES_ROOT`.
  It exists because §4 was WRONG about this and no test in the repository could
  have said so. The claim was that `SSH_ASKPASS_REQUIRE=force` needs no terminal
  and therefore needs no relaxation of `BatchMode`; the truth is that
  `BatchMode=yes` suppresses askpass outright. Both directions are asserted now:
  the argv the app builds connects, and the same argv with that one option back
  fails with the helper never spawned.
- **A server that stops answering while the wire stays perfect**, in the same
  probe's `[stall]` step. SIGSTOP to the daemon leaves TCP established and its
  keepalives answered, sshd answering `ServerAlive` from its own process, and
  `serve` pumping bytes into a socket whose reader is not scheduled — so every
  mechanism below the protocol reports a healthy connection, correctly, and only
  the heartbeat can see it. It reads the VERDICT rather than the recovery,
  because a held request never surfaces a reason: one plain connection, whose
  request fails in the heartbeat's own words. `--serve` carries the same
  instrument as a command, which is how a phone's twenty seconds became testable
  from a Simulator (`ios.md` §13).

What it establishes, and each of these was a claim in this document before it
was a fact: a key carrying `command="ledge-server serve"` runs that and not
`whoami`, and not a shell; a changed host key refuses the connection with
nothing offering to continue anyway; a note round-trips; the same `op` twice
makes one note; a Linux pty answers a command typed from macOS through ssh and
a daemon; a second client joins that daemon without the first being hung up on,
and each of the two is sent its own block output and its own drawer's bytes and
neither is sent the other's; a note one of them saves is pushed to the OTHER
unasked and reads back there at the same mtime, and a note both of them edit is
arbitrated on the second save, whose `divergedTo` crosses the wire and names a
trash file that really holds the version that lost; each is told the other
arrived and what it is called, and told about the other rather than about
itself; the drawer changes
hands when the second client attaches, which the first is told, by which client
id, and after which its keystrokes and its resizes are refused; and `docker
exec` reaches a container whose PID 1 is the daemon.

And, from `[drop]`: a wire that goes silent without closing is noticed, in 19
to 20 seconds against the argv `sshCommand` builds; a request made while it is
down is held rather than failed; the ladder climbs back within a second of the
wire returning and the requests it was holding are answered by the connection
that replaced the one that died; a write that had ALREADY run on the far
machine, with only its answer lost, applies once when it is replayed; and the
drawer is still the same client's, on the same daemon, carrying what the shell
printed while nobody was listening.

And, from `[stall]`: a server that stops answering is given up on in 24.9
seconds, in the heartbeat's own words, while sshd on that same machine
goes on answering ssh-keyscan throughout — so what noticed was not the wire,
and nothing under the protocol had anything to notice. The daemon that comes
back is the same run of the same process, which is what makes it a stall rather
than the crash the instance check is for.

And, from `[password]`: a password stored with `security` and read back by the
helper brings the protocol up over `password` and over `keyboard-interactive`,
against sshd instances that accept no public key at all; the same argv with
`BatchMode=yes` fails on both, with the helper never spawned; and a wrong
password ends the dial in about three seconds rather than in as many attempts as
the server allows. The password carries quotes, spaces, a `$` and a non-ASCII
character, which is the shape that breaks a `/bin/sh` helper and the shape
`security` prints back as hex.

The gap that was worth naming through phases 2 to 4 is closed: the ssh hop is
real, the sshd is real, and the forced command is enforced by sshd rather than
asserted by a test. So is the one phase 5 named after it. The first thing a
real drop found was that there was nothing to find it with — the client did not
notice at all, and would not have for two hours — which is a defect the ladder's
own unit tests could never have surfaced, because they supply the ending the
ladder is armed by. What a container on loopback still cannot supply is the
clock: the round trip is sub-3ms, so latency, a slow kex, and a laptop that
sleeps mid-build are modelled by nothing here.

The unit tests caught up afterwards, and the way they did is worth copying. A
pipe in `transport.test.ts` can be made to swallow bytes without closing, which
is the black hole exactly, and both heartbeats take their timer as a parameter —
so twenty seconds of silence, forty seconds of it on the server, and the ladder
climbing out the other side all happen in one synchronous test with no clock
anywhere in them. What still belongs to the probe is not the RULE but the
topology: which hop answers a probe is a fact about a deployment, and no test
can be written against it.

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
   The wire that actually drops, which this phase owed for a while, is the
   probe's `[drop]` step (§13). Killing a process shuts a pipe and so tells the
   client; a rule that drops the server's replies tells it nothing, which is
   what losing a network looks like, and it found that the client did not
   notice at all. `sshCommand` now asks for keepalives, and §7 carries the
   numbers.
   What is still owed: the clock. A container on loopback answers in under 3ms
   and never sleeps, so latency, a slow key exchange, and a machine suspended
   mid-session are still modelled by nothing.
6. **The iOS client**, which is `docs/contributor/ios.md` and depends on
   nothing above being redone. That document is written and none of it is code
   yet; its own §14 phases the work, starting with a move of this transport's
   portable half into `src/shared/` so a webview can run it. Writing it
   amended two sentences here, both marked below: §4's "Ledge parses no key
   material" is true of a client that spawns OpenSSH and false of one that
   links an SSH library, and §7's reconnect ladder is sized for a client the
   operating system leaves running.
