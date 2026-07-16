# Ledge testing standards

How correctness is checked, and at which layer. The one-line version: **pure
logic gets unit tests, wiring gets the type system, and behavior gets verified
in the real WKWebView** — each layer covering what the one below cannot.

## 1. Runner and layout

`bun test` (`bun run test`, `test:watch` to watch). Tests are colocated:
`foo.test.ts` sits next to `foo.ts`, named for the module it tests, importing
it relatively. There is no `tests/` directory and no test-only build step.
Tests land *with* the feature, in the same change — a feature whose logic is
pure but untested is not done.

## 2. What must be tested (and what must not)

**Must:** every pure module. Parsers and matchers (`ansi`, `markers`,
`fuzzy`), the keymap resolver, the reducer and tree helpers, name allocation
and path guards, formatting. If it takes values and returns values, it gets a
colocated test file, and edge cases get named tests whose descriptions read as
sentences stating the rule ("a sibling whose name merely starts with the root
is rejected").

**Must not:** React components, DOM event plumbing, or anything needing a
fake browser. There is **no happy-dom / jsdom in this repo — do not add one.**
The rule when a module seems to need a DOM is to split it:

- the decision goes in a **pure core**, tested — `targetFromDataset` takes a
  plain dataset object and returns a target;
- the DOM touch stays in a **thin wrapper**, untested and too small to be
  wrong — `targetFromElement` is `closest()` plus one call into the core.

A wrapper that grows logic is the signal to move that logic down into the
core. What the wrappers and components add up to is covered by layer 4, not
by simulating a browser badly.

Filesystem code follows the same shape: `bun/notes.test.ts` tests the pure
helpers (`uniqueName`, `isInside`) and the guards (a `rejects` assertion
needs no filesystem) without ever touching disk.

## 3. Invariant tests

When a rule in `docs/interactions.md` or `docs/architecture.md` can be a
test, it must be one — the doc states the rule, the test enforces it, and a
violation fails CI instead of waiting for a reader. Existing examples, which
new rules should imitate:

- no two commands share a bare key on the same row kind, and every row verb
  declares its `targetKind` (`registry.test.ts`);
- row verbs live in `listKeys`, never `keys` (`keys.test.ts`);
- the held-modifier badges show the same keys `keys.ts` binds;
- note verbs refuse a trash target and vice versa;
- `deleteTrashed` rejects anything not a `.md` directly inside `.trash`.

These are the cheapest guardrails the repo has: they turn "someone will
forget" into "the suite goes red."

## 4. Stubbing at the seams

The seams built for testability (architecture.md §5) are where tests inject:

- **Channel handlers**: `notes/store.test.ts` implements the `NoteHandlers`
  interface with stubs — never a mock of the RPC or the webview. Adding a
  handler to a channel interface deliberately breaks these tests at
  typecheck, which is the reminder to extend the stubs.
- **Registry deps**: `registry.test.ts` passes a stub `RegistryDeps` and a
  `Partial<UiHooks>`, so command behavior is tested without the editor stack.
- **State**: build it with `initialState(...)` and the exported action
  creators, not by hand-assembling `AppState` literals that rot as the shape
  grows.

## 5. Verifying in the real app

Unit tests cannot see focus, WebKit quirks, or the Bun⇄view wiring — the
click-focus bug lived entirely in the gap between green tests and the real
webview. Nontrivial UI behavior therefore gets verified live before it is
called done. The recipe (the WKWebView console is not forwarded, so results
come out through the clipboard):

1. **Scratch root, always.** Launch with `LEDGE_NOTES_ROOT=<scratch dir>` and
   seed it with throwaway notes. A probe must never run against the real
   `~/.ledge`.
2. **Temp probe in `main.tsx`**: a self-contained block that waits for boot,
   drives the app with synthetic events, and reports via the `clipboardWrite`
   RPC as one `PROBE: key=value ...` line behind a unique sentinel.
3. **Poll with `pbpaste`** from the shell until the sentinel appears.
4. Synthetic keyboard events must be dispatched **on the element that would
   really have focus** (a list row, the editor), with `bubbles: true` —
   dispatching on `window` skips the domain detection the real key would hit.
5. Focus the element first (`.focus()`), then dispatch; assert on
   `document.activeElement` when focus itself is the behavior under test.
6. **Tear down**: revert the probe (its diff should be the whole diff to
   `main.tsx`), kill the app processes, delete the scratch root.

Two hard-won warnings: query dialogs by `[role="alertdialog"]` (ConfirmDialog
is an alertdialog, not a dialog); and edit `main.tsx` with proper edit tools,
not ad-hoc string splicing — a text-index splice once matched `boot()`'s
`catch` instead of the intended one and duplicated the file.

## 6. The green bar

Before any work is called done, all of:

```
bunx tsc --noEmit    # no errors under src/
bunx vite build      # the view still builds
bun test             # everything passes; no skipped tests left behind
```

plus §5 when the change has user-visible behavior. Report results as they
are: a red test is a finding, not an obstacle to phrase around.
