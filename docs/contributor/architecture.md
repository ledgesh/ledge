# Ledge architecture & boundaries

Normative rules for where code lives, what may talk to what, and which
invariants hold at each boundary. `interactions.md` governs how actions
are exposed to the user; this document governs how the code underneath is
allowed to be shaped. Like that one, a rule here is normative: code that
disagrees with it is wrong, or the rule is — change one deliberately.

## 1. Process topology

Two processes, one contract:

- **Bun main process** (`src/bun/`) owns everything with side effects on the
  machine: the filesystem (`notes.ts`), the PTYs (`pty.ts` via bun:ffi), and
  the system clipboard. It has no UI.
- **WKWebView** (`src/mainview/`) runs the React app. It owns everything the
  user sees and no machine state at all.
- **`src/shared/`** is the contract between them — `rpc-schema.ts` plus the
  few pure helpers both sides need (`slug.ts`). It imports from neither side,
  ever: a shared module that reaches into `src/bun` or `src/mainview` has
  stopped being the contract and become a participant.

Every crossing rides the typed Electrobun RPC defined in
`src/shared/rpc-schema.ts`. There is no second channel: no direct filesystem
access from the view (the webview cannot), no untyped message bus beside the
schema. Each schema entry carries a comment saying what it is for and when it
fires — the schema doubles as the protocol's documentation, so an uncommented
entry is an undocumented protocol change.

Two more entry points exist beside the app. The first is **the MCP server**
(`src/bun/mcp.ts`, `bun run mcp`), a separate process that agent CLIs spawn
over stdio to read and write notes. It is not a third participant in the RPC —
it never talks to the running app — but it is Bun-side code under Bun-side
rules: every tool routes through `bun/notes.ts` and the workspace registry, so
the path guards and filesystem invariants have one definition however a caller
arrives. Being a separate process, it re-reads the registry file on every tool
call (one small JSON read) rather than holding the app's load-time snapshot — a
workspace attached mid-session is visible to agents without a restart. Its
protocol is a hand-rolled JSON-RPC subset (`initialize`/`tools/*`, one
message per line; §8's stance — the SDK earns its place if resources or
prompts ever join), its stdout belongs to that protocol (logs go to stderr),
and its tool set grew in deliberate tiers: reads first, then additive writes
(`create_note` — plain text, or `template` + `title` to instantiate an
existing note as the body (`shared/template.ts`: `{{date}}`-class
substitution, H1 forcing, and the `template: true` marker stripped so
instances are not templates; `bun/daily.ts` resolving the template by
title — ANY note's title works, the marker being discovery for the pickers
and `list_notes`' flag, not permission); `daily_note` — create-or-open
today's LOCAL-date note, idempotent
where `create_note` is never-clobber, which contract split is why it is its
own tool; `append_note` — end of note, or targeted at a heading's
section via the same fence-aware ATX grammar the `[[note#heading]]` reveal
uses, `shared/wikilinks.ts`; either way a trailing run of ` ```prompt `
blocks stays last — those are the note's controls, and appends land above
them), then revision (`edit_note` — exact-match text replacement, unique
occurrence required unless `replace_all`; the one write that can touch the
H1 and so retitle a note) — all through
the store, so an agent's write gets H1-slug naming via `uniqueName` (agents
never choose filenames) and rides `writeNote`'s `baseMtimeMs` divergence
guard, and the running app perceives it as an ordinary external edit through
its watcher (the external-edit safety work is what made these tiers
acceptable at all). Title-addressed reads reuse
`shared/wikilinks.ts` — the same resolution the editor uses, hoisted to
shared/ for exactly this second consumer. Called with no target at all,
`read_note`/`backlinks` fall back to `$LEDGE_NOTE` — the note whose terminal
the agent was launched from, stamped into every note shell's spawn (§2) and
inherited down the agent → server process chain — so "the note I am sitting
in" needs no argument. `$LEDGE_WORKSPACE` rides the same chain and makes
"here" work too: `create_note` defaults into it, and an ambiguous title
resolves there first, before the global newest-first pass — the same scoping
the current note's own wikilinks get. The server's initialize `instructions`
state both facts outright (this note is X, this workspace is Y), because
that context is what actually steers an agent; tool-description hints alone
proved not to. The last agent seam is in-note: a ` ```prompt ` fence is
runnable by default (`blocks.runnable`), mapped in `blocks.interpreters` to
`claude -p <` — the trailing redirect feeds the block body to the agent CLI
on stdin from the note's own shell, so the run inherits the note's cwd, env,
and the `$LEDGE_NOTE`/`$LEDGE_WORKSPACE` facts, and closes the loop: a note
can hold a prompt that reads and writes notes. No new machinery earned its
keep here — it is one default entry in an existing map (the settings comment
documents the redirect trick and how to point it at another CLI).

The second is **the CLI** (`src/bun/cli.ts`, `bun run cli`, `ledge` once the
shim is installed) — the same third-process pattern taken one step further:
its note verbs dispatch through the MCP server's own tool handlers
(`bun/mcpTools.ts`), so the CLI cannot acquire semantics the tools lack, and
both stay gated by the registry and `assertNote` with one definition. It
adds two things of its own. **Cwd deixis**: a working directory inside a
registered root is "here", folded into the `$LEDGE_WORKSPACE` chain (§2)
the handlers already honor rather than a parallel rule. And **the open
request** (`bun/openRequest.ts`): `ledge <title>` resolves the title
CLI-side, writes `.open-request.json` in the app home (temp-plus-rename),
and launches/activates the app; the app consumes it — read, delete,
re-guard the path like any view-supplied one — via an app-home watcher
while running and the `openRequestTake` pull at boot (the pull exists
because a boot-time push could fire before the view listens). A file, not a
socket, deliberately: external actors already reach the app through the
filesystem (the watcher), and a request file needs no always-listening
ingress. Requests expire (60s) — "open this now" is not a standing
instruction — and every invalid request costs exactly itself. The `ledge`
shim on PATH (`bun/cliShim.ts`; `ledge install`, or the app's Install Shell
Command palette entry) execs the exact runtime and entry that wrote it —
the bundle's own bun against `Resources/app/bun/cli.js` (prebuilt by
`build:cli`, placed by `build.copy`), or the dev machine's bun against the
checkout — and refuses to overwrite anything that is not recognizably its
own output. Verb conventions, deixis, and output discipline are
interactions.md §9's.

## 2. The trust boundary

**The view is the least-trusted end of the RPC.** Not because it is hostile,
but because it is the end where a bug becomes an arbitrary argument: a stale
path in a closure, a confused target, an injected string in a note's heading.
Bun therefore validates everything and derives anything derivable:

- **The workspace registry is a trust artifact.** Notes live in REGISTERED
  WORKSPACE ROOTS (`bun/workspaces.ts`), and every path guard validates
  against that set — so what may join it is itself part of the boundary. A
  root gets in exactly four ways: Bun's own first-launch default, a managed
  folder whose name Bun slugged from a display name (`workspaceCreate` — the
  view names no path, the same move as `noteCreate`), a directory the user
  picked in the NATIVE folder dialog (`workspaceAttach`, which takes no
  arguments: the path comes from the OS dialog Bun-side, never from the
  view), or Bun's own in-memory-only docs root (§3b — registered for the
  read paths, refused by every write). A registered root RELOCATES under the same rule: `workspaceMove`
  carries only the root — the destination parent is the native dialog's
  pick, Bun-side, or Bun's own APP_HOME for the `home: true` return trip —
  and Bun renames the folder and rewrites the registry line in place
  (`moveRoot`, which re-runs every registration guard against the
  destination). The registry file `.workspaces.json` is machine-written
  AND Bun-shaped; the view cannot read or write its bytes. No root may
  equal or contain another (rootContaining must have a unique answer), or
  reach the app home itself.
