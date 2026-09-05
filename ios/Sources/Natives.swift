import UIKit

/// The device's own answers: the pasteboard and the browser (remote.md §10).
///
/// These exist because the machine holding the notes is the wrong machine to
/// ask. A VPS has no pasteboard, and a link opened on it opens in a browser
/// nobody is looking at. The Mac's copies are bun/clientSeams.ts; these are the
/// same seams for a device where the answers are UIKit's.
///
/// The share sheet is here for a different reason from the rest: not because
/// the far machine is the wrong one to ask, but because it is the machine the
/// answer has to reach. See `share` below.
///
/// Two of them are not here. The menu bar, because a phone has none and the
/// page answers `menuSet` itself (ios.md §11); and the picture library, which
/// has its own file because it is the only seam that puts a screen up and waits
/// for a person (PhotoPicker.swift).
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

    /// Put a string in front of the system share sheet: AirDrop, Messages,
    /// Mail, Notes, whatever the device has (ios.md §4).
    ///
    /// One caller's worth of generality on purpose. What crosses it is the
    /// `authorized_keys` line, which has to reach a machine that is not this
    /// one, and the pasteboard cannot carry it there. Nothing else in the app
    /// shares anything, so this takes a string rather than growing an activity
    /// item protocol for a case that does not exist yet.
    ///
    /// `from` is not decoration. On an iPad the sheet is a popover and UIKit
    /// traps on one with no anchor, so a caller with a button hands it over and
    /// a caller without gets the middle of the presenting view.
    @discardableResult
    static func share(_ text: String, over host: UIViewController, from anchor: UIView?) -> Bool {
        guard !text.isEmpty else { return false }
        let sheet = UIActivityViewController(activityItems: [text], applicationActivities: nil)
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = anchor ?? host.view
            if anchor == nil {
                popover.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }
        }
        host.present(sheet, animated: true)
        return true
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
