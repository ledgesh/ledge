# Ledge note locking

**Normative since 2026-07-18** — the fourth sibling standard, beside
`architecture.md` (whose seam and trust rules this feature extends),
`interactions.md` (whose §2 allocates ⌘L here and whose keymap mirrors §7),
and `testing.md` (whose categories §9 instantiates). Where this document and
the code disagree, one of them is wrong — fix deliberately.

Two amendments landed with the implementation, recorded in place below:
sealed images keep their own filenames (in-place sealing, §5 — the `.enc`
suffix lost to the never-unlink rule and reference stability), and a shared
image seals with a surfaced notice instead of refusing (§5 — a hard refusal
deadlocks locking two notes that share an image).

## 1. What it protects, and from whom

A **locked note** is a note whose body (and pasted images) are ciphertext on
disk, readable only after the user unlocks with a passphrase. The threat
model, in order of why the feature exists:

1. **Agents.** Ledge deliberately points AI agents at the corpus — MCP
   read/search/edit, the CLI, prompt fences, `$LEDGE_NOTE` deixis — and the
   body scans (`search_notes`, `backlinks`, `tags`) read every note in a
   root. A locked note's body is **never** available to an agent surface,
   even while the note is unlocked in the UI (§8). This is the headline
   behavior, not a side effect.
2. **The synced folder.** Notes roots get put in iCloud Drive, Dropbox, git.
   A locked note leaves the machine as ciphertext.
3. **Casual access.** Screen shares, shared Macs, someone at your unlocked
   laptop. The lock is also a UI state, not only a disk state.

What it does **not** protect against, stated so nobody discovers it angry:
malware running as the user (it can read Bun's memory, or wait for an
unlock), a stolen unlocked machine, and disk-level forensics on a machine
without FileVault (locking an *existing* note cannot shred the plaintext
blocks it used to occupy, nor retract plaintext versions a sync service
already captured — only born-locked notes have a clean history; the lock
dialog for an existing note says so). FileVault remains the answer for
stolen hardware; locking is not a substitute and does not claim to be.

**Profiles are out of scope, deliberately.** Profile env files are consumed
headlessly at shell spawn (CLI, open-request, drawer), so passphrase-gating
them would couple "open a terminal" to "vault unlocked" — and auto-unlocking
to avoid that would be theater. Their at-rest story, when it gets one, is
the macOS Keychain (per-item ACL, Touch ID, OS-owned crypto), shippable
independently of anything here. Until then they remain what they are:
`0600` dotenv files outside the notes root, the `~/.aws/credentials` posture.

**Whole-root encryption is a non-goal, permanently.** It kills grep, git,
external editors, Spotlight — the plain-files ethos is the product. A user
who wants an encrypted root puts it on an encrypted sparse bundle or
FileVault'd volume; the README should carry that recipe.

## 1a. What the ciphertext earns, and what the marker earns

Locking is two mechanisms, and §1's three threats do not divide between them
evenly. Stated here because the split is not obvious from the code and it
decides what any future work on this feature is for.

| Threat | What actually stops it |
| --- | --- |
| 1. Agents | The `locked:` marker. `mcpTools.ts` refuses on the note meta's flag, read from disk, with vault state irrelevant. |
| 2. The synced folder | The ciphertext. |
| 3. Casual access | The ciphertext, plus the vault being a UI state. |

**So the headline threat does not need encryption.** A plaintext
`private: true` marker would deliver the agent invariant in full, with no
passphrase, no KDF, no vault file, no rewrap sweep, and no recovery order to
get right. Everything expensive in this document is bought by threats 2 and
3 alone.

**What the ciphertext costs is the note's place in the corpus.** A locked
note is not searched, not scanned for backlinks, contributes only the tags
in its plaintext head, refuses every agent surface, and has its `prompt`
fences disabled (§8). Ledge's pitch is pointing agents at the notes, and a
locked note is the one note that is not there. That is the trade, and it is
the same trade whether the body is encrypted or merely marked.

**And locking is not where the credentials are.** API keys and tokens belong
in profiles, which are `0600` dotenv files outside every notes root and out
of scope here by §1. Locking encrypts prose. A user who locks a note
expecting their secrets to be covered has covered the wrong thing, which is
what §1's ordering is for.

