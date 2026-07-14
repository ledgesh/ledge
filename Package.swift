// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Ledge",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "LedgeApp", targets: ["LedgeApp"]),
        .executable(name: "LedgeProbe", targets: ["LedgeProbe"]),
        .library(name: "LedgeCore", targets: ["LedgeCore"]),
    ],
    dependencies: [
        // Pane tree + per-pane tab bars. MIT, zero transitive deps.
        // Vendored, not fetched: we patch the tab chip. See vendor/bonsplit/UPSTREAM.md.
        .package(path: "vendor/bonsplit"),
        // Terminal view: renders block output with ANSI colors, cursor
        // addressing, and (later) interactive input. We feed it bytes; it does
        // not spawn anything. MIT.
        .package(
            url: "https://github.com/migueldeicaza/SwiftTerm.git",
            revision: "ac99a546296e5f2dd3feea1c8bc69b5e49ca693b"
        ),
    ],
    targets: [
        // Pure model types. No AppKit, no SwiftUI, no filesystem.
        // Must stay portable: this is what an iOS app would reuse.
        .target(
            name: "LedgeCore",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),

        // PTY, marker protocol, run queue. No UI, no AppKit: this is the part
        // that must be provable headlessly, which is what LedgeProbe is for.
        .target(
            name: "SessionKit",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),

        // Markdown tokenizer. No UI: it turns text into spans and code-block
        // ranges, which keeps it testable without a window.
        .target(
            name: "LedgeMarkdown",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),

        // The AppKit window shell plus the SwiftUI leaf views it hosts.
        .target(
            name: "LedgeUI",
            dependencies: [
                "LedgeCore",
                "LedgeMarkdown",
                "SessionKit",
                .product(name: "Bonsplit", package: "bonsplit"),
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),

        // Thin executable: owns nothing but the run loop.
        .executableTarget(
            name: "LedgeApp",
            dependencies: ["LedgeUI"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),

        .testTarget(
            name: "LedgeCoreTests",
            dependencies: ["LedgeCore"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),

        // Headless driver for SessionKit. Proves the marker protocol against a
        // real shell without a window in the way.
        .executableTarget(
            name: "LedgeProbe",
            dependencies: ["SessionKit"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),

        .testTarget(
            name: "SessionKitTests",
            dependencies: ["SessionKit"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),

        .testTarget(
            name: "LedgeMarkdownTests",
            dependencies: ["LedgeMarkdown"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
