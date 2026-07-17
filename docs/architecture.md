# Ledge architecture & boundaries

Normative rules for where code lives, what may talk to what, and which
invariants hold at each boundary. `docs/interactions.md` governs how actions
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

## 2. The trust boundary

**The view is the least-trusted end of the RPC.** Not because it is hostile,
but because it is the end where a bug becomes an arbitrary argument: a stale
path in a closure, a confused target, an injected string in a note's heading.
Bun therefore validates everything and derives anything derivable:

- **Every path arriving over RPC is checked before use.** `assertNote`
  (inside the root *and* a `.md` file) gates every view-supplied note path;
  `assertTrashed` — strictly tighter: a `.md` file *directly inside* `.trash` —
  gates the two calls that can unlink. `"../../.ssh/id_rsa"` must throw, and
  there is a test saying so. The `.md` requirement is load-bearing, not
  tidiness: `settings.json` lives in the root and names the shell executable
  (§6), so a `noteWrite` that accepted any in-root path would turn a notes
  write into command execution at the next launch.
- **The view never names a file.** It sends a note's *text*; Bun slugs the
  heading itself (`slugOf` emits only `[a-z0-9-]`), so filenames are safe by
  construction and there is no name parameter to validate or smuggle through.
- **Paths are opaque handles.** The view holds only paths it was handed by Bun
  (`noteList`, `noteCreate`, `noteDelete`'s trashed location) and passes them
  back unmodified. View code that constructs or edits a path is a bug.
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

## 3. Filesystem invariants

- **`rename(2)` is the primitive; `unlink` is the exception.** Saves are a
  temp-file-plus-rename (atomic within a filesystem: a crash mid-save leaves
  the old note or the new one, never half). Delete is a rename into `.trash`.
  Retitle is a rename. Restore is a rename. Exactly three code paths unlink a
  *note* — `deleteTrashed`, `emptyTrash`, `purgeTrash` — all in `bun/notes.ts`, all
  gated by `assertTrashed`, and the first two sit behind a confirmation
  (interactions.md §4). **Anything new that unlinks a file joins all three
  lists: the guard, the confirm, and this sentence.** (The one other `unlink`
  in the repo is `writeNote` discarding its own temp file after a failed
  save — a dotted file it created moments earlier that no listing ever shows.)
- **Name allocation is where clobber-safety lives.** `rename(2)` overwrites
  silently, so no call site may pick its own destination name: `uniqueName`
  (case-insensitive, because APFS is) allocates against a `readdir` snapshot
  plus the `reserved` set, and the rename that follows is safe *because* the
  allocation already skipped every taken name. A rename whose target didn't
  come from `uniqueName` is a latent data-loss bug.
- **Dot-entries are invisible and inviolate.** `listNotes` skips them (which
  is what hides `.trash` and the temp files); trash operations touch only
  `.md` files directly in `.trash`. Empty Trash removes exactly what the list
  showed, and nothing it did not.
- **`LEDGE_NOTES_ROOT`** overrides the root (`~/.ledge`) for tests and
  throwaway runs. Nothing in the app sets it; every `bun test` run gets a
  scratch one via preload, and anything that exercises the real app against
  real files must set it (see `docs/testing.md` §§2, 6). **`LEDGE_PROFILES_DIR`**
  is the same override for the profiles dir (§6a), for the same reason: no
  test or probe may read — or seed — the real one.

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

User preferences live in one JSON file, `settings.json`, in the notes root.
`shared/settings.ts` owns the shape, the defaults, and the validator;
`bun/settings.ts` owns the file. Bun reads it once at launch, applies its own
half (the shell every PTY spawns, the trash TTL), and hands the view a
validated snapshot over `settingsGet`; view consumers (editor and terminal
font sizes, the runnable-fence set) read that snapshot at construction time
through `lib/settings.ts`.

- **What earns a setting.** The same shape of bar as the dependency policy
  (§8): every setting is a behavioral fork the app tests and maintains
  forever, so one exists only where the hardcoded default demonstrably fails
  someone — not because a value *could* vary. The full current set: shell
  path/args, editor and terminal font size, trash TTL, runnable fence
  languages, and the fence-language → interpreter map (`blocks.interpreters`,
  applied Bun-side by `bun/runner.ts`; it exists because "which python" has no
  universal answer — the default resolves via the login shell's PATH, and a
  venv or pinned toolchain demonstrably needs to override that). Additions
  should be argued in those terms.
- **Settings are not session state.** `settings.json` is *human-edited
  preference*; which workspaces exist, their names, the pane layout are
  *machine-written state* with different failure modes (a corrupt state file
  must self-heal; a corrupt settings file must be left for its author). When
  session persistence lands it gets its own file. Never mix the two.
- **The file is the UI.** There is no settings panel; ⌘, (`settings.open`)
  asks Bun to open the file in the OS editor. First launch seeds it with
  every default spelled out, so the file documents its own knobs.
- **Validation degrades per field, and never rewrites.** A bad value costs
  that field (warned, defaulted — `parseSettings`); unparseable JSON costs the
  whole file for the run but the bytes on disk are untouched: it is the
  user's file, possibly mid-edit, and "fixing" it would destroy their work.
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
---
```

`shared/frontmatter.ts` owns the grammar (hand-rolled per §8; per-line
degradation like `parseSettings`); `bun/spawnParams.ts` owns what the values
mean at spawn. Precedence is `process.env` < `envFile` < `profile` < `env`,
with `TERM` pinned back afterwards — xterm.js is the terminal whatever a note
claims. The split of duties across the boundary: the **view** parses the
block (it holds the text) and sends the params over `sessionConfigure`,
keyed by docId; **Bun** stores them per session and reads them each time one
of that session's shells spawns — persistent, overflow, and terminal drawer
alike, which is what keeps all three telling one story about the note.

- **Settings vs frontmatter.** `settings.json` is app-wide preference;
  frontmatter is a per-note fact that travels with the note — open it
  anywhere, same cwd, same env. A knob belongs in frontmatter only when the
  right value genuinely varies per note (cwd, env); a knob that varies per
  person stays in settings. Neither is session state (§6 still applies).
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
  RPCs). Profiles are the one config file that does NOT open in the OS
  editor: macOS binds no application to `.env`, so the settings.json move
  (`open` the file) dead-ends with LSApplicationNotFound. The file stays a
  plain dotenv on disk — greppable, hand-editable — and dialog saves go
  through `serializeDotenv` (`shared/dotenv.ts`), which preserves comments
  and untouched lines byte-for-byte, so hand edits and dialog edits coexist
  rather than compete. Values render masked by default: the dialog must not
  become the place secrets end up on screen after all.
- **Restart-applies, like settings.** Params are read at shell *spawn*; a
  live shell keeps the cwd/env it was born with, and an edited frontmatter
  takes effect on the session's next shell. The "Restart Note Shell" command
  is the deliberate escape hatch: kill the note's shells, keep its params,
  respawn lazily. (This is also why an overflow shell spawned after a
  frontmatter edit can be newer than the persistent one — each shell reads
  the params at its own birth.)
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
real DOM (`docs/testing.md` §5) — the canonical example of a reason that
clears it.

Bun-side: prefer `bun:ffi` and POSIX over native modules — node-pty is out for
exactly this reason; the PTY is posix_spawn + poll.

## 9. Comments

Comments in this repo state *why* — the constraint, the rejected alternative,
the failure the code prevents — not what the next line does. A comment that
restates its code is noise; a comment explaining why `ctime` and not `mtime`,
or why the check lives in name allocation rather than at the rename, is the
only durable record that the decision *was* one. New code matches this
density and voice.