**v1 ships them as one feature anyway.** Splitting into a cheap marker tier
and an encrypted tier is two things to explain, one more state per note, and
a second set of interactions, and nobody has asked for the cheap one:
architecture.md §6's bar for a knob applies to a tier as well. The split
stays available as a v2 move if the corpus hole turns out to be what people
actually mind, and this section is here so that move starts from the
analysis rather than rediscovering it.

## 2. The envelope

A locked note stays a `.md` file, so rename-not-unlink, trash, `uniqueName`,
the watcher, and every path guard keep working with zero changes. Its
on-disk shape:

```markdown
---
locked: v1.<b64 salt>.<b64 wrap-nonce>.<b64 wrapped-key+tag>
tags: finance
---
# Compensation history

<base64 of AES-256-GCM(body), 76-col wrapped; nonce prepended>
```

- **Plaintext head = frontmatter block + the H1 line.** Everything after is
  ciphertext. The head fits `headAt`'s 4096-byte label read, so `listNotes`,
  quick-open, wikilink resolution, and the sidebar need no decryption and no
  changes. The title being visible is a stated trade (§6), not an oversight.
- **Cipher: AES-256-GCM, keys from `node:crypto`.** Bun ships it; the
  dependency policy (architecture §8) is satisfied with zero new packages.
  Each note gets a random 256-bit **data key**, wrapped (AES-256-GCM again)
  by the **master key**; the body is encrypted under the data key with a
  fresh random nonce per save. The data key is stable across saves — only
  the wrap changes on passphrase change — and GCM's random-nonce bound
  (2^32 messages/key) is untouchable at autosave volumes.
- **KDF: scrypt** (`node:crypto.scryptSync`, N=2^17 r=8 p=1), passphrase →
  master key. The salt is the vault's (§3) but is **copied into every
  locked note's header**: a locked note is self-contained — synced to
  another machine or another Ledge install, it decrypts with the passphrase
  alone, no vault file required. One shared salt, so bulk unlock costs one
  KDF run, not one per note.
- **Tamper = damage, said plainly.** GCM authenticates; an external edit of
  the ciphertext fails the tag and the note surfaces as "damaged — restore
  from backup/sync", never as silently-wrong plaintext. (The mtime
  divergence guard still fires first for the common case: an external
  writer's version goes to `.ledge-trash` as ciphertext, per §3 of
  architecture.md, unchanged.)
- **The `locked:` header line is Bun-owned text.** Unlike `template:`, it is
  not a marker a text edit may toggle: a save whose buffer lacks a valid
  header, on a note whose *disk* version is locked, gets the disk header
  re-stamped and stays locked — deleting the line in the editor must not be
  a silent decrypt-to-disk. Removing the lock is exclusively the
  `note.removeLock` command (§7), which sets an explicit intent flag on the
  write. The editor renders the value dimmed/collapsed (the frontmatter
  styling layer already dims the block); the grammar joins
  `shared/frontmatter.ts` as another known key, parsed on both sides
  like the rest.
- `template:` and `locked:` are **mutually exclusive** — a template's body
  exists to be stamped out into new notes, which is the opposite of locked.
  Marking either warns and refuses if the other is present.

## 3. Key lifecycle (the vault)

- **One passphrase, app-wide** — the Apple Notes shape. Per-workspace
  passphrases would multiply prompts without changing the threat model.
- **`.vault.json`** in the app home, machine-written AND Bun-shaped like
  `.workspaces.json` (the view never sees its bytes): KDF params, the salt,
  and a key-check value (GCM over a known constant) so a wrong passphrase
  is refused without touching any note. It is a *convenience* artifact, not
  a precious one — every locked note carries its own salt (§2), so a lost
  vault file costs a re-derive, never a note. Corrupt: renamed aside for
  forensics, rebuilt from the next successful unlock's parameters.
- **An unlock checks the passphrase even when the vault is already open.**
  The answer used to be an unconditional yes whenever the key was in memory.
  No screen reaches that, because `vault.unlock`'s `when` opens the dialog
  only while the vault is shut, but `vaultUnlock` is an RPC any client can
  call and the shape is a bypass under any per-caller scoping. The check is
  one derive compared against the key in hand rather than a read of the vault
  file, so a vault file that went missing cannot turn a right passphrase into
  a refusal. A wrong one refuses and relocks nothing: relocking on a typo
  would be a way to shut another window out.
