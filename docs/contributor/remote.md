# Ledge remote servers

**Partly implemented: §14 phases 1 to 3 are code, and everything about
resilience, Linux, and iOS is still design.** The connection grammar §8
called for now lives in `interactions.md` §4-1, and the state ownership §5
describes is the code's. What remains design is reconnect, `opId` dedupe,
output coalescing, binary frames, the Linux PTY port, and the iOS client.
This is a sibling standard beside `architecture.md` (whose process topology,
trust boundary, and state-ownership rules it revises), `interactions.md`,
`locking.md` (whose vault moves one hop away), and `testing.md` (whose
categories §13 instantiates). Code that disagrees with it is either ahead of
the doc or wrong.

It records two amendments to `architecture.md`, both in §5: `.window.json`
has left the server for the client (done), and pasted asset bytes will cross
the wire (§3's "the bytes never cross the RPC" holds only for a local
server; it lands with the binary frames in phase 4, and until then the
pasteboard image is the one `osascript` call site left on the server).

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
| Mac app, local notes | the server in this process, or a child on pipes |
| Mac app, remote notes | `ssh <target> ledge-server serve` |
| iOS app, your Mac | `ssh <target> ledge-server serve` |
| iOS app, your VPS | `ssh <target> ledge-server serve` |

The Mac app connecting to its own local server is not a special case. It is
the same client, the same protocol, and the same server binary, over a
cheaper transport. Keeping it that way is what stops the remote path from
becoming a second, less-tested code path.

**The local transport is a child process's pipes, not a unix socket.** The
protocol rides stdin and stdout either way (§3), so a socket would add a
filesystem artifact, a stale-socket sweep, and a permissions question, and
buy nothing until the server has to outlive the client. That day is §7's
"sessions outlive connections" taken one step further, to sessions surviving
an app restart; the socket lands with the reconnect work in §14 phase 4, and
until then a quit takes the server down exactly as it does today.

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

The codec is `shared/wire.ts` and the two ends of a connection are
`bun/transport.ts`, which is where the symmetry lives: a server dispatches
`req` frames into the handler map `createServer` returned, and a client
presents the answers as that same map, so `bun/index.ts` binds either one to
the webview's RPC without knowing which it got. Type-1 frames are defined and
decoded but nothing sends one yet; moving the base64 payloads onto them is
§14 phase 4's, and defining the type now is what keeps that from being a
protocol break.

**Multiplexing is required, not optional.** The schema is already
bidirectional: `terminalOutput`, `runEvent`, `terminalExit`, `notesChanged`,
`vaultChanged`, and `openExternal` are server-initiated. Frames carry a
request id and are interleaved freely; nothing in the protocol is
request-response ordered.

**Terminal output coalesces.** `index.ts` pushes `terminalOutput` per chunk
today, which is free locally and a frame storm at 60ms of latency. The
server buffers on a frame budget and flushes on a deadline. The scrollback
ring (§7) is the authority for anything a client missed.

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
| PTYs, sessions, scrollback | server | §7 |
| The watcher | server | pushes `notesChanged` as today |
| Behavior settings (shell, interpreters, trash TTL, daily workspace) | server | facts about that machine |
| Appearance settings (theme, font sizes, `editor.livePreview`) | **client** | facts about that screen |
| Window frame (`window.json`) | **client** | amends `architecture.md` §6 |
| Clipboard, rich paste, link opening | **client** | §10 |
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
possible screens. That is what `Hello.client` is for, and it is why the
protocol version is 2.

**The client home is `.client` inside the app home**, not a second top-level
directory: on every machine Ledge ships to, the client and its local server are
the same user on the same disk, so one `~/.ledge` to back up beats two. It
holds the id, the connection list, Ledge's own `known_hosts`, the client's
`settings.jsonc`, and `window.json`. Deriving it from `APP_HOME` also means
`LEDGE_NOTES_ROOT` moves the client's files too, which is what lets a scratch
probe run without touching the real ones.

**Pasted asset bytes now cross the wire, amending `architecture.md` §3.**
`assetPaste` reads the pasteboard Bun-side today and returns only the
markdown reference. A remote server has no pasteboard. The client reads its
own, sends the bytes as a type-1 frame, and the server writes, seals, and
names the file. What the client still does not do is name it: `uniqueName`
and the `.ledge-assets` guard stay server-side, so the amendment costs one
byte path and no authority.

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
`attached` gates whether output is pushed, and `terminalAttach` replays the
buffer. Nothing about that design needs changing; it needs relying on.

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

**Mutating calls carry an `opId` and the server dedupes them.** A client that
retries a write after a reconnect must not apply it twice: the second attempt
would find its own bytes on disk, fail the `baseMtimeMs` divergence guard,
and trash-copy the user's own save. Each mutating request carries a
per-connection monotonic id; the server keeps a short window of completed
ids and returns the recorded result instead of re-executing. The divergence
guard then means what it has always meant, which is that somebody else wrote
the file.

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
and no simultaneous connections. Each is individually plausible and
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

**`ledge <title>` on a server reaches the connected client.** The open-request
file (`bun/openRequest.ts`) stays exactly as it is for the local case. When a
client is attached, the server also pushes `openExternal` over the live
connection, which is the message the view already handles. A request expires
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