- **Every path arriving over RPC is checked before use.** Scoped calls
  (`noteList`, `noteCreate`, `noteSearch`, `trashList`, `trashEmpty`, the
  asset pair) carry a root checked for exact registry membership
  (`assertRegisteredRoot`). Per-note calls send only the path: `assertNote`
  (inside a registered root *and* a `.md` file) gates every view-supplied
  note path; `assertTrashed` — strictly tighter: a `.md` file *directly
  inside its root's* `.ledge-trash` — gates the two calls that can unlink.
  `"../../.ssh/id_rsa"` must throw, and there is a test saying so. The `.md`
  requirement is load-bearing, not tidiness: an in-root write of any other
  file would be arbitrary-file storage in a folder the user syncs.
- **The view never names a file.** It sends a note's *text*; Bun slugs the
  heading itself (`slugOf` emits only `[a-z0-9-]`), so filenames are safe by
  construction and there is no name parameter to validate or smuggle through.
  Workspace folder names get the same treatment (`createManaged` slugs the
  display name; renaming a workspace is display-only and touches no folder).
- **Paths are opaque handles.** The view holds only paths and roots it was
  handed by Bun (`workspaceList`, `noteList`, `noteCreate`, `noteDelete`'s
  trashed location) and passes them back unmodified. View code that
  constructs or edits a path is a bug. Wikilinks (`[[Title]]`,
  `editor/wikilinks.ts`) are the worked example of staying inside this rule:
  they address a note by TITLE — deliberately, because filenames follow the
  H1 and a stored path would rot on every retitle — and resolve entirely
  view-side against the store's `noteList`-provided metas, scoped to the
  note's own workspace. Following one dispatches `openNote` with a path Bun
  already vouched for; no link-derived string ever crosses the RPC.
- **Spawn params are the one deliberate exception** to "the view never names
  anything": `sessionConfigure` carries a cwd, env vars, and file references
  the view parsed out of a note's frontmatter (`shared/frontmatter.ts`). This
  grants the view nothing new — `runBlock` already executes arbitrary code as
  the user, and a shell's own `cd`/`export`/`source` can do everything these
  params do — but the discipline that keeps it safe is narrow and must stay
  so: the values flow **only** into the child shell's spawn
  (`bun/spawnParams.ts`), Bun never reads, returns, or acts on them itself
  (beyond the cwd `stat` and the env-file reads that feed the spawn), and the
  one value that becomes a filename — the profile name — is re-validated
  Bun-side with the same predicate the parser used (`isProfileName`), because
  the parser's check is a typo message and only Bun's is a guard.
  `sessionConfigure` also carries one FACT beside the frontmatter params: the
  note's own path (`notePath`), which Bun admits only after proving it is a
  `.md` inside a registered root, then stamps into local spawns as
  `LEDGE_NOTE`/`LEDGE_WORKSPACE` — *after* every user env layer, the TERM
  move, so no frontmatter (or profile, or envFile) can forge where a shell
  claims to live, and a session with no admitted fact gets the names scrubbed
  rather than whatever a layer smuggled in. This is the deixis agents ride:
  a CLI launched in a note's terminal inherits `LEDGE_NOTE`, and the MCP
  server's `read_note`/`backlinks` default to it when called with no
  arguments.

## 3. Filesystem invariants