- **The master key lives in Bun-process memory only**, from unlock to
  relock. It is never written anywhere, never crosses the RPC, and dies
  with the process. The passphrase crosses the RPC exactly once per unlock
  (view → Bun, from the dialog), is used for the KDF, and is dropped; the
  dialog clears its field either way.
- **Relock**: ⌘L (§7), and automatically after 15 minutes in which the calling
  device changed no note. Both are per device, per §3a. `server.ts`'s
  `CHANGES_A_NOTE` is the list of handlers that reset the clock, applied to a
  connection's handlers in one pass, and `touchVault` is called from nowhere
  else. Two exclusions carry the rule. Reads are out because they are not a
  person: the view re-reads every open note on window focus, on a relink, and
  on the watcher's push, so an agent writing notes in the background would
  otherwise hold the vault open with nobody at the machine. Agent surfaces are
  out because they call `notes.ts` directly and never reach a handler: MCP
  and the CLI import `readNote` and `writeNote`, not `forClient`. A note
  change is the one signal left that only ever follows something a person did.
  Adding a handler that changes a note and leaving it off the list costs a
  relock while someone is working, which is the direction to be wrong in. No
  settings knob at v1: per architecture §6 a knob needs a default that
  demonstrably fails someone, and nobody has failed yet.
  Relock order matters and is fixed: flush any dirty locked buffers through
  the normal save (encrypting), *then* drop the master key and every cached
  data key, then push `vaultChanged` so the view swaps locked tabs to
  placeholders, evicts decrypted bodies, and evicts the asset data-URL
  cache (`lib/assets.ts` — RAM-only, but RAM the lock must also clear).
  On a server that push can fail to arrive: a client whose wire is down is
  not a connection to send to, and a client that cannot change a note is
  also why the timer got to fire. So the view re-asks `vaultState` on every
  reconnect and feeds the answer through the same mirror — without that, a
  remote client is the one client this eviction never reaches
  (`remote.md` §7).
- **Passphrase change** re-derives a new master key under a new salt and
  rewraps every locked note's data key and every encrypted asset's header —
  headers only, bodies untouched. It enumerates locked notes by the same
  walk `listNotes` uses, and sealed assets by `imageFilesUnder`, across
  `lockableRoots()`: every REGISTERED root but the docs one, not
  `availableRoots()`. Available only while unlocked.

  **It is all or nothing, and that is the invariant the feature rests on:
  the vault's key opens every locked item.** `changeVaultPassphrase` plans
  the whole sweep before it writes anything — `headerOpensWith` for each
  note, `sealedAssetOpensWith` for each asset's head bytes — and refuses if
  a root will not list or an item's wrap will not open. Nothing is written,
  nothing is committed, and the old passphrase still works. The plan holds
  paths and not bytes, so a note edited between the plan and the write is
  re-read rather than overwritten with a stale body.

  It has to be that way because a skip and a commit is how locking loses a
  note. The version before this one caught each failure with a
  `console.warn`, skipped an unlistable root with a `continue`, and
  committed regardless: change your passphrase with an external workspace's
  volume unplugged and its locked notes kept the old wrap while the vault
  moved to the new key. They then opened under NEITHER passphrase on that
  machine, recoverable only through §6a's probe path, while the dialog said
  "Every locked note and sealed image is rewrapped" and the notice reported
  a success count with no denominator.

  A write that fails after a clean plan (a volume pulled mid-sweep, a full
  disk) rolls the written items back onto the old key and salt, which is why
  `beginPassphraseChange` returns `oldSalt`. Rollback is best-effort by
  necessity, and what it cannot restore it names in the log: those items
  open only under a passphrase that was never committed.
- **First lock** is vault creation: a setup dialog that takes the
  passphrase twice and states the contract in one sentence — *there is no
  recovery; a forgotten passphrase is the notes, gone*. Keychain-backed
  unlock (Touch ID via Security.framework over the `pty.ts` FFI pattern) is
  the designated v2, and changes storage of nothing above — it stores the
  passphrase-equivalent, not a second key hierarchy.

  **Keychain unlock is gated on the signing identity being settled.**
  Keychain item ACLs bind to the Developer ID that signed the app, so
  changing Team IDs (the individual-enrollment to organization-enrollment
  migration, which Apple cannot do in place) invalidates every stored
  passphrase-equivalent and silently drops users back to typing a
  passphrase they may have stopped rehearsing. Ship this only once the
  Team ID we intend to keep is the one signing releases. Nothing else in
  this document depends on the signing identity; this one feature does.

