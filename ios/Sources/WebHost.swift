import UIKit
import WebKit

/// The window, the web view, and the bridge between them and the socket.
///
/// This is the whole of what Swift does with the protocol, which is nothing:
/// a frame arrives from the page as base64 and goes down the socket as bytes,
/// and bytes off the socket go up as base64. No frame is parsed here and no
/// method name is understood except the ten in `SHELL_CALLS`
/// (mainview/lib/nativeBridge.ts), which are the things only a device can
/// answer.
final class WebHost: UIViewController {
    private let config: ShellConfig
    private let scheme = BundleScheme()
    private var webView: WKWebView!

    private var socket: Socket?
    private var generation = 0
    /// While the app is away, a dial is refused rather than attempted. iOS
    /// gives about thirty seconds of background execution and the page's
    /// reconnect ladder is 31.75s long (ios.md §5), so without this the whole
    /// ladder would run in the background, succeed, and hand back a socket
    /// that suspension kills a moment later — which looks live until the first
    /// write fails.
    private var away = false

    init(config: ShellConfig) {
        self.config = config
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("no storyboard") }

    override func loadView() {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(scheme, forURLScheme: BundleScheme.scheme)
        configuration.userContentController.add(self, name: "ledge")
        // A note may embed an image or a video; neither should start playing
        // full screen because a phone said so.
        configuration.allowsInlineMediaPlayback = true

        let web = WKWebView(frame: .zero, configuration: configuration)
        web.scrollView.bounces = false
        // The page is a full-height app, not a document: WebKit's automatic
        // inset would add the safe areas a second time on top of the
        // constraints below.
        web.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(iOS 16.4, *) {
            // Safari's Web Inspector against this build. This app is a phase-3
            // fixture and being able to open its console is most of why it
            // exists; the shipping build turns it off with the transport
            // (ios.md §14).
            web.isInspectable = true
        }
        webView = web

        let root = UIView()
        root.backgroundColor = .systemBackground
        root.addSubview(web)
        web.translatesAutoresizingMaskIntoConstraints = false
        // The safe areas are the shell's job, not the page's (ios.html says so
        // where it declines to set viewport-fit). One set of constraints beats
        // env(safe-area-inset-*) threaded through a layout that also has to
        // work in a desktop window.
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: root.safeAreaLayoutGuide.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: root.safeAreaLayoutGuide.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: root.safeAreaLayoutGuide.trailingAnchor),
        ])
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        print("[shell] ledge -> \(config.destination), client \(config.client)")
        webView.load(URLRequest(url: BundleScheme.entry))
    }

    // --- the lifecycle the socket cannot survive (ios.md §5) ------------------

    func willSuspend() {
        away = true
        socket?.close()
        socket = nil
    }

    /// Foregrounding is a boot, and this is that sentence made literal: the
    /// page reloads unless its connection is still live, which after the close
    /// above it never is.
    ///
    /// The alternative — hold the socket across a short app switch and probe it
    /// on the way back — is an optimization, and the number that says whether
    /// it is worth anything is the boot latency this phase measures. Guessing
    /// at it first would be guessing about a half-open socket, which is the one
    /// thing that looks exactly like a working one.
    func didResume() {
        away = false
        deliver(["t": "resumed"])
    }

    // --- the bridge -----------------------------------------------------------

    private func deliver(_ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message),
            var json = String(data: data, encoding: .utf8)
        else { return }
        // Legal in JSON, and a line terminator in a JavaScript source file
        // until ES2019. The strings crossing here include a server's error
        // messages and a user's note titles, so this is reachable.
        json = json.replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        webView.evaluateJavaScript("window.__ledge&&window.__ledge.deliver(\(json))")
    }

    private func reply(_ id: Int, _ value: Any) {
        deliver(["t": "reply", "id": id, "r": value])
    }

    private func fail(_ id: Int, _ why: String) {
        deliver(["t": "fail", "id": id, "e": why])
    }

    private func open(_ id: Int) {
        guard !away else {
            return fail(id, "the app is in the background")
        }
        socket?.close()
        generation += 1
        let gen = generation
        let next = Socket(generation: gen, host: config.host, port: config.port)
        socket = next
        next.open(
            ready: { [weak self] result in
                DispatchQueue.main.async {
                    guard let self else { return }
                    switch result {
                    case .success:
                        self.reply(id, ["gen": gen])
                    case .failure(let error):
                        // Named, because "could not connect" without the
                        // address is the one error message nobody can act on.
                        self.fail(id, "could not reach \(self.config.destination): \(error.localizedDescription)")
                    }
                }
            },
            bytes: { [weak self] data in
                DispatchQueue.main.async {
                    self?.deliver(["t": "frame", "gen": gen, "b": data.base64EncodedString()])
                }
            },
            end: { [weak self] in
                DispatchQueue.main.async {
                    self?.deliver(["t": "closed", "gen": gen])
                }
            }
        )
    }
}

extension WebHost: WKScriptMessageHandler {
    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any], let kind = body["t"] as? String else { return }

        if kind == "frame" {
            guard let b64 = body["b"] as? String, let bytes = Data(base64Encoded: b64) else { return }
            socket?.send(bytes)
            return
        }

        guard kind == "call", let id = body["id"] as? Int, let method = body["m"] as? String else { return }
        let params = body["p"] as? [String: Any] ?? [:]

        switch method {
        case "@hello":
            reply(id, ["client": config.client, "destination": config.destination])
        case "@open":
            open(id)
        case "@close":
            // By generation: a close for a socket that has already been
            // replaced must not take the live one with it.
            if let gen = params["gen"] as? Int, socket?.generation == gen {
                socket?.close()
                socket = nil
            }
            reply(id, NSNull())
        case "@log":
            print("[view] \(params["text"] as? String ?? "")")
            reply(id, NSNull())
        case "clipboard.read":
            reply(id, Natives.clipboardRead())
        case "clipboard.write":
            Natives.clipboardWrite(params["text"] as? String ?? "")
            reply(id, NSNull())
        case "clipboard.readRich":
            reply(id, Natives.clipboardReadRich())
        case "clipboard.image":
            reply(id, Natives.clipboardImage())
        case "link.open":
            reply(id, ["ok": Natives.linkOpen(params["url"] as? String ?? "")])
        case "menu.set":
            // There is no menu bar on a phone. The page answers this itself and
            // never gets here; the case exists so that a page which does ask
            // gets an answer rather than a hang (ios.md §11).
            reply(id, NSNull())
        default:
            fail(id, "the Ledge shell has no \(method)")
        }
    }
}
