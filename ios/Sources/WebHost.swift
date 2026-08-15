import UIKit
import WebKit

/// Which keyboard the keyboard is over, as the page reports it (`@focus`, and
/// `BarFace` in mainview/lib/nativeBridge.ts). The raw values are the wire's.
enum BarFace: String {
    /// Some other field in the page — a search box, a rename, a passphrase —
    /// where the note's verbs would act on the note behind the overlay. Not
    /// "no bar": the strip is still there, carrying the one button that is
    /// never wrong (`AccessoryBar.bare`).
    case none
    /// The note itself: the Markdown face.
    case note
    /// A running block's terminal, which lives INSIDE the note's editor and so
    /// cannot be told apart from it by anything this end can see.
    case run
}

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
    /// Which server the next `@open` dials. A var because the page edits the
    /// list this came from and may point it somewhere else (`servers.save`);
    /// the page reloads itself afterwards, so the change is read at the next
    /// `@hello` and the next dial rather than applied to a live socket.
    private var server: ServerRecord
    /// Called when a dial fails for a reason retrying cannot fix: a host key
    /// that changed, or a key the server will not accept. The page's ladder
    /// would otherwise spend the next half minute asking the same question.
    private let onRepair: (String) -> Void
    /// Called when the list the page saved has nothing left in it to dial.
    /// There is no local server on a phone to fall back to (remote.md §8), so
    /// removing the last one means pairing again.
    private let onUnpaired: () -> Void
    private let scheme = BundleScheme()
    private var webView: WKWebView!

    private var socket: SSHTransport?
    /// The dial that asks a host for its key and hangs up. Held only so it is
    /// not deallocated mid-handshake; it is never the page's byte stream.
    private var probing: SSHTransport?
    private var generation = 0
    /// The three strips above the keyboard (ios.md §7). Built once and held
    /// here: they are captured by the accessory getter installed on the web
    /// view's content view, so they have to outlive the call that installs it.
    private var noteBar: UIView?
    private var runBar: UIView?
    private var bareBar: UIView?
    /// Which of them the keyboard is over, as the page reports it (`@focus`).
    /// One content view is the first responder for every field in the page, so
    /// without this the formatting bar would appear over the search box, the
    /// passphrase prompt and a running block's terminal as well.
    private var face: BarFace = .none
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

    init(
        config: ShellConfig,
        server: ServerRecord,
        onRepair: @escaping (String) -> Void,
        onUnpaired: @escaping () -> Void
    ) {
        self.config = config
        self.server = server
        self.onRepair = onRepair
        self.onUnpaired = onUnpaired
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
        // The label is here because it is otherwise invisible from this device:
        // what it names is what the OTHER clients on that server show
        // (remote.md §7), so this console line is the only place a probe can
        // read what this phone is about to call itself.
        print("[shell] ledge -> \(server.destination), client \(config.client), as \"\(ShellConfig.label)\"")
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
            // Read here and not held between connections: a password is in the
            // keychain, and this is the moment it is needed (`ServerPassword`).
            // Nil for a record on the key door, and nil for one that says
            // password and has none — which fails as a refusal naming the
            // server rather than as a dial that offers an empty string.
            password: server.usesPassword ? ServerPassword.read(server.id) : nil,
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

    // --- the server list (remote.md §8) ---------------------------------------

    /// Ask a host for its key, and hang up.
    ///
    /// `connectionProbe`'s answer, in the shape `bun/connections.ts` gives it,
    /// so the same dialog reads both. There is no `ssh-keyscan` on a phone, so
    /// this is a dial — but only as far as key exchange, which happens before
    /// authentication: the fingerprint arrives without this phone's key going
    /// on the wire and without the server having accepted it yet, which is
    /// exactly what a keyscan is (`CapturingHostKey`).
    ///
    /// Generation 0, like pairing's: a page socket's generation is always
    /// positive, so a `@close` for one can never reach this.
    private func probe(_ id: Int, _ destination: String, _ port: Int) {
        let answer: (String, String, String, String) -> Void = { [weak self] key, print_, type, error in
            self?.reply(id, ["hostKey": key, "fingerprint": print_, "keyType": type, "error": error])
        }
        if let problem = ServerRecord.problem(with: destination) { return answer("", "", "", problem) }
        let key: DeviceKey.Held
        do {
            key = try DeviceKey.load()
        } catch {
            return answer("", "", "", error.localizedDescription)
        }
        let capture = CapturingHostKey()
        let transport = SSHTransport(
            generation: 0,
            server: ServerRecord(destination: destination, port: port, hostKey: ""),
            key: key,
            hostKey: capture,
            log: { print("[probe] \($0)") }
        )
        probing = transport
        transport.open(
            ready: { [weak self] result in
                DispatchQueue.main.async {
                    guard let self else { return }
                    transport.close()
                    self.probing = nil
                    // The refusal IS the success: the delegate above declines
                    // every key, so a captured offer means the handshake got far
                    // enough to ask, and anything else is a host that could not
                    // be reached at all.
                    if let offer = capture.offered {
                        return answer(offer.openSSHLine, offer.fingerprint, offer.keyType, "")
                    }
                    if case .failure(let error) = result {
                        return answer("", "", "", error.localizedDescription)
                    }
                    answer("", "", "", "\(destination) did not offer a host key.")
                }
            },
            bytes: { _ in },
            end: {}
        )
    }

    /// Take the list the page saved, and point at whatever it selected.
    ///
    /// The page owns every rule about what may be added, renamed or removed —
    /// they are the same rules the Mac's `connectionManager.ts` enforces, in the
    /// same language (mainview/lib/nativeBridge.ts). This end stores the bytes
    /// and reads two fields out of the selection: an address to dial, and a key
    /// to pin.
    private func saveServers(_ id: Int, _ params: [String: Any]) {
        let rows = params["servers"] as? [[String: Any]] ?? []
        let servers = rows.map {
            ServerRecord(
                id: $0["id"] as? String ?? "",
                name: $0["name"] as? String ?? "",
                destination: $0["destination"] as? String ?? "",
                port: $0["port"] as? Int ?? 0,
                hostKey: $0["hostKey"] as? String ?? "",
                auth: $0["auth"] as? String ?? "key"
            )
        }
        ServerStore.save(servers: servers, selected: params["selected"] as? String ?? "")
        let now = ServerStore.selected()
        if let now { server = now }
        reply(id, ["ok": true])
        // After the reply, because this swaps the window's root view controller
        // out from under the web view that asked.
        if now == nil { onUnpaired() }
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
        face = .none
        if noteBar == nil {
            noteBar = AccessoryBar.markdown(
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
        if runBar == nil {
            // The same contract one domain along: a key name, and what it sends
            // is the page's terminal's business (mainview/editor/inlineTerm.ts).
            runBar = AccessoryBar.run(pressed: { [weak self] key in
                self?.deliver(["t": "key", "k": key])
            })
        }
        if bareBar == nil {
            bareBar = AccessoryBar.bare(dismiss: { [weak self] in self?.webView.endEditing(true) })
        }
        let surface = webView.installAccessoryView { [weak self] in
            guard let self else { return nil }
            switch self.face {
            case .none: return self.bareBar
            case .note: return self.noteBar
            case .run: return self.runBar
            }
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
            // The `authorized_keys` line goes with the client id because it is
            // the same kind of fact: about this DEVICE, asked once, and needed
            // before a connection exists. The page shows it in the form that
            // adds a server, since installing it there is the step before any
            // new connection can work (ios.md §4).
            let line = (try? DeviceKey.load()).map { DeviceKey.authorizedKeysLine($0, client: config.client) } ?? ""
            reply(id, [
                "client": config.client,
                // What the other clients on that server will call this phone
                // (shared/wire.ts `Hello.label`). Asked here rather than pushed
                // later because it travels in the handshake, and the handshake
                // is the next thing that happens.
                "label": ShellConfig.label,
                "destination": server.destination,
                "key": line,
            ])
        case "@open":
            open(id)
        case "servers.list":
            let stored = ServerStore.load()
            reply(id, [
                "servers": stored.servers.map {
                    [
                        "id": $0.id, "name": $0.name, "destination": $0.destination, "port": $0.port,
                        "hostKey": $0.hostKey, "auth": $0.auth,
                    ]
                },
                "selected": stored.selected,
            ])
        case "servers.save":
            saveServers(id, params)
        // Its own call rather than a field on `servers.save`, so that the list
        // the page hands back on every rename does not carry a password through
        // the bridge every time. A string stores one and null forgets it; there
        // is no call that reads one back (`ServerPassword`).
        case "servers.password":
            let server = params["id"] as? String ?? ""
            if let password = params["password"] as? String {
                reply(id, ["ok": ServerPassword.write(server, password)])
            } else {
                ServerPassword.forget(server)
                reply(id, ["ok": true])
            }
        case "servers.probe":
            probe(
                id,
                (params["destination"] as? String ?? "").trimmingCharacters(in: .whitespaces),
                params["port"] as? Int ?? 0
            )
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
        case "@focus":
            // An unknown face is no face: a page saying something this build
            // does not understand must not leave the previous bar over it.
            let next = BarFace(rawValue: params["over"] as? String ?? "") ?? .none
            if next != face {
                face = next
                // The responder has not changed — focus moved between two
                // fields on one page, or from the note into the panel of a run
                // inside it — so UIKit will keep the bar it already has until it
                // is asked again.
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