## 3a. Whose unlock it is

**One key for the process, and a set of devices allowed to reach it.** The
master key is per server, as §3 describes. Who may use it is per device.

The alternative was to keep the key per process and nothing else, so that any
client of a server read what any other client had unlocked. That is the wrong
default for the shape Ledge is taking. A server is often a VPS a person keeps
for one project and reaches from a Mac and a phone, and an unlock typed on the
Mac at a desk should not open the notes on a phone that is in someone else's
hand. Every comparable tool scopes an unlock to a client: Trilium holds the
protected-session key in the browser, Standard Notes in the session, Apple
Notes behind each device's own passcode, and `sudo` defaults to one time stamp
per tty rather than one per user.

A key per device was not the answer either. The notes are one vault under one
passphrase, so a second copy of the same key protects nothing and doubles what
a memory dump yields.

**What a device is.** `Hello.device`, resolved by `bun/transport.ts` to
`client` when a peer names none. On a Mac it is the id that machine already
keeps per connection (`clientHome.ts` `clientIdFor`), shared by every window
including the blank second ones, so a new window does not ask for the
passphrase again. On a phone it is the client id, which is that phone. A peer
that predates the field gets the fallback, which scopes an unlock more
narrowly than the sender meant and never more widely.

**Where the gate is.** At the handler, in `bun/server.ts`, which is the only
layer that knows who asked:

| What | How it is scoped |
| --- | --- |
| `vaultState` | `vaultStateFor(device)`, so a phone says `locked` while the Mac reads |
| `vaultUnlock`, `vaultCreate` | authorize this device; the passphrase is checked either way |
| `vaultLock` (⌘L) | this device only; the key drops when the last device goes |
| Idle relock | per device, on the same 15 minutes |
| `noteRead`, `assetRead` | `mayOpen` false gives the withheld shape a shut vault gives |
| `noteLock`, `noteRemoveLock` | refused outright (`NEEDS_THE_VAULT`) |
| `vaultChangePassphrase` | refused in its `error` field, which the dialog shows |
| `noteWrite`, `noteStash`, `noteMove` | refused for a locked note (`refuseLockedFrom`) |
| `vaultChanged` | pushed per client, each as its own device sees it |

The three refusals in that table ask `vaultState() === "unlocked"` first, so
each only ever adds the case a process-wide key cannot see. With no key in the
process the old refusals stand, in their own words, and a machine that has
never locked anything pays nothing: without that short-circuit
`refuseLockedFrom` would put an `isNoteLocked` read in front of every save on
every install.

`notes.ts` and `assets.ts` stay process-wide and decrypt on the key in hand.
Threading a device into them would put the same parameter on every internal
caller, and the callers that would have to fill it in are not devices: the
scans, `moveNote`, `daily.ts`. `mayOpen` is the one bit that crosses, defaulted
to true, and `server.ts` is the only caller that passes it.

A passphrase change leaves the authorized devices authorized. They were let in
by the person changing it, on that person's own devices, and shutting them
would relock a phone as the side effect of a settings change on a Mac.

**⌘L shuts one screen, not every screen.** Walking away from a Mac says
nothing about the phone in your pocket, and a lock that reached across devices
would be one person stepping on their own toes. When the last device locks, the
key goes, so a vault nobody is holding open is not left decryptable in memory.

**A device id is asserted, not proved.** The transport is what authenticates:
an ssh key on the Mac, an enclave key on the phone (`remote.md` §4a). A client
that can reach the server at all could name another device's id, but ids are
random and no client is ever shown another's. So per-device unlocking raises
the bar for a paired device somebody else is holding. It does not defend
against a hostile client that already has the key to the front door, and
nothing in §4's seam policy relies on it.

## 4. Seam policy

The survey fact this design leans on: every content path funnels through
`readNote`/`writeNote` in `bun/notes.ts`, with `headAt` as the only other
byte-reader. Locking is those seams plus refusals:

- **`readNote`**: locked + vault unlocked → decrypt, return plaintext (and
  the real `mtimeMs` — identity untouched). Locked + vault locked → return
  the locked shape (head fields, no body); the caller renders a
  placeholder, never ciphertext.