- **`rename(2)` is the primitive; `unlink` is the exception.** Saves are a
  temp-file-plus-rename (atomic within a filesystem: a crash mid-save leaves
  the old note or the new one, never half). Delete is a rename into the
  note's OWN root's `.ledge-trash` — per workspace root, not one shared bin,
  so the move never crosses a filesystem (no EXDEV on an external volume)
  and a restore lands back in the workspace it left. Retitle is a rename. Restore
  is a rename. Moving a workspace (`moveRoot`) is ONE rename of the whole
  folder — cross-volume is refused (EXDEV surfaces the move-in-Finder-then-
  attach recipe) rather than becoming copy-then-unlink of every note, and
  the destination name comes from `uniqueName` like every other rename
  target. Detaching a workspace touches no file at all: the registry
  line goes, the folder stays, re-attachable. Exactly three code paths
  unlink a *note* — `deleteTrashed`, `emptyTrash`, `purgeTrash` — all in
  `bun/notes.ts`, all gated by `assertTrashed`, and the first two sit behind
  a confirmation (interactions.md §4). **Anything new that unlinks a file
  joins all three lists: the guard, the confirm, and this sentence.** (The
  one other `unlink` in the repo is `writeNote` discarding its own temp file
  after a failed save — a dotted file it created moments earlier that no
  listing ever shows.)
- **Bun never mkdirs an external root.** A managed folder (a direct child of
  the app home) is Bun's to recreate; an external root that is missing is
  what an unmounted volume looks like, and mkdir-ing it would grow a shadow
  directory on the boot disk that silently catches autosaves. Operations on
  a missing external root refuse (`rootReady`), the edit stays pending in
  the view's autosave retry, and the registry keeps the entry unavailable so
  a remount heals at the next boot.
- **A save never silently flattens an external edit.** The notes folder is
  shared ground — agents in the note's own terminal drawer, git, anything
  with a shell writes there — so `noteWrite` carries the disk version the
  view last saw (`baseMtimeMs`; tracked per open note in `notes/store.ts`,
  seeded by the read, advanced by every write). On a mismatch with genuinely
  different bytes, the buffer still wins the live path — its author is the
  one typing — but the disk version is first MOVED into the root's
  `.ledge-trash` (through `deleteNote`, so it joins no unlink list), never
  overwritten in place: a concurrent edit costs a trip to the Trash section,
  not the edit. Identical bytes just adopt the disk mtime; a null base (a
  note edited before its first read landed) writes blind, as every save did
  before the guard. The read direction is symmetric: open notes with a CLEAN
  buffer follow their file (`reloadCandidates`/`reseedDoc` in
  `notes/store.ts` decide, `editorPool.reloadOpenNotes` pours; a reload
  re-seeds the slug tracking, so a disk-side H1 edit relabels the tab but
  renames nothing — the rename rule stays "a heading you edit here"), while
  a DIRTY buffer is left alone for the write guard to arbitrate. Reloads are
  driven by the per-root `fs.watch` (`bun/watch.ts` → the `notesChanged`
  push, debounced, filtered to note-shaped entries outside dot-directories)
  with the window-focus refresh as the belt; an unwatchable root (unmounted
  volume) degrades to focus-refresh only, warned, like every other
  unavailable-root path. `rename(2)` overwrites
  silently, so no call site may pick its own destination name: `uniqueName`
  (case-insensitive, because APFS is) allocates against a `readdir` snapshot
  plus the `reserved` set, and the rename that follows is safe *because* the
  allocation already skipped every taken name. A rename whose target didn't
  come from `uniqueName` is a latent data-loss bug.
- **Ledge's writes into a workspace folder are `.ledge-`prefixed dot-entries**
  (`.ledge-trash`, `.ledge-assets`). A workspace can be someone's real
  project folder, so the app's own entries must be unmistakably the app's:
  pastes must not mingle into a project's existing `assets/`, and — because
  APFS is case-insensitive by default — a plain `.trash` would collide with
  macOS's own `~/.Trash` if anyone attached their home directory, putting
  the system trash's `.md` files under Ledge's Empty Trash. The prefix is
  the namespace.
- **Dot-entries are invisible, and so is what `.ledgeignore` names.**
  `listNotes` skips dot-entries (which is what hides `.ledge-trash` and the
  temp files) and prunes the well-known vendor/build directory names plus
  the root's own `.ledgeignore` patterns (`bun/ignore.ts` — a small
  gitignore subset, defaults overridable with `!name`), so an attached
  project folder contributes its notes, not every README under
  node_modules. Search is built on the same walk, so listed and searchable
  cannot disagree. Ignoring is visibility, not a guard: an ignored note
  that is already open still saves — the path guards stay registry-based.
  Trash operations touch only `.md` files directly in `.ledge-trash`; Empty
  Trash removes exactly what the list showed, and nothing it did not.
- **Images are files under their workspace root, and Bun's alone to touch**
  (`bun/assets.ts`). Pasted images land in `<root>/.ledge-assets/` — per
  root, so a note's `![](.ledge-assets/x.png)` resolves against its own
  folder and an external workspace carries its images with it. Saves are
  the same temp-plus-rename as notes, names come from `uniqueName` (same
  clobber-safety), and **nothing ever unlinks an asset**: deleting a note
  orphans its images, deliberately — cheaper than joining the unlink list
  above. The view reads them over `assetRead` with the asking note's root,
  whose guard (`assetPathOf`) is assertNote's move inverted: a registered
  root, in-root, an image-extension allowlist (without which the call would
  read any note), and no dot-entries except `.ledge-assets` itself as the
  first segment (the shared `ASSETS_DIRNAME` constant — the view's
  classifier carves the same exception, from the same constant). Any
  non-dotted in-root image works too: an attached folder's own
  `img/photo.png` renders as-is. On paste the bytes never cross the RPC —
  `assetPaste` reads the pasteboard Bun-side and returns only the
  markdown-relative reference; the view never names the file.
