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
// The wire is ssh, linked in rather than spawned (ios.md §3): iOS runs no
// subprocesses, so SSHTransport.swift is what /usr/bin/ssh is on the Mac, and
// the key it authenticates with is minted in the Secure Enclave and never
// leaves it (§4). Everything above the byte stream is unchanged, because a
// duplex does not know what carries it.
import UIKit

UIApplicationMain(
    CommandLine.argc,
    CommandLine.unsafeArgv,
    nil,
    NSStringFromClass(AppDelegate.self)
)