**Five RPC entries are the client's outright** and never become frames
(`bun/clientSeams.ts`, whose `CLIENT_METHODS` is the list both ends read):
`clipboardWrite`, `clipboardRead`, `clipboardReadRich`, `linkOpen`, and
`menuSet`. Opening a URL happens on the device the user is holding, not on the
VPS, and a headless server handed the view's menu would swallow ⌘Q with it.
The five connection entries (§8) join them for a different reason: a server
has no business knowing which servers this client can reach.

The server implements all ten as REFUSALS rather than omitting them, because
the handler map is total by construction; reaching one means a client forgot
its overlay, and `{text: ""}` back from a clipboard read would look exactly
like an empty clipboard until somebody went looking. One `osascript` call site
remains on the server, `assetPaste`'s pasteboard image, and it leaves with the
binary frames in §14 phase 4.

## 11. Deployment and portability

**The server ships as one binary** (`bun build --compile`) for macOS arm64
and Linux x64/arm64, and as a Docker image for the hosts that want one. Build
the image on debian-slim rather than alpine: the PTY layer is `bun:ffi` over
`posix_spawn` and `forkpty`, and musl is a fight that buys nothing.

**Clients install and upgrade the server the way VS Code Remote does.** The
client connects, reads the server's version from the handshake, and offers to
push a matching binary when it is missing or mismatched. A user who prefers
to manage it themselves runs the same binary from a package.

**The handshake is the first frame in each direction** and carries the
protocol version, the schema version, and the build. A schema mismatch
refuses the connection with the two versions named and the upgrade offered.
It does not negotiate a subset: a partially-understood protocol is how
silent data-shaped bugs happen.

**One module has to port to Linux**, and it should be spiked before anything
else in §13 is committed to. `pty.ts` and `ptyNative.ts` reach libc through
`bun:ffi`, and glibc differs from libSystem on symbol availability, on
`forkpty` living in libutil, and on struct layouts. `architecture.md` §8's
`libledge_pty.dylib` gains a Linux sibling built by the same script. The rest
of `src/bun/` is `node:fs`, `node:crypto`, and TypeScript.

The compiled-in docs corpus (`bun/docsContent.ts`) ships with the server, so
a VPS serves the manual that matches its own version.

## 12. The round-trip budget

**No interactive path costs more than one round trip.** Every call is free
in-process today and costs 40ms or more against a VPS, so this is the rule
that decides whether the whole design feels like software or like a remote
desktop.

What it means in practice:

- **The server pushes; the client does not poll.** `notesChanged` already
  works this way. Nothing new may be built on a timer.
- **The note list and tag set are client-side caches**, invalidated by
  watcher pushes rather than re-fetched per keystroke. Wikilink resolution
  already resolves view-side against the store's metas and is the model to
  copy, not an exception to it.
- **Batch instead of iterating.** A restore that opens six tabs sends one
  request, not six. Anything that loops an RPC call over a list is a bug at
  this boundary.
- **Assets cache by content.** `assetRead` per image per render is a round
  trip per image; the data-URL cache `locking.md` §3 already evicts on relock
  is where the answer lives.
- **Writes echo locally.** The editor is the authority on what the user just
  typed. A save is optimistic, and the divergence guard arbitrates the rare
  disagreement, as it does now.

An interactive path that cannot meet the budget gets a stated exception in
this section, not a quiet extra round trip.

## 13. Testing

Per `testing.md`'s categories:

- **Unit (colocated `bun test`)**: the frame codec (length, type, partial
  reads, oversized frames); handshake version negotiation and refusal; the
  `opId` dedupe window; terminal-output coalescing; the settings split and
  its migration.
- **Invariant tests, scratch root**: every §2 guard still refuses when the
  call arrives over the transport rather than in-process, which is the test
  that keeps "the client is the least-trusted end" honest;
  `"../../.ssh/id_rsa"` throws over the wire exactly as it throws today; a
  forced-command key cannot obtain a shell; a replayed write applies once.
- **e2e (headless WebKit)**: the harness gains a real server over an
  in-process transport beside `FakeStore`, so the same specs run against both
  and disagreements surface as failures rather than as drift; connection
  switching tears down and rebuilds workspace state; a dropped connection
  replays scrollback on reattach.
- **Live probe (`testing.md` §6, scratch `LEDGE_NOTES_ROOT`)**: a real
  `ssh localhost ledge-server serve` round trip, since ssh, the forced
  command, and host-key pinning are native seams the harness cannot fake.
  Then the same probe against a Linux box, for the PTY port.

## 14. Phasing

Each phase leaves the app shippable.

1. **Done.** `bun/server.ts` is the headless core and `bun/index.ts` is the Mac
   shell around it. No user-visible change, and the whole existing suite was
   the regression test.
2. **Done.** The framed protocol (`shared/wire.ts`), the handshake, and both
   ends of a connection (`bun/transport.ts`), with `bun/serve.ts` as the
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
4. **Resilience**: reconnect, `opId` dedupe, output coalescing, binary frames
   for assets and terminal output (which is what moves `assetPaste` to the
   client and leaves the server with no `osascript` at all), the unix socket
   for a server that outlives the app, and the §12 round-trip audit against a
   real remote.
5. **Linux**: the PTY port, the second dylib, the Docker image, the VPS
   posture in `docs/user/`.
6. **The iOS client**, which is its own document and depends on nothing above
   being redone.
