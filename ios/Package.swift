// swift-tools-version:5.9
//
// The iOS client's one dependency (ios.md §3).
//
// iOS runs no subprocesses, so there is no `ssh` to spawn and the protocol has
// to be linked in. SwiftNIO SSH is Apple's, it is Swift, and it supports the
// exec request that is the whole of what remote.md §3 asks a transport to do.
// It is the only dependency this app has: the window, the web view, the
// pasteboard and the key are all system frameworks, and everything above the
// byte stream is the JavaScript the Mac already runs.
//
// **A package manifest, not an Xcode project.** `scripts/ios-build.ts` drives
// `swift build` with a simulator target and assembles the `.app` itself, so
// the app is still a binary, a plist and a folder. What changed at phase 4 is
// that the binary now has dependencies to resolve, which is the one thing
// `swiftc` and a glob could not do.
//
// Two things a reader will wonder about:
//
// - **The macOS floor is not a platform this app builds for.** Nothing here
//   ever runs on a Mac. SwiftPM still resolves the graph against the host, and
//   the dependencies' own manifests have macOS floors, so omitting this line
//   fails resolution with a message about a platform that is not in play.
// - **Tools version 5.9, so Swift 5 language mode.** Strict concurrency across
//   a UIKit app, a WKWebView delegate and NIO's event loops is its own project;
//   the hops that matter are explicit (`DispatchQueue.main.async` at every
//   edge of `WebHost`), which is the property Swift 6 mode would check rather
//   than provide.
import PackageDescription

let package = Package(
    name: "Ledge",
    platforms: [.iOS(.v17), .macOS(.v13)],
    dependencies: [
        // Pinned to 0.15.x by SwiftPM's rule for pre-1.0 packages: `from:`
        // allows patches, never a minor. An SSH implementation is not a
        // dependency to float.
        .package(url: "https://github.com/apple/swift-nio-ssh.git", from: "0.15.0"),
        // NIOSSH's own dependency, named again because this app imports it
        // directly: NIOSSH ships the protocol, and the event loop, the client
        // bootstrap and the channel pipeline it runs on are the caller's
        // (§3, "building blocks, not a client").
        .package(url: "https://github.com/apple/swift-nio.git", from: "2.101.3"),
    ],
    targets: [
        .executableTarget(
            name: "Ledge",
            dependencies: [
                .product(name: "NIOSSH", package: "swift-nio-ssh"),
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "NIOPosix", package: "swift-nio"),
            ],
            path: "Sources"
        )
    ]
)
