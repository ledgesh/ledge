import UIKit
import WebKit

/// The window, the web view, and the bridge between them and the socket.
///
/// This is the whole of what Swift does with the protocol, which is nothing:
/// a frame arrives from the page as base64 and goes down the socket as bytes,
/// and bytes off the socket go up as base64. No frame is parsed here and no
/// method name is understood except the twelve in `SHELL_CALLS`
/// (mainview/lib/nativeBridge.ts), which are the things only a device can
/// answer.
final class WebHost: UIViewController {
    private let config: ShellConfig
    private let server: ServerRecord
    /// Called when a dial fails for a reason retrying cannot fix: a host key
    /// that changed, or a key the server will not accept. The page's ladder
    /// would otherwise spend the next half minute asking the same question.
    private let onRepair: (String) -> Void
    private let scheme = BundleScheme()
    private var webView: WKWebView!

    private var socket: SSHTransport?
    private var generation = 0
    /// The strip above the keyboard (ios.md §7). Built once and held here: it
    /// is captured by the accessory getter installed on the web view's content
    /// view, so it has to outlive the call that installs it.
    private var accessory: UIView?
    /// Whether what the keyboard is over is the EDITOR, as the page reports it.
    /// One content view is the first responder for every field in the page, so
    /// without this the formatting bar would appear over the search box and the
    /// passphrase prompt as well.
    private var editorFocused = false
    /// The view to re-ask when it changes. Focus moving from the editor to
    /// the search box is not a responder change, so UIKit has no reason to
    /// call the getter again unless it is told to.
    private weak var editingSurface: UIView?
    /// While the app is away, a dial is refused rather than attempted. iOS
    /// gives about thirty seconds of background execution and the page's
    /// reconnect ladder is 31.75s long (ios.md §5), so without this the whole
    /// ladder would run in the background, succeed, and hand back a socket
    /// that suspension kills a moment later — which looks live until the first
    /// write fails.
    private var away = false

    init(config: ShellConfig, server: ServerRecord, onRepair: @escaping (String) -> Void) {
        self.config = config
        self.server = server
        self.onRepair = onRepair
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
        web.navigationDelegate = self
        web.scrollView.bounces = false
        // The page is a full-height app, not a document: WebKit's automatic
        // inset would add the safe areas a second time on top of the
        // constraints below.
        web.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(iOS 16.4, *) {
            // Safari's Web Inspector against this build. A release turns this
            // off: an inspectable web view is a console on the user's notes.
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
        //
        // The bottom is the keyboard's, and that is the whole of ios.md §7's
        // keyboard rule. A page pinned to the safe area keeps its full height
        // when the keyboard comes up, so WebKit reveals the caret the only way
        // left to it: by scrolling the document — which on a full-height app
        // means scrolling the header and the tab strip off the top of the
        // screen. Constrained to the keyboard instead, the page is simply
        // shorter while the keyboard is up, the chrome stays where it is, and
        // the editor's own scroller does the revealing.
        //
        // Two constraints rather than one because the guide sits at the view's
        // bottom edge when no keyboard is up, which is BELOW the safe area: the
        // required one is the floor, and the keyboard's is high-priority so it
        // can lose to it.
        let toKeyboard = web.bottomAnchor.constraint(equalTo: root.keyboardLayoutGuide.topAnchor)
        toKeyboard.priority = .defaultHigh
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(lessThanOrEqualTo: root.safeAreaLayoutGuide.bottomAnchor),
            toKeyboard,
            web.leadingAnchor.constraint(equalTo: root.safeAreaLayoutGuide.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: root.safeAreaLayoutGuide.trailingAnchor),
        ])
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        print("[shell] ledge -> \(server.destination), client \(config.client)")
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
        let key: DeviceKey.Held
        do {
            key = try DeviceKey.load()
        } catch {
            return fail(id, error.localizedDescription)
        }
        let next = SSHTransport(
            generation: gen,
            server: server,
            key: key,
            // The pinned case, always. Nothing in the running app can be asked
            // to trust a new key: that question belongs to pairing, where a
            // person is looking at the screen.
            hostKey: PinnedHostKey(openSSHLine: server.hostKey),
            log: { print("[shell] \($0)") }
        )
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
                        let why = error.localizedDescription
                        self.fail(id, why)
                        if SSHFailure.needsPairing(error) { self.onRepair(why) }
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

extension WebHost: WKNavigationDelegate {
    /// The accessory bar goes on after the page has loaded, because the view it
    /// attaches to does not exist before then (AccessoryBar.swift).
    ///
    /// Every load, not only the first: §5 makes foregrounding a reload, and a
    /// content view rebuilt by one would otherwise come back with the system's
    /// bar and no way to indent.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // A fresh page has focused nothing yet, and a reload that kept the flag
        // set would put the bar over whatever the new page focuses first.
        editorFocused = false
        if accessory == nil {
            accessory = AccessoryBar.make(
                tapped: { [weak self] id in
                    // The page decides what the id means; this end only says
                    // which button was pressed (mainview/lib/menu.ts).
                    self?.deliver(["t": "verb", "id": id])
                },
                // Not routed through the page: putting the keyboard away is
                // this end's business, and `endEditing` reaches the private
                // first responder that a blur() in the page would have to find
                // by guessing which element is focused.
                dismiss: { [weak self] in self?.webView.endEditing(true) }
            )
        }
        let surface = webView.installAccessoryView { [weak self] in
            self?.editorFocused == true ? self?.accessory : nil
        }
        guard let surface else {
            // Not fatal, and worth a line: the app keeps the system's bar, so
            // the symptom is a missing strip rather than anything broken, and
            // this is the only place that would say why.
            print("[shell] no accessory bar: the web view's content view was not found")
            return
        }
        editingSurface = surface
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
            reply(id, ["client": config.client, "destination": server.destination])
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
        // `editing` on the wire; `editorFocused` here, because UIViewController
        // already has an `editing` and a stored property cannot override it.
        case "@editing":
            let on = params["on"] as? Bool ?? false
            if on != editorFocused {
                editorFocused = on
                // The responder has not changed — focus moved between two
                // fields on one page — so UIKit will keep the bar it already
                // has until it is asked again.
                editingSurface?.reloadInputViews()
            }
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
        case "photos.pick":
            // The one call that waits on a person. The reply is deferred until
            // the picker closes, which the bridge already allows for — a call
            // is a promise and nothing about it is timed on this end.
            PhotoPicker.pick(over: self) { [weak self] base64 in self?.reply(id, base64) }
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