- **The session log** (`logs/ledge.log`, `bun/log.ts`) is the app's only
  account of itself on a machine that is not this one: Electrobun's launcher
  forwards the main process's stdout on the DEV channel only, so in a shipped
  build every console line goes to /dev/null and "it just closed" is the
  whole bug report. `startLogging()` runs first in `bun/index.ts` and **tees
  the console** — a global mutation, chosen over a logger module every call
  site imports because it also catches Electrobun's own output, including the
  `uncaughtException` handler it installs, which logs and then force-exits.
  Appends are synchronous for exactly that reason: the last line has to be on
  disk before the exit. Rotation is per LAUNCH, not per day (`ledge.log` →
  `ledge.previous.log`), because relaunching is the first thing anyone does
  after a crash and the dead session has to survive it; a 4 MB cap rotates
  early rather than truncating, so what survives is the recent end. The
  **view** forwards its own failures over `logAppend` (`mainview/lib/log.ts`:
  `window.onerror`, unhandled rejections, `console.error`, capped per
  session) — WKWebView's console reaches only the Web Inspector, so a render
  error is otherwise a blank pane and nothing else. It is in the app home,
  not `~/Library/Logs`, so `LEDGE_NOTES_ROOT` isolates it from every probe.
- **`LEDGE_NOTES_ROOT`** overrides the APP HOME (`~/.ledge` — where
  `settings.jsonc`, `.layout.json`, `.workspaces.json`, `.window.json`,
  `logs/`, and
  the managed workspace folders live; `APP_HOME` in `bun/workspaces.ts`) for tests and
  throwaway runs. The env name predates the per-workspace split and is kept:
  every preload and probe already speaks it. Nothing in the app sets it;
  every `bun test` run gets a scratch one via preload, and anything that
  exercises the real app against real files must set it (see
  `testing.md` §§2, 6). **`LEDGE_PROFILES_DIR`** is the same override
  for the profiles dir (§6a), for the same reason: no test or probe may
  read — or seed — the real one.

## 3a. Note locking

Per-note encryption — the vault, the envelope, the readNote/writeNote seam
behavior, the agents-never-read invariant, and the sealed-image sweep — is
its own sibling standard: **locking.md**. It rides the invariants above
(temp-plus-rename writes, rename-not-unlink trash, the assertNote guards)
rather than amending them; the two facts worth knowing from here are that
`bun/vault.ts` owns keys and byte shapes (node:crypto only, §8-clean), and
that `.vault.json` in the app home is machine-written AND Bun-shaped like
the registry — a convenience artifact, not a precious one, since every
locked note carries its own salt.

## 3b. The built-in documentation

User docs and tutorials are Markdown notes served through the app's own
machinery — a page renders, searches, wikilinks, and RUNS its fenced blocks
exactly like a note — from one special root that can never be written:

- **The docs root** is `APP_HOME/.ledge-docs` (`DOCS_ROOT` in
  `bun/workspaces.ts`): dotted and `.ledge-`prefixed like every app-owned
  entry, so it can never collide with a managed workspace slug. It is
  registered **in memory at every load**, kind `"docs"`, and never written to
  `.workspaces.json` — it is a fact about the installed app, not a user
  choice. `attachExternal`, `detachRoot`, and `moveRoot` all refuse it, and
  `ensureDefault` does not count it (a docs-only registry still creates
  scratch).
- **The corpus is compiled into the binary** (`bun/docsContent.ts`, text
  imports of `docs/user/*.md`). Manifest filenames carry a numeric prefix
  (`01-getting-started.md`): the note browser sorts the docs workspace by
  path instead of title (`NoteBrowser.tsx`), so the numbering is the manual's
  reading order — no order field travels the RPC, and titles stay clean.
  Pages are authored one line per paragraph (no hard 80-column wraps: the
  editor soft-wraps, and a hard wrap renders as a broken line) and synced
  into the docs root at every launch
  (`bun/docs.ts syncDocs`): byte-matching pages are left untouched, differing
  ones rewritten temp-plus-rename, and pages the manifest dropped are RETIRED
  by rename into `.ledge-docs/.retired/` — the sync owns no unlink. The folder
  is machine-written like `.layout.json`: an external edit to a page is
  overwritten at the next boot, deliberately, because stale docs describing an
  older Ledge are worse than a lost annotation in a folder every surface
  labels read-only.
- **`assertWritableRoot` (bun/workspaces.ts) is the read-only gate**, applied
  at every mutating store seam — `writeNote`, `createNote`, `retitleNote`,
  `deleteNote`, `restoreNote`, `lockNote`/`removeLockNote`, the asset paste —
  so the app, the MCP tools, and the CLI get one refusal however they arrive.
  **Anything new that writes, renames, or moves a note (or an asset) calls it
  on its root** — the write-side sibling of §3's unlink sentence. The
  "sole workspace" deixis uses `writableRoots()` for the same reason: an
  agent's default create target must never resolve to a folder that refuses
  writes. Reads deliberately stay whole: `list_workspaces` reports the docs
  root (kind and all), scans include its pages, and `read_note` serves them —
  agents may read the manual.
- **The view renders it as the hidden Documentation workspace**: opened by
  `docs.open` (interactions.md), present in `state.workspaces` like any
  workspace (panes, tabs, search, and persistence just work) but filtered
  from the strip and ⌘1…9, its mutating verbs gated by `when`s, and its
  editors created read-only (`editor/setup.ts`: a transaction filter drops
  every doc change that is not a disk load, which is what lets the editor
  stay focusable — caret, ⌘C, find, and ⌘↩ block runs all still work). The
  view's gating is presentation; Bun's guard is the enforcement.

## 4. Identity keys: path vs docId

A note has two keys with two lifetimes, and they are never bound to each
other:

- **`path`** is the identity of the *file*. It changes on retitle and on
  trash/restore.
- **`docId`** is the identity of the *live session*: the pooled CodeMirror
  editor and the note's shells (the persistent inline-run shell plus any
  overflow shells for concurrent runs, and the terminal drawer). It is
  born when a tab opens — before the note has a file at all — and dies when
  the tab closes.

Renaming a file must not kill the shell running inside it; that is the whole
reason these are separate keys. Code that derives one from the other, or uses
a path where a session is meant, is re-fusing them.

