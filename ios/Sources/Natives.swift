import UIKit

/// The device's own answers: the pasteboard and the browser (remote.md §10).
///
/// These exist because the machine holding the notes is the wrong machine to
/// ask. A VPS has no pasteboard, and a link opened on it opens in a browser
/// nobody is looking at. The Mac's copies are bun/clientSeams.ts; these are the
/// same six seams for a device where the answers are UIKit's.
///
/// The menu bar is the sixth, and a phone has none — the page answers `menuSet`
/// itself rather than calling in here (ios.md §11).
enum Natives {
    static func clipboardRead() -> String {
        UIPasteboard.general.string ?? ""
    }

    static func clipboardWrite(_ text: String) {
        UIPasteboard.general.string = text
    }

    /// Text and the HTML flavor together, for the editor's paste-as-markdown.
    /// Absent HTML is "" and the editor pastes the text, which is the same
    /// answer the Mac gives for a copy made inside Ledge.
    static func clipboardReadRich() -> [String: String] {
        let board = UIPasteboard.general
        var html = ""
        if board.contains(pasteboardTypes: ["public.html"]),
            let data = board.data(forPasteboardType: "public.html"),
            let text = String(data: data, encoding: .utf8)
        {
            html = text
        }
        return ["text": board.string ?? "", "html": html]
    }

    /// The pasteboard's image as base64 PNG, or "" for none.
    ///
    /// Bytes only. The FILE is the server's to name (remote.md §2), so the
    /// page sends these on to `assetWrite` and the name comes back — which is
    /// why this returns a string rather than answering `assetPaste` itself.
    static func clipboardImage() -> String {
        guard UIPasteboard.general.hasImages, let image = UIPasteboard.general.image,
            let png = image.pngData()
        else { return "" }
        return png.base64EncodedString()
    }

    /// Open a link on the device in the user's hand, which is what made this a
    /// client method in the first place (ios.md §11).
    ///
    /// The allowlist mirrors shared/links.ts, and it is the guard rather than a
    /// convenience: the URL arrives from a note, which is to say from anywhere,
    /// and `UIApplication.open` will happily hand a custom scheme to whatever
    /// app claimed it. The page's own check is styling (architecture.md §2);
    /// this one is the boundary, exactly as bun/clientSeams.ts is on a Mac.
    static func linkOpen(_ raw: String) -> Bool {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
            let url = URL(string: text), let scheme = url.scheme?.lowercased(),
            ["http", "https", "mailto"].contains(scheme)
        else { return false }
        UIApplication.shared.open(url)
        return true
    }
}