- **`writeNote`**: a locked note's save re-splits the incoming text at the
  head boundary, encrypts the body under the note's data key, re-stamps the
  Bun-owned header (§2), and rides the existing temp-plus-rename — so
  plaintext bytes never exist on disk, mid-save or crashed. The
  `baseMtimeMs` divergence guard is unchanged; the trash copy it takes is
  ciphertext.
- **`headAt`/`metaAt`**: no change — the plaintext head is designed to be
  exactly what they read. `NoteMeta` grows a `locked` flag next to
  `template`, carried live through the note lists to the sidebar glyph, the
  pickers, `list_notes`, and `ledge ls`.
- **The body scans skip locked notes and say so.** `searchNotes`,
  `backlinksTo`, `tagsIn`, `notesTagged` skip locked bodies *whether or not
  the vault is unlocked* — scans feed overlays and agents alike, and a scan
  that answered differently depending on vault state would leak by timing
  and confuse by inconsistency. Each returns a `lockedSkipped` count; the
  overlays render it as one muted footer line ("3 locked notes not
  searched"). Titles still match everywhere titles are searched (⌘P), since
  titles are plaintext.
- **Wikilinks TO a locked note resolve** (titles are plaintext; the `[[`
  picker lists locked notes with the glyph). `[[Title#Heading]]` into a
  locked note degrades to top-of-note while locked — the same degradation a
  deleted heading already gets. Links FROM a locked body are simply not
  scannable while it is locked; the backlinks panel's footer count covers
  it.
- **The watcher, trash, layout, and retitle need nothing.** `fs.watch`
  reads filenames; trash moves ciphertext verbatim and TTL purge works
  without unlock; `.layout.json` persists paths only (titles already leak
  via filenames, §6); retitle is a rename of a file whose H1 is plaintext.
- **A locked tab is a placeholder, not an editor.** Body, outline (⌥⌘O has
  no headings to derive), and terminals wait for unlock — v1 keeps "locked"
  meaning one thing rather than a matrix of half-open states. Opening a
  locked note (tab click, ⌘P, wikilink, CLI open-request) interposes the
  unlock dialog when the vault is locked; unlock loads the body into the
  pooled editor and the tab becomes an ordinary tab. Frontmatter spawn
  params on a locked note are plaintext by design — the user chose to put
  them in the visible head — and apply normally once unlocked.

## 5. Assets

An image pasted into a locked note is routinely the most sensitive thing in
it. Assets are therefore in scope from v1, with one structural decision:

- **Asset data keys are wrapped by the master key, not a note's key.**
  `.ledge-assets/` is a per-root shared pool and an asset may be referenced
  from several notes; keying it to one note breaks the second reference.
  Master-key wrapping means any unlocked session decrypts any encrypted
  asset, and the envelope (magic bytes, version, salt, wrap-nonce, wrapped
  key, body nonce, GCM ciphertext) is self-contained like a note's (§2).
- **Encrypted at birth, IN PLACE, under the asset's own name.** A paste into
  a locked note writes ciphertext from the first byte; a sealed image is
  detected by its magic header, never by a filename. (The design originally
  said `.enc`; implementation showed the suffix loses on every axis: a
  rename-to-suffix transition would need the one asset unlink the
  never-unlink rule forbids, and rewriting `![](…)` references would churn
  note bodies. Same-name sealing keeps references stable, needs only the
  ordinary temp-plus-rename, and an external tool still fails loudly — the
  bytes are not a PNG and no longer pretend to be.) Because encryption
  happens at write, the deliberate never-unlink orphaning of assets
  (architecture §3) stays a storage quirk and never becomes a privacy leak.
- **`readAsset` is the one decrypt seam** — images already cross the RPC as
  base64 and become data URLs view-side, so display needs no new plumbing.
  Locked vault (or a plaintext note referencing an encrypted asset): the
  widget renders a locked-image placeholder; unlock makes it an image. The
  view-side data-URL cache is evicted on relock (§3).
- **Locking an existing note sweeps its referenced assets**: each in-root
  image reference is sealed in place (temp-plus-rename; the reference text
  never changes). References are note-relative (architecture.md §3), so both
  sweeps resolve each note's references against that note's own folder and
  compare the RESOLVED PATHS. Comparing the strings would be wrong in a way
  that matters here and nowhere else: the same file is `.ledge-assets/x.png`
  from a note at the root and `../.ledge-assets/x.png` from one in a folder,
  the shared-image notice below would go silent, and Remove Lock would unseal
  an image a still-locked note displays. An asset an *unlocked* note also
  shows is sealed anyway and SURFACED as a notice naming the sharing notes
  — never refused, because a refusal deadlocks the legitimate "lock both
  sharing notes" flow (each blocks on the other), and never silent, because
  the sharing note's images now need an unlock to view. Sealing merely
  extends the lock's own visibility rule to the shared image everywhere it
  appears: the other note's widget shows the locked face while the vault is
  closed and the real image while it is open — nothing breaks. Rare by
  construction either way, since paste allocates unique names and sharing
  only happens by hand. Removing the lock reverses the sweep for assets no
  other locked note still references.
- **The pasteboard caveat, documented not hidden**: the osascript paste
  path writes a transient temp PNG before ingest. It is unlinked
  immediately, but it existed; the FileVault sentence in §1 covers the
  residue, and the docs say so.

## 6. What stays visible (stated trades)

- **The title** — as the filename (was always visible), the H1, and
  everywhere titles appear: sidebar, ⌘P, wikilinks, `list_notes`. This is
  what keeps navigation, linking, and labeling working with no decryption.
  A user whose *title* is the secret should title the note blandly; the
  setup dialog's one-line help states the trade ("Title and front matter
  are not encrypted"). Opaque filenames are a possible v2, not a v1
  promise.
- **The frontmatter** — spawn params, tags, the favorite marker. A tag on a
  locked note is visible in the tags panel by design (it is in the plaintext
  head, where the user put it), and the same head is why Favorite works on a
  locked note with the vault shut: the line goes in beside the tags and no
  body is read or written (`bun/notes.ts` favoriteNote).
- **Existence, mtime, size** — file metadata is the filesystem's.
- **Pre-lock history** — sync services and backups keep the plaintext
  versions they already took (§1).

## 6a. One vault, one person: sharing is a non-goal, recovery is not

**A locked note does not travel between people, and v1 will not make it.**
The passphrase is one, app-wide (§3), and `unwrapDataKey` uses the single
master key in memory rather than re-deriving from the note header's own
salt. So a recipient who already has a vault cannot open a locked note that
arrived from somebody else, with either passphrase: their own unlocks their
vault but will not unwrap the foreign data key, and the sender's is refused
by their vault's check value before it gets that far. Probed against the
real code paths, both outcomes, both directions.

Making it work means per-recipient keys, which means public keys, which
means an identity model. Ledge has none and is not getting one for this: the
sharing story is a git remote (docs/user/19), and a secret meant for a
collaborator belongs in a profile, which never enters a notes folder
(architecture.md §6a). Say the non-goal rather than half-building it.

**The self-contained envelope is for one person on another machine**, which
is what §2 claims and all it claims. That case is recovery, it works, and it
is the reason the salt rides in every header and every sealed asset.

| Restoring locked notes from git, S3, or any backup | Result |
| --- | --- |
| Onto a machine with no vault yet | Opens. `vaultUnlock` probes `firstLockedHeader`, derives from the note's own salt, and adopts it as the vault's. |
| Onto a machine that already minted a vault, same passphrase | **Does not open.** The probe runs only at `vaultState() === "none"`, and a fresh vault has a different salt, so the same passphrase yields a different master key. |
| Restore that includes `.vault.json` (what `backup-paths` produces) | Opens, whatever the machine had before. |

**So the order matters, and only the user can get it right: restore before
locking anything new on the new machine.** The middle row is the trap, it is
silent, and the passphrase being correct is what makes it convincing. Two
things answer it and both are cheap: `backup-paths` already carries
`.vault.json` (`bun/backup.ts` excludes only the socket, the pid, the logs
and the docs mirror), and `unwrapDataKey`'s error names the case instead of
saying "damaged". A code fix that re-derived per note header would mean
holding more than one master key, which is §3's model, not a patch.

**The probe unlock adopts the sender's key material, which is why the
non-goal is stated rather than left implicit.** `unlockVault`'s probe path
ends in `saveVaultFile(header.salt, key)`, so a recipient with no vault who
opens somebody's shared note has a vault built from that person's salt and
passphrase. Everything they lock afterwards is wrapped under it. Probed:
the sender's passphrase then decrypts the recipient's own private notes.
Nothing in the UI says so. That is tolerable only because §6a's first
sentence means this is not a flow Ledge offers, and because the manual states
the outcome where a reader looks for it (docs/user/13, "Sharing locked
notes"), which it did not before: it claimed the passphrase made no
difference.

## 7. Interaction spec

Written to interactions.md's grammar; merges there when the feature lands.
All commands live in the registry (`commands/keys.ts` / `registry.ts`) like
every other action; tooltips derive; palette carries everything (R1).

| Command | Key | Notes |
| ------- | --- | ----- |
| Lock Notes | ⌘L | relocks the vault now — the walking-away gesture, which is why it earns a chord: of the free ⌘ letters, L is the mnemonic one (Lock; ⌥⌘L backlinks is unrelated and stays). Flush-then-drop per §3; no-op when nothing is locked or the vault is already locked. Page and editor domains (window-dispatched; CodeMirror does not bind ⌘L) |
| Unlock Notes… | — (palette) | opens the passphrase dialog proactively. The dialog is otherwise *interposed*: opening a locked note while the vault is locked prompts in place (the host-picker move — always-ask is the point, so the act that needs the key asks for it). Wrong passphrase shakes and stays; Escape/dismiss opens nothing |
| Lock This Note… | — (palette) | two-faces pair with Remove Lock (exactly one shows, per the note's live state — the template-marker move). First lock ever runs vault creation (§3: passphrase twice, the no-recovery sentence). Then one confirm, always, carrying the §1 history caveat: encrypting now cannot retract the plaintext a sync service, a backup, or a git commit already holds. It is not a §4-destructive confirm and it is not asking whether to lock; it is the only place that sentence can be said to somebody who is about to believe otherwise. The confirm comes AFTER the passphrase dialog when one interposes, the same order Remove Lock uses: the unlock proves identity and nothing more. Sweeps the note's assets on the way (§5) |
| Remove Lock… | — (palette) | decrypts note and solely-referenced assets back to plaintext, behind one confirm — not because data is destroyed (it is not; this is not §4-destructive) but because the consequence is silent *exposure*: the next sync/agent scan sees the body. Requires the vault unlocked; command-only, never a text edit (§2) |
| Change Vault Passphrase… | — (palette) | §3 rewrap; unlocked only; reports the count rewrapped |

- **The passphrase dialogs are §6 layer kind 2** (dialogs, beside confirm
  and the profile editor): Escape dismisses topmost-only, window keymap
  suppressed while open. Focus lands in the passphrase field; the field
  clears on close regardless of outcome.
- **Row treatment**: locked notes wear the Lock glyph in the sidebar icon
  column and ⌘P rows — the column's grammar grows one entry: file = note,
  layout = template, calendar = daily seed, **lock = locked**. The lock
  *opens* (LockOpen) while the vault is unlocked, both surfaces: the row is
  where "readable right now" is visible without opening anything, and it is
  what makes ⌘L's effect legible in the list. Tabs stay plain except the
  locked-placeholder face, which is its own evidence. No bare-key row verb
  (locking is a rare act, and bare keys are for the verbs a row does daily),
  but the sidebar row's context menu carries the two faces target-scoped to
  the row — plus, on a locked row, the vault verb matching the glyph's
  state: Unlock Notes… while shut, Lock Notes (⌘L) while open.
- **No settings knob** ships with v1 (§3's relock default; architecture §6
  bar applies to any future knob argument).
- **Overlay footers**: ⌥⌘P search, backlinks, and tags panels render the
  `lockedSkipped` count as one muted line — the skip must be visible where
  the answer would have been.
- **Prompt fences in a locked note keep their run buttons, disabled, with
  the reason as tooltip** (§8) — the busy-button grammar (blocks.ts
  setBusy): a gray button with no reason is a mystery, and a *missing*
  button beside the sh fence's live pair is the same mystery, quieter. The
  run chords answer with the same sentence in the notice strip, not
  silence — a swallowed chord diagnoses nothing.

## 8. Agent surfaces (MCP, CLI)

**The invariant: no agent surface returns locked plaintext, ever, and no
Ledge affordance sends it to one — vault state is irrelevant to agents.**
The lock is *for* them (§1), and it holds
by architecture rather than by policy checks sprinkled per tool: every MCP
tool routes through `bun/notes.ts`, and the CLI dispatches through the MCP
handlers and "cannot acquire semantics the tools lack" (architecture §1) —
so refusing at the notes.ts seam refuses everywhere at once.

- `read_note` / `append_note` / `edit_note` on a locked note fail with
  steering text, not a bare error: *"This note is locked; its body is not
  available to agents."* — the initialize-instructions lesson: what a tool
  says is what steers the agent.
- `search_notes` / `backlinks` / `tags` skip locked bodies and carry the
  skipped count in their result text, so an agent knows its answer is
  scoped rather than complete.
- `list_notes` and `ledge ls` carry the flag (`(locked)`), because agents
  plan against listings.
- `create_note` cannot create locked notes and `daily_note` never
  instantiates from one (§2's marker exclusivity covers the template side).
  There is no CLI unlock verb, deliberately: the CLI lives in terminals
  where agents live, and a passphrase argument would land in shell history
  and process tables. Unlock is the app's dialog, only.
- **A ` ```prompt ` fence is the third agent surface — the send direction.**
  Its whole contract is "pipe this body to the agent CLI", so in a locked
  note it does not run: the run buttons render disabled on prompt fences
  there, carrying the reason as their tooltip (the busy-button grammar —
  §7), ⌘↩/⇧⌘↩ with the caret inside one surface the same sentence as a
  notice ("Prompt blocks can't be run in locked notes") instead of silently
  no-oping, and Bun's `runBlock` re-validates —
  the two-ended move: a session whose admitted note is locked refuses
  language `prompt`, whatever the view asked. Scoped to the `prompt`
  language deliberately: other runnable fences are the user's own compute
  (a locked ops note's commands are the point), and a user who maps some
  other language to an agent CLI, or types `claude` in the drawer, has left
  Ledge's affordances for their own shell — which the lock never claimed to
  police (§1).

## 9. Testing (per testing.md)

- **Unit (colocated `bun test`)**: envelope round-trip; wrong passphrase
  refused via key-check; tamper fails the GCM tag; header grammar in
  `shared/frontmatter.ts` (`locked:`, both-sides parse); head/body split
  stability; marker exclusivity.
- **Invariant tests, scratch root**: after lock-and-save, the note file and
  the whole root contain no plaintext substring of the body (byte grep —
  the test that keeps "encrypted" honest); the divergence-guard trash copy
  is ciphertext; a save whose buffer dropped the header stays locked;
  agent-surface refusals (mcpTools tests: read/append/edit refuse, scans
  skip and count, vault unlocked or not); asset paste under a locked note
  writes no plaintext bytes.
- **e2e (headless WebKit)**: interposed unlock flow (open locked note →
  dialog → body appears); wrong-passphrase stays; ⌘L swaps open locked
  tabs to placeholders and evicts (re-open prompts again); footer counts
  render; palette two-faces pair shows the right face; a prompt fence in a
  locked note renders its run buttons disabled with the reason as tooltip
  and its chord surfaces the notice (bash fences beside it still run live).
- **Live probe (testing.md §6, scratch `LEDGE_NOTES_ROOT`)**: the paste
  seam end-to-end (pasteboard → `.enc` on disk → rendered after unlock),
  since osascript and the pasteboard are native seams the harness cannot
  fake.

## 10. Phasing

1. **Vault core**: `bun/vault.ts` (KDF, envelope encode/decode, key cache,
   idle relock), `.vault.json`, RPC additions per the architecture §7
   recipe (`vaultState`/`vaultCreate`/`vaultUnlock`/`vaultLock` +
   `vaultChanged` push), unit tests.
2. **Note seams**: `readNote`/`writeNote`/`headAt` behavior, the Bun-owned
   header rule, `NoteMeta.locked`, lock/remove-lock commands and dialogs,
   the placeholder tab face, ⌘L, invariant tests, e2e.
3. **Scans and agents**: skip-and-count in the four scans, overlay footers,
   MCP/CLI refusal text and flags.
4. **Assets**: encrypt-at-birth, `readAsset` decrypt, placeholder widget,
   lock-time sweep and conflict surface, cache eviction, live probe.
5. **Passphrase change**, docs merge into the siblings, README's
   sparse-bundle recipe for the whole-root crowd.

Each phase leaves the app shippable; nothing in 3–5 blocks 1–2 landing.
