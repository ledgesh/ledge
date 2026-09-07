// Ledge on iOS: the shell around the same React view the Mac runs (ios.md §1).
//
// There is no local server. Bun does not run on iOS and an app cannot spawn a
// subprocess, so every screen here is a view of some other machine's notes,
// reached across a wire.
//
// Swift owns that wire, the device's own answers, and a window. The protocol
// itself, meaning the framing, the handshake, the op ids and the reconnect
// ladder, is the TypeScript in src/shared/ running in the webview. That split
// is ios.md §2, and it is why this directory is small.
//
// The wire is ssh, linked in rather than spawned (ios.md §3):
// SSHTransport.swift is what /usr/bin/ssh is on the Mac, and the key it
// authenticates with is minted in the Secure Enclave and never leaves it
// (ios.md §4). Nothing above the byte stream changes.
import UIKit

UIApplicationMain(
    CommandLine.argc,
    CommandLine.unsafeArgv,
    nil,
    NSStringFromClass(AppDelegate.self)
)