## 5. State ownership

Three tiers, chosen by lifetime and by who needs to see the state:

- **The reducer store** (`workspace/store.tsx`) holds the document model:
  workspaces, panes, tabs, the known notes and trash lists. Everything in it
  is data another part of the app reacts to. The reducer and its tree helpers
  (`tree.ts`) are pure and carry the largest test suite in the repo — which is
  why ephemeral UI state must **not** be lifted into it: every field added to
  `AppState` is a field every reducer test now carries.
- **Component `useState`** holds ephemeral chrome: open/closed drawers,
  hover, in-flight confirms, rename-in-progress. If nothing outside the
  component reacts to it, it stays in the component.
- **The DOM itself** is the source of truth for focus and for what a keystroke
  targets: list rows publish `data-target-kind`/`data-target-*` and the
  dispatcher reads them back off the focused element (`commands/target.ts`).
  Do not shadow focus in React state — the DOM already owns it, and a copy
  can only disagree.

**The `configureX` pattern** is the standing answer to "module A needs a
capability that module B owns, and importing B would drag in React, the RPC,
or the editor stack." The owner registers handlers into a module-level
`Partial<Handlers>` (merged with `Object.assign`, so two owners can each
register their own fields without clobbering the other); callers reach the
capability through the module, which throws or no-ops when unconfigured.
Five instances exist and new needs should look like them: `configureBridge`
(editor ⇄ runs), `configureTerminal`, `configureNotes` (persistence ⇄ RPC),
`configureClipboard`, `configureUi` (commands ⇄ component-owned UI).
`main.tsx` and the owning components do all the wiring; that is what keeps
`notes/store.ts` and `commands/registry.ts` testable without a webview.

## 6. Settings

User preferences live in one JSONC file, `settings.jsonc`, in the app home —
GLOBAL, not per workspace: shell path, font sizes, and interpreters are facts
about the person, not the folder. JSONC because the file is hand-edited with
its comments AS the documentation (the seeded template, `SETTINGS_TEMPLATE`,
explains every knob in place); comments and trailing commas are tolerated by
one shared stripper (`shared/jsonc.ts`) that both ends use, so Bun's launch
parse and the settings editor's live validation cannot disagree about what
the text means. An install that predates the format keeps its `settings.json`
— renamed to `settings.jsonc` on first load (rename, never copy: one file
stays the user's file, and JSON is valid JSONC so the bytes are already
right). `shared/settings.ts` owns the shape, the defaults, the template, and
the validator; `bun/settings.ts` owns the file. Bun reads it once at launch,
applies its own half (the shell every PTY spawns, the trash TTL), and hands
the view a validated snapshot over `settingsGet`; view consumers (editor and
terminal font sizes, the appearance, the runnable-fence set) read that
snapshot at construction time through `lib/settings.ts`.

