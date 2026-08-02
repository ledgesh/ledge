import Foundation
import WebKit

/// The built view, served to the web view over a scheme of its own.
///
/// The alternative is `loadFileURL`, and a custom scheme is worth the fifty
/// lines: `file://` gives every resource its own opaque origin, which ES
/// modules and `import()` — CodeMirror loads a language mode per fence
/// (`@codemirror/language-data`) — do not survive. Under `ledge://app/`
/// everything the page loads shares one origin, and the page cannot see
/// anything outside the bundle's `view/` directory.
///
/// It is also the seam §2 names for later: if the bridge's base64 ever
/// measures as the bottleneck, streaming `Data` server-to-client is a handler
/// here rather than a change to the protocol.
final class BundleScheme: NSObject, WKURLSchemeHandler {
    static let scheme = "ledge"
    static let entry = URL(string: "ledge://app/ios.html")!

    /// Where scripts/ios-build.ts puts `bunx vite build --config
    /// vite.ios.config.ts`'s output.
    private let root: URL

    override init() {
        root = Bundle.main.bundleURL.appendingPathComponent("view").standardizedFileURL
        super.init()
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        // Answered synchronously, start to finish. A `WKURLSchemeTask` that is
        // written to after WebKit has stopped it traps, and doing the whole
        // thing on this call is what makes that unreachable rather than
        // unlikely — there is no suspension point for a stop to interleave at.
        guard let url = task.request.url else {
            return task.didFailWithError(URLError(.badURL))
        }
        guard let file = resolve(url), let data = try? Data(contentsOf: file) else {
            return task.didFailWithError(URLError(.fileDoesNotExist))
        }
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": Self.mime(file.pathExtension),
                "Content-Length": String(data.count),
                // The bundle is the app; a stale module across a reinstall
                // would be a mystery worth days.
                "Cache-Control": "no-store",
            ]
        )!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    /// The file a URL names, or nil for anything outside the view directory.
    ///
    /// `standardized` resolves the `..` before the prefix test rather than
    /// after it, which is the whole of the guard: the page is the only thing
    /// that composes these paths, and the page is remote code by the time a
    /// note has a link in it.
    private func resolve(_ url: URL) -> URL? {
        let path = url.path.isEmpty || url.path == "/" ? "/ios.html" : url.path
        let target = root.appendingPathComponent(path).standardizedFileURL
        guard target.path == root.path || target.path.hasPrefix(root.path + "/") else { return nil }
        return target
    }

    private static func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        // Deliberately not application/octet-stream: an unknown type that the
        // page tried to load as a module would fail with a MIME error rather
        // than a missing-file one, and the second is the true report.
        default: return "application/octet-stream"
        }
    }
}
