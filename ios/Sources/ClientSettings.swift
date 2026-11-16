import Foundation

/// This app's own settings.jsonc: font sizes, the theme, live preview and keys
/// (remote.md §5). The page owns the template, the parse and the merge with the
/// server's half (mainview/lib/nativeBridge.ts `nativeOverlay`); this holds the
/// text, in Application Support inside the app's container (ios.md §9).
enum ClientSettings {
    private static var file: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("settings.jsonc")
    }

    /// The file's text, or nil when there is none yet. An unreadable file reads
    /// as none, so the dialog opens on the template rather than on an error.
    static func read() -> String? {
        guard let file else { return nil }
        return try? String(contentsOf: file, encoding: .utf8)
    }

    /// Atomic, like a note save: a crash leaves the old file or the new one.
    static func write(_ text: String) -> Bool {
        guard let file else { return false }
        do {
            try FileManager.default.createDirectory(
                at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(text.utf8).write(to: file, options: .atomic)
            return true
        } catch {
            print("[shell] could not save settings.jsonc: \(error)")
            return false
        }
    }
}
