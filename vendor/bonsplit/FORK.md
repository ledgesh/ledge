# Bonsplit, forked

Origin: https://github.com/almonk/bonsplit (MIT, see LICENSE)
Forked at: 77b9ccebf1c6e6533c3df1030b5efa9a3db2f351 (2026-05-19)

## Posture: this is ours

This is a fork, not a vendored copy we keep in step with upstream. We change it
freely and we do not hold back a change because it would be awkward to upstream.

That is deliberate. The tab chip is a closed box, and everything Ledge wants to put
on a tab row (a folder, a modified time, a dirty dot, a running-job indicator)
lives inside that box. Reaching those affordances means editing the library, so we
own it as a starting point rather than pretending it is an external dependency.

What we still owe ourselves:
- Every change is listed below, with a reason.
- Upstream's test suite keeps passing, and our changes get tests of their own.
  `make test` at the repo root runs both.
- Cherry-picking a good upstream commit stays possible. Diverge for a reason, not
  by accident.

## Changes

### 1. Tab rename

Upstream's `TabItemView` has one tap gesture and no context menu, so no rename
gesture is reachable from outside the library. Added:

- `BonsplitConfiguration.allowTabRename`
- `BonsplitController.renameTab(_:to:)`, which trims, rejects blanks, and reports
- `BonsplitDelegate.splitTabBar(_:didRenameTab:inPane:)`
- `TabItemView`: inline `TextField` editing, a Rename/Close context menu, and a
  double-click to begin. Blur commits, Esc cancels, matching Finder and Xcode.

Note: the double-click gesture must be declared before the single-click one, or the
single tap consumes the event and the second click never arrives.

Tests: `TabRenameTests` in `Tests/BonsplitTests/BonsplitTests.swift`.
