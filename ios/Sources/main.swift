// Ledge on iOS: the shell around the same React view the Mac runs (ios.md §1).
//
// There is no local server here and there never will be: Bun does not run on
// iOS, an app cannot spawn a subprocess, and a phone is not where anyone wants
// their notes to live. Every screen in this app is a view of some other
// machine's notes, reached across a wire.
//
// What Swift owns is that wire, the device's own answers, and a window. The
// protocol — the framing, the handshake, the op ids, the reconnect ladder —
// is the TypeScript in src/shared/, running in the webview. That split is
// ios.md §2 and it is why this directory is small.
//
// Phase 3 (ios.md §14) is the shell WITHOUT ssh: the transport is a plain TCP
// socket to scripts/lan-bridge.ts on the same network. That fixture opens a
// port and must never become a shipping mode; Socket.swift says so again where
// the connection is actually made.
import UIKit

UIApplicationMain(
    CommandLine.argc,
    CommandLine.unsafeArgv,
    nil,
    NSStringFromClass(AppDelegate.self)
)