- **What earns a setting.** The same shape of bar as the dependency policy
  (§8): every setting is a behavioral fork the app tests and maintains
  forever, so one exists only where the hardcoded default demonstrably fails
  someone — not because a value *could* vary. The full current set: shell
  path/args, editor and terminal font size, the appearance
  (`appearance.theme`: `"system"` follows the Mac and stays the default —
  the two forced values exist because the OS appearance demonstrably fails
  people for whom it is not a preference: a Mac on the automatic day/night
  schedule flipping a notebook mid-session, a room or projector where one
  side is unreadable, a screenshot that has to match. See "One appearance,
  one attribute" below), the live-preview toggle
  (`editor.livePreview`: it exists as the escape hatch, not a preference —
  raw markdown is the app's original deliberate stance, and precise syntax
  editing demonstrably needs a way back to text-on-screen-is-text-on-disk),
  trash TTL, runnable fence languages, and the fence-language → interpreter
  map (`blocks.interpreters`, applied Bun-side by `bun/runner.ts`; it exists
  because "which python" has no universal answer — the default resolves via
  the login shell's PATH, and a venv or pinned toolchain demonstrably needs
  to override that), plus its per-machine refinement
  (`blocks.hostInterpreters`: host-pattern → language map, merged over the
  base for runs a note's `host:` sends elsewhere — the same "which python"
  fact, which can have a different answer on prod than here. `*` globs cover
  numbered fleets; matching sections merge in file order, later wins;
  resolution is `interpretersFor` in `bun/runner.ts`. It lives in settings,
  not frontmatter, because a machine's toolchain layout is one fact about
  one machine, identical in every note that targets it), and the daily
  workspace (`daily.workspace`: it exists because the deixis default —
  selected workspace in the app, cwd at the CLI — demonstrably scatters
  daily notes for anyone with more than one workspace, and "where is
  today's note?" is the feature's one promise; it stays a KNOB because a
  workspace is not a note — there is no corpus object to carry the fact. A
  value naming no registered root degrades warned). Additions should be
  argued in those terms. The boundary also runs the other way — corpus
  data must not become a knob: WHICH notes are templates briefly lived
  here as a title list (`templates.notes`), and WHICH note seeds the daily
  as a title field (`daily.template`); both were retired for the
  `template:` frontmatter marker (`true`, or `daily` for the ⌘J role),
  because config naming notes by title needed hand-editing, applied at
  relaunch, and went stale against the notes it described, while the
  marker is edited where the note is, read live off the note lists
  (`NoteMeta.template`), travels through renames, and is stripped at
  instantiation. parseSettings still recognizes both retired spellings by
  name and answers with the migration hint rather than "unknown section".
- **Settings are not session state, and neither is the registry.** Four
  files in the app home, four ownership shapes. `settings.jsonc` is
  *human-edited preference*. `.layout.json` — which workspaces exist, their
  names and icons, which folder each owns, the pane trees — is
  *machine-written state* whose bytes Bun owns (`bun/layout.ts`:
  temp-plus-rename like a note save, and a JSON-parse gate so the view
  cannot use the fixed-name write as arbitrary byte storage) but whose
  SHAPE the **view** owns (`workspace/persist.ts`: serialize debounced on
  every layout change, restore at boot). `.workspaces.json` — the set of
  registered roots — is machine-written AND Bun-shaped, because it is a
  trust artifact (§2): the view never sees its bytes at all. `.window.json`
  — where the window was last left — is machine-written and Bun-shaped for a
  duller reason (`bun/windowFrame.ts`): the window is not a thing the view
  has an opinion about, so no RPC entry exists for it and it never crosses
  the boundary. Its one rule is that a saved frame is *evidence, not
  coordinates* — `fitFrame` re-checks it against the displays attached right
  now, keeping the size but re-centering a window stranded by an unplugged
  monitor, because a window restored where no pointer can reach it is worse
  than not persisting at all. Failure modes
  differ accordingly: a corrupt settings file is left for its author; a
  corrupt layout costs itself, degrading per piece down to a fresh
  `initialState`; a corrupt registry is renamed aside (bytes kept for
  forensics) and rebuilt from `ensureDefault`; a corrupt window frame is
  simply the default frame. The view's restore path
  self-heals per workspace: an unregistered folder costs its workspace, an
  UNAVAILABLE one (unmounted volume) is held dormant — dropped from the
  session, carried verbatim through saves — and restored tabs only ever
  open paths their own folder's boot `noteList` returned (paths stay opaque
  handles, §2; a tab can never cross into another workspace's folder).
  Never mix the files.
- **The file is the UI — and Ledge is its editor.** There is no settings
  panel; ⌘, (`settings.open`) opens the file in an in-app dialog
  (`components/SettingsEditor.tsx`: a modal CodeMirror over the raw JSONC,
  highlighted in the note editor's own palette), the same move as the
  profile editor and over the same-shaped RPC pair
  (`settingsRead`/`settingsWrite` — the view never names the path). First
  launch (or first ⌘,) seeds the commented template, so what opens
  documents every knob; a drift test pins the template to
  `DEFAULT_SETTINGS`. The dialog previews launch-time validation live —
  same stripper, same `parseSettings` — but only ADVISES: Save writes the
  text byte-for-byte, ungated, because a mid-edit save must not be refused
  and launch already degrades gently. Saves still apply at the next launch;
  the dialog says so instead of pretending otherwise.
- **Validation degrades per field, and never rewrites.** A bad value costs
  that field (warned, defaulted — `parseSettings`); unparseable JSONC costs
  the whole file for the run but the bytes on disk are untouched: it is the
  user's file, possibly mid-edit, and "fixing" it would destroy their work.
- **One appearance, one attribute.** Nothing asks `prefers-color-scheme`
  directly any more — with an override in play the media query is no longer
  the truth. `mainview/lib/theme.ts` is the single resolver
  (`resolveAppearance(theme, systemDark)`, the pure core its spec covers);
  it stamps the answer as `data-theme` on `<html>`, which is what the whole
  palette keys off (`index.css`, both the shadcn tokens and the editor
  variables) and what tailwind's `dark:` variant is pointed at
  (`darkMode: ["selector", '[data-theme="dark"]']`). Consumers holding
  COLORS rather than reading variables — the two xterm instances — take
  `isDarkAppearance()` at construction and `onAppearanceChange` for the
  rest; new ones must do the same rather than opening their own
  `matchMedia`. `index.html` stamps the system answer inline before first
  paint (so a launch never flashes the wrong palette; the override cannot
  be known until the snapshot lands, when `applyAppearance()` re-stamps),
  and the media listener stays for the life of the app: under `"system"`
  the OS can still move, and that is the OS changing, not the setting.
- **Restart-applies, deliberately.** Both sides read once at launch; there is
  no `settingsChanged` message and no live reload. Live-applying would mean
  every consumer becomes reactive (rebuild CM themes, re-font live xterms,
  respawn or leave stale shells) — a standing tax on every future setting,
  paid to save one relaunch. Revisit only if editing settings becomes a
  frequent act, which for this set it is not.

## 6a. Per-note params (frontmatter) & profiles

A note may open with a YAML-subset frontmatter block naming the parameters
its shells spawn with:

```markdown
---
cwd: ~/Projects/ledge        # working dir; ~ expands, missing dir -> $HOME + warning
env:                         # inline non-secret vars
  NODE_ENV: development
profile: petstore            # named secrets scope (see below)
envFile: ./.env              # project-owned dotenv, resolved against cwd
host: web1 deploy@prod       # machines blocks may run on (ssh destinations / "local")
template: true               # this note is a template: offered by ⌥⌘N, marker stripped at instantiation
                             # (value `daily` additionally claims the ⌘J role for ITS OWN workspace: per-workspace, never borrowed across roots)
---
```

(`tags:` also lives in the block — shared/tags.ts's other tag source — and,
like `template:`, never feeds a spawn: both ride the one parser because the
block has one grammar, not because the shell cares.)

`shared/frontmatter.ts` owns the grammar (hand-rolled per §8; per-line
degradation like `parseSettings`); `bun/spawnParams.ts` owns what the values
mean at spawn. Precedence is `process.env` < `envFile` < `profile` < `env`,
with `TERM` pinned back afterwards — xterm.js is the terminal whatever a note
claims. The base layer is first scrubbed of *host-terminal identity*
(`CMUX_*`, `GHOSTTY_*`, `ITERM_*`, `TERM_PROGRAM`, `TMUX`, …): the app
inherits those from whatever terminal launched it, and inside a Ledge PTY
every one is a false fact — cmux's `claude` shim, for one, keys on
`CMUX_SURFACE_ID` to inject session hooks that then fail in sessions cmux
never owned. Scrubbed base-layer only, so a note that wants one back can set
it in `env:`. The split of duties across the boundary: the **view** parses the
block (it holds the text) and sends the params over `sessionConfigure`,
keyed by docId; **Bun** stores them per session and reads them each time one
of that session's shells spawns — persistent, overflow, and terminal drawer
alike, which is what keeps all three telling one story about the note.

- **Settings vs frontmatter.** `settings.jsonc` is app-wide preference;
  frontmatter is a per-note fact that travels with the note — open it
  anywhere, same cwd, same env. A knob belongs in frontmatter only when the
  right value genuinely varies per note (cwd, env); a knob that varies per
  person stays in settings. Neither is session state (§6 still applies).
- **An external workspace anchors the default cwd.** A note that names no
  `cwd:` of its own spawns shells in its workspace's folder when that
  workspace is an attached external directory — attaching a project folder
  is mostly *about* its shells starting in the project. Managed
  `~/.ledge/<slug>/` workspaces have no default (a shell born inside a
  hidden dotfolder helps nobody): their notes keep `$HOME`, exactly as
  before workspaces had folders. The merge is view-side and implicit — no
  per-workspace knob, no persistence: `notes/store.ts` (`syncParams`) fills
  the empty cwd from `workspace/channel.ts`'s kind map, which records each
  root's kind as its handle enters the view. Bun neither knows nor cares:
  `resolveCwd` validates whatever arrives, so an unmounted external folder
  degrades to `$HOME` with a warning like any stale frontmatter cwd.
- **Profiles are the secrets story.** `profile: name` resolves to
  `~/.config/ledge/profiles/<name>.env` — one small file per project scope,
  never one global pile. The note carries only the *name*; the values are
  resolved Bun-side at spawn and never exist in the webview process (the
  editor dialog below is the one deliberate exception, and it masks them).
  The dir is deliberately **outside the notes root**: `~/.ledge` is the
  folder people sync and back up, and layout, not crypto, is what keeps a
  synced notes folder from carrying credentials. Files are created `0600`,
  seeded self-documenting. The name is safe by construction (`isProfileName`:
  no separators, no dots) — the same trust move as `slugOf`.
- **Ledge's own dialog is the profile UI** ("Edit Note Profile…", the edit
  button pinned after the profile name, or ⌘-click the name itself — all →
  `components/ProfileEditor.tsx`, over the `profileRead`/`profileWrite`
  RPCs). The in-app dialog was forced here first — macOS binds no
  application to `.env`, so handing the file to the OS editor dead-ends
  with LSApplicationNotFound — and settings later adopted the same shape
  (§6). The two dialogs differ where the files do: settings show the raw
  text because its comments are the documentation; profiles show masked
  KEY=value rows because their values are secrets. The file stays a
  plain dotenv on disk — greppable, hand-editable — and dialog saves go
  through `serializeDotenv` (`shared/dotenv.ts`), which preserves comments
  and untouched lines byte-for-byte, so hand edits and dialog edits coexist
  rather than compete. Values render masked by default: the dialog must not
  become the place secrets end up on screen after all.
- **`host:` puts a note's shells on another machine — as ssh's client,
  never its replacement.** The PTY stays local; a remote shell is
  `ssh -t <host> '<cd/export preamble>; exec …'` as the pty's child
  (`bun/remoteSpawn.ts`), so auth (agent, passphrase prompts, 2FA, host
  keys) happens in the terminal exactly as it would anywhere, Ledge holds
  no credentials, and connection reuse is the user's `~/.ssh/config`
  (ControlMaster), not ours. The declared list is an **allowlist enforced
  Bun-side** (`resolveHost` in `bun/index.ts`, re-applying the parser's
  `isHostName` — the same two-ended move as profile names): a run may only
  name a declared host, and with more than one declared the view interposes
  the host picker on every run (interactions.md). What crosses the wire is
  narrow by design: cwd (a `cd` in the preamble, `~` anchored to the
  *remote* home) and inline `env` (documented non-secret). `profile` and
  `envFile` are **local-only** and warn — a secret on a remote command line
  would sit in that machine's process table. Inline runs exec `bash -l`
  remotely (the marker hook installs under zsh or bash — `markerInit` is
  written portable for exactly this — and bash is the one shell ~every
  server has); block bodies reach the remote /tmp in-band, base64 through
  the shell itself (`bun/runner.ts` remote mode), so no second connection
  and no quoting surface. Interpreted fences resolve their interpreter from
  the *remote* PATH — `bun` there means the remote's bun, and a machine
  without one fails with its own "command not found" — with
  `blocks.hostInterpreters` (§6) as the per-machine override when a host's
  toolchain lives somewhere the base map does not name. Persistent inline
  shells are per (note, host) (`bun/inlinePool.ts`), so `cd` still carries
  across consecutive blocks aimed at the same machine. The terminal drawer
  runs the user's own remote login shell; its host is fixed at spawn and
  shown as a badge. Known limits, accepted: a non-POSIX remote *login*
  shell (fish, csh) works only for notes with no cwd/env preamble, and
  inline runs need bash on the remote.
- **The pty's child is ssh, and three rules follow from that.** They are
  easy to get wrong because each looks right until a real connection is on
  the other end (all three were live-tested into existence; testing.md §6).
  *Writes never block:* the master fd is `O_NONBLOCK` and `pty.ts` queues
  what the tty refuses, because a remote block's body arrives as one long
  line and a tty in canonical mode — which every shell is until it says
  otherwise — will take a line and then wait forever for a reader that
  cannot read a partial one. A blocking write there stops the whole main
  process. *Interrupt travels as the ^C character, not a signal*
  (`interruptViaChar`): the foreground process group on the local tty is
  ssh, so signalling it ends the connection and the note's remote cwd with
  it, while the character reaches the remote tty and stops the block.
  *A shell that never starts its block gets to speak* (`SILENT_MS` in
  `bun/inlinePool.ts`): everything outside a C..D marker pair is normally
  dropped as echo, but ssh talks before the shell exists, so a run silent
  past the grace period streams the shell's own bytes to its panel — which
  already takes keystrokes, so a host-key question can be answered there.
- **Restart-applies, like settings.** Params are read at shell *spawn*; a
  live shell keeps the cwd/env it was born with, and an edited frontmatter
  takes effect on the session's next shell. The "Restart Note Shell" command
  is the deliberate escape hatch: kill the note's shells, keep its params,
  respawn lazily. (This is also why an overflow shell spawned after a
  frontmatter edit can be newer than the persistent one — each shell reads
  the params at its own birth.) For remote hosts this is also how a
  drawer's shell moves machines: restart, reopen, pick again.
- **Everything degrades, nothing throws.** A missing profile, a stale cwd, a
  bad env name each cost themselves — warned in the Bun log, and the shell
  still spawns. A dead Run button diagnoses nothing.

## 7. Adding an RPC method

The recipe, in order, using `trashDelete` as the worked example:

1. **`src/shared/rpc-schema.ts`** — add the entry with a comment saying what
   it does and when it fires.
2. **`src/bun/notes.ts`** (or the owning bun module) — implement it. Validate
   the path first (`assertInRoot` / `assertTrashed`); decide the failure
   semantics deliberately (already-gone is usually success, not an error).
3. **`src/bun/index.ts`** — bind the handler to the schema entry.
4. **View channel shim** (`notes/channel.ts` etc.) — add the handler to the
   `Handlers` interface and export a typed wrapper. This step is what keeps
   view logic testable: tests stub the handler, never the RPC.
5. **`src/mainview/main.tsx`** — bind the shim to the live RPC.
6. **The action layer** (`notes/actions.ts`) — the async orchestration that
   calls the shim and dispatches store actions.
7. **Tests** — the bun-side guard (a `rejects` test needs no filesystem) and
   the stub added to any test that implements the full `Handlers` interface
   (`notes/store.test.ts` will tell you by failing to typecheck).

The compiler walks you through 3–7 once 1 and 4 are written; that is the
point of the typed schema.

## 8. Dependency policy

**Hand-rolled over imported, for UI primitives.** ContextMenu, ConfirmDialog,
QuickOpen/palette, RenameField, ResizeHandle, useListNav are ours; they total
less code than a library's config would, and they follow this repo's rules
(layers.ts Escape handling, registry-derived chips) that a library would have
to be fought into. The existing dependency families — React, CodeMirror,
xterm, Tailwind + the shadcn utilities, lucide icons, Electrobun — are the
approved set. A new dependency needs a reason the existing set genuinely
cannot cover, stated in the PR/commit that adds it; "it has a nicer API" is
not one. (This was a deliberate choice, not an accident of history.)

Dev-only tooling gets the same test but a lower bar, since it never ships:
`@playwright/test` is in because nothing in the existing set can execute a
real DOM (`testing.md` §5) — the canonical example of a reason that
clears it.

Bun-side: prefer `bun:ffi` and POSIX over native modules — node-pty is out for
exactly this reason; the PTY is posix_spawn + poll.

**The one compiled artifact: `libledge_pty.dylib`.** Two things the PTY cannot
do through `bun:ffi` alone are C trampolines — `login_tty` between fork and
exec (a controlling terminal, hence Ctrl-C) and a fixed-arity
`ioctl(TIOCSWINSZ)` (resize, since bun:ffi mis-marshals variadics on arm64).
Their source and signatures live in `bun/ptyNative.ts`, one declaration for
two consumers: `scripts/build-native.ts` compiles them to a universal dylib
that the copy map ships beside `index.js`, and `pty.ts` dlopens that file,
falling back to compiling the same text in-process with bun:ffi's TinyCC.

The build-time compile is the point, not an optimization. TinyCC needs the
macOS SDK's headers, and a Mac with no Xcode and no Command Line Tools has
none — an ordinary state for a machine that downloads an app rather than
building one. There, the in-process compile fails, and it fails quietly in the
worst possible place: Ctrl-C stops working in every terminal and resize
becomes a no-op. Compiling on the build machine, which has the SDK by
construction, moves that dependency off the user's. The dylib is signed by the
same script (electrobun signs the bundle without `--deep` and only sweeps
`*.node`, so nothing else in the pipeline would sign it, and an unsigned
Mach-O in the bundle fails notarization), and it declares
`-mmacosx-version-min` because clang otherwise stamps the build machine's
macOS as the floor.

A third native module needs the same bar as any dependency. Two exist because
the alternative was a broken terminal, not because compiled code is on the
table generally.

**Every dependency is also an attribution.** MIT, BSD, and ISC all ask that
their notice travel with the binary, so adding one to `dependencies` means
regenerating `THIRD-PARTY-NOTICES.md` (`bun run licenses`) and committing it in
the same change. The file is the app's, not the repository's: `docsContent.ts`
compiles it in as the manual's last page and `docs.licenses` opens it, because
a notice the user's copy does not carry is a notice that did not ship.

Two rules the generator (`bun/licenses.ts`) follows and a reader should know.
It walks the **production closure** rather than the bundler's output: which
modules survive tree-shaking is a property of one build and can change without
any dependency changing, so it over-attributes on purpose. And it never
fabricates a text — a package that publishes no license file gets its declared
id and a pointer, not the standard wording under a guessed copyright holder.
`licenses.test.ts` re-renders and compares, so a stale file fails the suite
instead of shipping.

## 9. Comments

Comments in this repo state *why* — the constraint, the rejected alternative,
the failure the code prevents — not what the next line does. A comment that
restates its code is noise; a comment explaining why `ctime` and not `mtime`,
or why the check lives in name allocation rather than at the rename, is the
only durable record that the decision *was* one. New code matches this
density and voice.
