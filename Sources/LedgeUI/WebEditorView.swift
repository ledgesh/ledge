import SessionKit
import SwiftUI
import WebKit

/// The Markdown editor, now a CodeMirror instance in a `WKWebView`.
///
/// This replaces the NSTextView editor. Overlaying live UI on text (run buttons,
/// inline output, cursor shape) is a fight in AppKit's text system and a solved
/// problem in CodeMirror, so the editor surface lives on the web side while the
/// shell, PTY, and marker protocol stay native. Web and native talk over a small
/// message bridge: the web posts to `window.webkit.messageHandlers.ledge`, and
/// native calls back through `window.ledge`.
struct WebEditorView: NSViewRepresentable {
    @Binding var text: String

    /// Bump to ask the editor to take focus. A counter, so repeated requests are
    /// not swallowed.
    let focusToken: Int

    /// Fired when the web editor gains focus, so the pane can take focus too.
    let onFocus: () -> Void

    /// Toggles the note's terminal drawer (Ctrl+`).
    let onToggleTerminal: () -> Void

    /// Opens the terminal drawer (a block was run there).
    let onOpenTerminal: () -> Void

    /// The note's runtime: runs blocks and streams their output back.
    let runtime: NoteRuntime

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "ledge")
        configuration.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        // Let the pane's background (and its focus dimming) show through.
        webView.setValue(false, forKey: "drawsBackground")

        if let indexURL = Self.editorIndexURL() {
            webView.loadFileURL(indexURL, allowingReadAccessTo: indexURL.deletingLastPathComponent())
        }
        context.coordinator.webView = webView

        // Stream every run event to the web editor so it can render inline output.
        runtime.onRunEvent = { [weak coordinator = context.coordinator] event in
            coordinator?.forwardRunEvent(event)
        }
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self

        // Push text down only when it changed underneath us and the editor is
        // ready; the JS side ignores a set that matches its current document.
        if context.coordinator.isReady, context.coordinator.lastSentText != text {
            context.coordinator.setText(text)
        }

        if context.coordinator.lastFocusToken != focusToken {
            context.coordinator.lastFocusToken = focusToken
            context.coordinator.focusEditor()
        }
    }

    /// The bundled editor page. Copied into the app bundle by `make app`.
    private static func editorIndexURL() -> URL? {
        Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "editor")
    }

    // MARK: - Coordinator

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: WebEditorView
        weak var webView: WKWebView?

        var isReady = false
        var lastFocusToken = 0
        /// The last text we sent to the web side, so an echo of our own edit does
        /// not bounce back and forth.
        var lastSentText: String?

        init(_ parent: WebEditorView) {
            self.parent = parent
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let body = message.body as? [String: Any],
                  let type = body["type"] as? String
            else { return }

            switch type {
            case "ready":
                isReady = true
                // Hand the editor its initial content.
                setText(parent.text)
            case "textChanged":
                if let text = body["text"] as? String {
                    lastSentText = text
                    parent.text = text
                }
            case "focus":
                parent.onFocus()
            case "toggleTerminal":
                parent.onToggleTerminal()
            case "run":
                handleRun(body)
            default:
                break
            }
        }

        private func handleRun(_ body: [String: Any]) {
            let code = body["code"] as? String ?? ""
            let language = body["language"] as? String
            let destination = body["destination"] as? String ?? "inline"
            if destination == "terminal" {
                parent.runtime.runInTerminalForWeb(code: code, language: language)
                parent.onOpenTerminal()
            } else if let id = body["id"] as? String {
                parent.runtime.runForWeb(id: id, code: code, language: language)
            }
        }

        /// Forward a run event to the web editor's `window.ledge` API.
        func forwardRunEvent(_ event: RunEvent) {
            switch event {
            case let .started(id):
                callJS("window.ledge.runEvent(\(js(id)), \"started\", null)")
            case let .output(id, data):
                callJS("window.ledge.runEvent(\(js(id)), \"output\", \(js(data.base64EncodedString())))")
            case let .finished(id, code):
                callJS("window.ledge.runEvent(\(js(id)), \"finished\", \(code))")
            case .sessionEnded:
                callJS("window.ledge.sessionEnded()")
            case .queued:
                break
            }
        }

        private func callJS(_ script: String) {
            webView?.evaluateJavaScript(script, completionHandler: nil)
        }

        /// A string as a safe JS literal.
        private func js(_ string: String) -> String {
            guard let data = try? JSONEncoder().encode(string),
                  let literal = String(data: data, encoding: .utf8)
            else { return "\"\"" }
            return literal
        }

        func setText(_ text: String) {
            lastSentText = text
            guard let data = try? JSONEncoder().encode(text),
                  let literal = String(data: data, encoding: .utf8)
            else { return }
            webView?.evaluateJavaScript("window.ledge.setText(\(literal))")
        }

        func focusEditor() {
            webView?.evaluateJavaScript("window.ledge && window.ledge.focus()")
            webView?.window?.makeFirstResponder(webView)
        }
    }
}
