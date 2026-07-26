# Ledge

The macOS notebook for developers and DevOps: it runs code and commands
straight from your Markdown. Built on Electrobun: Bun main process (`src/bun/`,
owns the filesystem and PTYs) + WKWebView React app (`src/mainview/`), talking
over the typed RPC in `src/shared/rpc-schema.ts`.

## Standards — read the one that governs your change

The standards live in `docs/contributor/`; the end-user manual (compiled into
the app as its built-in docs, via `src/bun/docsContent.ts`) lives in
`docs/user/`.

- **[architecture.md](docs/contributor/architecture.md)** — process/trust
  boundaries, filesystem invariants (rename-not-unlink, path guards), state
  ownership (store vs `useState` vs `configureX` hooks), settings policy (what
  earns a knob in settings.json), the recipe for adding an RPC method,
  dependency policy. Read before adding modules, RPC methods, state, settings,
  or dependencies.
- **[interactions.md](docs/contributor/interactions.md)** — every user-facing
  action is a command in `src/mainview/commands/`; hotkey allocation, row
  verbs, destructive-action policy, Escape layering, tooltips. Read before
  adding any user-facing action, key, menu, or button.
- **[locking.md](docs/contributor/locking.md)** — note locking (per-note
  encryption): the vault and envelope, the readNote/writeNote seam rules,
  the agents-never-read-locked-bodies invariant (MCP/CLI refusals, prompt
  fences), sealed images, and the lock commands' interaction grammar. Read
  before touching anything that reads note or asset bytes, the vault RPCs,
  or the lock UI.
- **[testing.md](docs/contributor/testing.md)** — what must be tested and how:
  colocated `bun test`, pure-core/DOM-wrapper split (no happy-dom — do not
  add one), invariant tests, the headless-WebKit harness (`test:e2e`) for UI
  behavior, live WKWebView probe recipe for the native seams (always against
  a scratch `LEDGE_NOTES_ROOT`). Read before writing tests or calling work
  done.

These are normative: if code and doc disagree, one of them is wrong — fix
deliberately, not silently.

## Commands

```
bun test             # unit + filesystem tests (scratch root via preload)
bun run test:e2e     # UI behavior in headless WebKit (Playwright harness)
bunx tsc --noEmit    # typecheck
bunx vite build      # build the view
bun run dev          # launch (bunx electrobun dev; bare `electrobun` is not on PATH)
bun run cli <verb>   # the `ledge` CLI from the checkout (src/bun/cli.ts; interactions.md §9)
```

Done means: tsc clean, build clean, tests green (e2e too when UI behavior
changed) — and live-verified in the real webview when the change touches the
native seams (testing.md §6).
