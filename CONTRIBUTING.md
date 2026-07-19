# Contributing to Ledge

Thanks for your interest in Ledge. This file covers how to get the app
running, what "done" means here, and how to send a change.

## Getting set up

Ledge is a macOS app. You need [Bun](https://bun.sh) and a Mac.

```sh
bun install
bun run start      # vite build, then launch the app (electrobun dev)
bun run dev:hmr    # same, with a Vite dev server for hot module reload
```

The first `electrobun dev` downloads the Electrobun core (~27 MB) and
assembles a real `.app` under `build/`.

## Read the standard that governs your change

This repo keeps its normative rules in `docs/contributor/`, not in reviewer
heads. Before you write code, read the one that covers what you are touching:

- **[architecture.md](docs/contributor/architecture.md)** — process and trust
  boundaries, filesystem invariants, state ownership, settings policy, the
  recipe for adding an RPC method, dependency policy. Read before adding
  modules, RPC methods, state, settings, or dependencies.
- **[interactions.md](docs/contributor/interactions.md)** — every user-facing
  action is a command in `src/mainview/commands/`; hotkey allocation, row
  verbs, destructive-action policy, Escape layering, tooltips. Read before
  adding any user-facing action, key, menu, or button.
- **[locking.md](docs/contributor/locking.md)** — per-note encryption: the
  vault and envelope, the readNote/writeNote seam rules, the
  agents-never-read-locked-bodies invariant, sealed images. Read before
  touching anything that reads note or asset bytes, the vault RPCs, or the
  lock UI.
- **[testing.md](docs/contributor/testing.md)** — what must be tested and at
  which layer: colocated `bun test`, the pure-core / DOM-wrapper split (there
  is no happy-dom in this repo and none should be added), the headless-WebKit
  e2e harness, and the live WKWebView probe for native seams.

The end-user manual lives in [docs/user/](docs/user). Those pages are compiled
into the app as its built-in documentation workspace, so editing one changes
what ships: `src/bun/docsContent.ts` imports each page explicitly and lists it
in a manifest, and its header states the authoring rules (one line per
paragraph, no hard wrapping, no em dashes).

These docs are normative. If the code and a doc disagree, one of them is
wrong: fix it deliberately and say so in your PR, rather than quietly
following whichever one is closer to hand.

## What "done" means

A change is done when all of these hold:

```sh
bunx tsc --noEmit    # typecheck clean
bunx vite build      # view builds clean
bun test             # unit + filesystem tests green
bun run test:e2e     # e2e green, required when UI behavior changed
```

Plus: live-verified in the real webview when the change touches the native
seams (see docs/contributor/testing.md §6). Tests land in the same change as
the feature. A feature whose logic is pure but untested is not done.

## Sending a change

1. Open an issue first for anything larger than a bug fix, so the design can
   be discussed before you spend time on it.
2. Branch off `main`.
3. Keep the change focused. Unrelated cleanups belong in their own commit or
   PR.
4. Write commit messages in the imperative mood, describing the behavior
   change rather than the files touched.
5. In the PR description, say what changed, why, and how you verified it. If
   you changed or added a rule in `docs/`, call that out explicitly.

## Style

Match the surrounding code: its naming, its comment density, its idioms. The
project is TypeScript throughout, with React and Tailwind in the view. There
is no separate formatter step, so follow what is already on the page.

Avoid em dashes in user-facing strings (settings templates, dialog copy,
seeded content). Use colons or parentheses instead.

## Dependencies

New dependencies are a deliberate decision, not a convenience. Read the
dependency policy in [architecture.md](docs/contributor/architecture.md)
before adding one, and justify it in the PR.

## Licensing

Ledge is licensed under the [Apache License 2.0](LICENSE). By contributing,
you agree that your contributions are licensed under the same terms.
