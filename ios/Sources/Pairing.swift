import NIOSSH
import UIKit

/// The form that adds a server (ios.md §4).
///
/// The root of the shell's stack on a phone with no servers at all, and a step
/// pushed off `ServerListViewController` otherwise. Which of the two it is
/// decides only whether there is a Back button: the form is the same either way.
///
/// Started from a pairing code, the address fields become the code's account,
/// host, port and fingerprints, and the host key is checked against the code
/// rather than asked about (remote.md §4b). The sign-in half is the same.
///
/// Pairing is a line the user copies or shares. The app shows its public key
/// and the whole `authorized_keys` line, forced command included, exactly as
/// remote.md §4 writes it. Getting that line onto the server is the user's
/// problem, and a harder one than on a Mac: the server is not this device, and
/// neither is the pasteboard's other end (ios.md §4).
///
/// The host key is confirmed here rather than scanned. `ssh-keyscan` fetches a
/// key and a later connection trusts what was written down; this asks about the
/// key of the connection in progress, and there is no continue-anyway button.
/// That absence is where remote.md §4's "no blind accept" lives on a phone,
/// rather than in the comparison, which is bytes either way.
final class PairingViewController: UIViewController {
    /// What the form starts from. `suggest` and `port` pre-fill the typed form:
    /// a record being paired again is a record whose address and port are
    /// already known. `tapped` marks a code that arrived as a link rather than
    /// through the camera.
    enum Start {
        case typed(suggest: String, port: Int)
        case code(PairingCode, tapped: Bool)
    }

    private let client: String
    private let startsFrom: Start
    private let onPaired: (ServerRecord) -> Void
    /// Opens the camera. Nil leaves the scan button off.
    private let onScan: (() -> Void)?

    private var code: PairingCode? {
        if case .code(let code, _) = startsFrom { return code }
        return nil
    }

    private let scroll = UIScrollView()
    private let stack = UIStackView()
    private let reason = UILabel()
    private let scan = UIButton(configuration: .filled())
    /// The key already pinned at the code's address, shown when it refuses the code.
    private lazy var pinned = fingerprint("")
    private let keyBox = UITextView()
    private let field = UITextField()
    private let portField = UITextField()
    private let authPicker = UISegmentedControl(items: ["A key", "A password"])
    private let passwordField = UITextField()
    private let keyStep = UILabel()
    private let copy = UIButton(type: .system)
    private let share = UIButton(type: .system)
    private let buttons = UIStackView()
    private let passwordNote = UILabel()
    private let connect = UIButton(type: .system)
    private let status = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)

    /// Which door the form is currently offering. The key is the default
    /// because it is the one this app can set up by itself: the enclave key
    /// already exists by the time this screen is drawn, and the password door
    /// needs a server that has been configured to allow one.
    private var byPassword: Bool { authPicker.selectedSegmentIndex == 1 }

    private var held: DeviceKey.Held?
    private var dialing: SSHTransport?

    init(
        client: String,
        start: Start,
        because: String?,
        onScan: (() -> Void)? = nil,
        onPaired: @escaping (ServerRecord) -> Void
    ) {
        self.client = client
        self.startsFrom = start
        self.onScan = onScan
        self.onPaired = onPaired
        super.init(nibName: nil, bundle: nil)
        // The navigation bar's, not a label in the stack: this screen sits
        // inside a navigation stack, which draws the title itself.
        title = "Pair with a server"
        reason.text = because
        reason.isHidden = because == nil
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("no storyboard") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        build()

        // The key is minted on the first launch that reaches this screen, which
        // is the first launch. A failure here is not something a user can fix,
        // so it is reported rather than retried.
        do {
            let key = try DeviceKey.load()
            held = key
            keyBox.text = DeviceKey.authorizedKeysLine(key, client: client)
            // Also on the console, which is the other way off the phone: a
            // public key, and the one string this screen exists to hand over.
            // A Mac with a cable can read it without retyping base64. Where it
            // is kept goes with it, because "which key is this" is the first
            // question about anything that signs.
            print("[pair] key in \(key.isEnclave ? "the Secure Enclave" : "software")")
            print("[pair] \(keyBox.text ?? "")")
            if !key.isEnclave {
                say("This build is using a software key: the Simulator has no Secure Enclave.")
            }
        } catch {
            keyBox.text = ""
            say(error.localizedDescription)
            connect.isEnabled = false
        }
        switch startsFrom {
        case .typed(let suggest, let port):
            field.text = suggest
            // Blank for ssh's default, which is what an empty field already
            // means: printing 0 into it would be a port nobody can connect to.
            portField.text = port == 0 ? "" : String(port)
        case .code(let code, _):
            if case .conflict(let pinned) = code.match(ServerStore.known()) { refuse(code, pinned: pinned) }
        }
    }

    /// The first rule of remote.md §4b: a code that does not name a key already
    /// pinned at its address is refused, and the pin stays.
    private func refuse(_ code: PairingCode, pinned: String) {
        reason.text = """
            Ledge already has a different host key pinned for \(code.host), and this code does not name it, so Ledge will not use the code.
            If that server's host key really changed, connect to it from the server list, and Ledge shows you the new key to check.
            """
        reason.isHidden = false
        self.pinned.text = pinned
        self.pinned.superview?.isHidden = false
        connect.isEnabled = false
    }

    // --- the layout -----------------------------------------------------------

    private func build() {
        stack.axis = .vertical
        stack.spacing = 12
        stack.alignment = .fill
        stack.isLayoutMarginsRelativeArrangement = true
        stack.layoutMargins = UIEdgeInsets(top: 24, left: 20, bottom: 24, right: 20)

        reason.font = .preferredFont(forTextStyle: .callout)
        reason.textColor = .systemRed
        reason.numberOfLines = 0

        keyBox.isEditable = false
        keyBox.isScrollEnabled = false
        keyBox.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        keyBox.backgroundColor = .secondarySystemBackground
        keyBox.layer.cornerRadius = 8
        keyBox.textContainerInset = UIEdgeInsets(top: 10, left: 8, bottom: 10, right: 8)

        copy.setTitle("Copy line", for: .normal)
        copy.addTarget(self, action: #selector(copyLine), for: .touchUpInside)

        // Beside the copy and not instead of it. A pasteboard ends at the
        // device holding it, and the machine this line has to be pasted on is
        // the one that is not in the user's hand: without a sheet the way off
        // the phone is AirDrop by way of another app, or retyping base64
        // (ios.md §4).
        share.setTitle("Share line", for: .normal)
        share.addTarget(self, action: #selector(shareLine), for: .touchUpInside)

        buttons.axis = .horizontal
        buttons.spacing = 16
        buttons.alignment = .center
        buttons.addArrangedSubview(copy)
        buttons.addArrangedSubview(share)
        // A spacer, so two buttons sit together at the leading edge rather than
        // splitting the width between them.
        buttons.addArrangedSubview(UIView())

        authPicker.selectedSegmentIndex = 0
        authPicker.addTarget(self, action: #selector(authChanged), for: .valueChanged)

        passwordField.placeholder = "Password for that account"
        passwordField.borderStyle = .roundedRect
        passwordField.isSecureTextEntry = true
        passwordField.autocapitalizationType = .none
        passwordField.autocorrectionType = .no
        passwordField.spellCheckingType = .no
        // Off rather than .password: this field is a credential for somebody
        // else's machine, and the strong-password and saved-logins flows both
        // offer the wrong secret from a convincing list.
        passwordField.textContentType = .none
        passwordField.returnKeyType = .go
        passwordField.delegate = self

        passwordNote.text = "Kept in this device's keychain, where only Ledge can read it."
        passwordNote.font = .preferredFont(forTextStyle: .footnote)
        passwordNote.textColor = .secondaryLabel
        passwordNote.numberOfLines = 0

        field.placeholder = "user@host"
        field.borderStyle = .roundedRect
        field.font = .monospacedSystemFont(ofSize: 15, weight: .regular)
        // A destination is not prose: every one of these would turn ledge@box
        // into Ledge@box or offer to complete it.
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.smartQuotesType = .no
        field.smartDashesType = .no
        field.keyboardType = .emailAddress
        field.returnKeyType = .go
        field.delegate = self

        // Its own field for the Mac's reason (shared/connections.ts): a
        // destination is not a `host:port`. Blank is the ordinary answer.
        portField.placeholder = "Port (leave blank for 22)"
        portField.borderStyle = .roundedRect
        portField.font = .monospacedSystemFont(ofSize: 15, weight: .regular)
        portField.keyboardType = .numberPad
        portField.delegate = self

        connect.setTitle("Connect", for: .normal)
        connect.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        connect.addTarget(self, action: #selector(start), for: .touchUpInside)

        status.font = .preferredFont(forTextStyle: .footnote)
        status.textColor = .secondaryLabel
        status.numberOfLines = 0

        // What the line is comes first. A reader who does not know it carries
        // this device's public key cannot tell why the server needs it, and a
        // step that opens on hardening explains the option before the thing it
        // is an option on.
        //
        // Then what the restriction is good for, rather than a claim that the
        // key is harmless: it narrows ssh's feature set around the protocol,
        // and running code is what the protocol behind the forced command is
        // for (remote.md §4a). "Cannot open a shell" was true at the ssh layer
        // and read as a guarantee Ledge does not make.
        keyStep.text =
            (code == nil ? "2. " : "")
            + "Add this line to ~/.ssh/authorized_keys on the server. It is this device's public key, which is how that server knows to let this device in. The restrict prefix keeps the key from forwarding ports or copying files."
        keyStep.font = .preferredFont(forTextStyle: .body)
        keyStep.adjustsFontForContentSizeCategory = true
        keyStep.numberOfLines = 0

        // The machine first and the credential second, which is the order the
        // Mac's form asks in and the order the sentences read in: "the password
        // for that account" needs the account to have been named.
        let machine: [UIView]
        switch startsFrom {
        case .typed:
            machine = (onScan == nil ? [] : [scanButton(), footnote("ledge-server pair shows a code on the server.")])
                + [step("1. Which machine, and which account on it."), field, portField]
        case .code(let code, let tapped):
            machine = (tapped ? [linkWarning()] : []) + [summary(of: code)]
        }
        for view in [reason] + machine + [
            step("Sign in with"),
            authPicker,
            keyStep, keyBox, buttons,
            passwordField, passwordNote,
            connect, spinner, status,
        ] {
            stack.addArrangedSubview(view)
        }
        showAuthFields()

        scroll.addSubview(stack)
        view.addSubview(scroll)
        scroll.translatesAutoresizingMaskIntoConstraints = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            // The keyboard, not the safe area: the destination field is the
            // last thing on this screen and typing into it must not push it
            // under the keys.
            scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
        ])
    }

    private func step(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        label.numberOfLines = 0
        return label
    }

    private func footnote(_ text: String) -> UILabel {
        let label = step(text)
        label.font = .preferredFont(forTextStyle: .footnote)
        label.textColor = .secondaryLabel
        return label
    }

    private func scanButton() -> UIButton {
        scan.configuration?.title = "Scan a pairing code"
        scan.configuration?.image = UIImage(systemName: "qrcode.viewfinder")
        scan.configuration?.imagePadding = 8
        scan.configuration?.buttonSize = .large
        scan.addAction(UIAction { [weak self] _ in self?.onScan?() }, for: .touchUpInside)
        return scan
    }

    /// The third rule of remote.md §4b. A code the camera read came from a
    /// screen in front of the person holding the phone; a link could have been
    /// sent by anyone, including the owner of a lookalike server.
    private func linkWarning() -> UILabel {
        let label = step(
            "You opened this code from a link, and anyone can send one. Connect only if the link came from your own server."
        )
        label.font = .preferredFont(forTextStyle: .callout)
        label.textColor = .systemOrange
        return label
    }

    /// The code's fields, one caption and value per row. A caption above its
    /// value rather than beside it, so a long host name or a fingerprint wraps
    /// at any text size.
    private func summary(of code: PairingCode) -> UIView {
        let rows = UIStackView()
        rows.axis = .vertical
        rows.spacing = 10
        rows.isLayoutMarginsRelativeArrangement = true
        rows.layoutMargins = UIEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)
        rows.backgroundColor = .secondarySystemBackground
        rows.layer.cornerRadius = 10
        let fields: [(String, [UILabel])] = [
            ("Account", [step(code.user)]),
            ("Host", [step(code.host)]),
            ("Port", [step(code.port == 0 ? "22" : String(code.port))]),
            (code.fingerprints.count == 1 ? "Host key" : "Host keys", code.fingerprints.map(fingerprint)),
            ("Pinned in Ledge", [pinned]),
        ]
        for (caption, values) in fields {
            let pair = UIStackView(arrangedSubviews: [footnote(caption)] + values)
            pair.axis = .vertical
            pair.spacing = 2
            rows.addArrangedSubview(pair)
        }
        pinned.textColor = .systemRed
        pinned.superview?.isHidden = true
        rows.addArrangedSubview(footnote("Ledge signs in only if the server offers one of these host keys."))
        return rows
    }

    /// Monospaced and broken between characters, never hyphenated: a hyphen a
    /// label adds reads as part of the fingerprint.
    private func fingerprint(_ text: String) -> UILabel {
        let label = step(text)
        label.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: 13, weight: .regular))
        label.lineBreakMode = .byCharWrapping
        return label
    }

    private func say(_ text: String) {
        status.text = text
    }

    @objc private func copyLine() {
        Natives.clipboardWrite(keyBox.text)
        say("Copied. Paste it on the server, then connect.")
    }

    /// The line, to anywhere the device can send a string.
    ///
    /// No status line after it: the sheet is its own feedback, it may be
    /// cancelled, and what happens after AirDrop is on the other machine.
    @objc private func shareLine() {
        Natives.share(keyBox.text, over: self, from: share)
    }

    @objc private func authChanged() {
        say("")
        showAuthFields()
    }

    /// One door's fields at a time. Hidden rather than removed, because a
    /// stack view collapses a hidden arranged subview and this way the order
    /// is declared once, above.
    private func showAuthFields() {
        for view in [keyStep, keyBox, buttons] { view.isHidden = byPassword }
        for view in [passwordField, passwordNote] { view.isHidden = !byPassword }
    }

    // --- the dial -------------------------------------------------------------

    /// One dial: where to, how the offered host key is judged, and how the
    /// result is stored once the rest of the connection has worked.
    private struct Dial {
        let destination: String
        let port: Int
        let hostKey: NIOSSHClientServerAuthenticationDelegate
        /// The line of the key the dial accepted, read after it succeeds.
        let accepted: () -> String?
        /// Stores the pin and the door, or answers nil when the list refuses.
        let store: (_ hostKey: String, _ auth: String, _ password: String) -> ServerRecord?
    }

    private func typedDial() -> Dial? {
        let destination = (field.text ?? "").trimmingCharacters(in: .whitespaces)
        if let problem = ServerRecord.problem(with: destination) {
            say(problem)
            return nil
        }
        let typed = (portField.text ?? "").trimmingCharacters(in: .whitespaces)
        // Blank means "ssh decides" and is not a failure; anything else has to
        // be a port rather than quietly becoming one.
        let port = typed.isEmpty ? 0 : Int(typed) ?? -1
        if port < 0 || port > 65535 {
            say("A port is a whole number from 1 to 65535.")
            return nil
        }
        let confirming = ConfirmingHostKey { [weak self] offer, decide in
            self?.askAbout(offer, decide)
        }
        return Dial(destination: destination, port: port, hostKey: confirming, accepted: { confirming.accepted?.openSSHLine }) {
            // By address, so re-pairing a server whose host key changed re-pins
            // the record that is already there rather than leaving a duplicate.
            ServerStore.pair(destination: destination, port: port, hostKey: $0, auth: $1, password: $2)
        }
    }

    /// The code's dial. The rule for the stored list is `PairingCode.match`.
    private func codeDial(_ code: PairingCode) -> Dial? {
        let hostKey: NIOSSHClientServerAuthenticationDelegate
        let accepted: () -> String?
        switch code.match(ServerStore.known()) {
        case .conflict(let pinned):
            refuse(code, pinned: pinned)
            return nil
        case .pinned(let id):
            // The pin decides, as on every other dial to this record.
            guard let pin = ServerStore.load().servers.first(where: { $0.id == id })?.hostKey else { return nil }
            hostKey = PinnedHostKey(openSSHLine: pin)
            accepted = { pin }
        case .new, .unpinned:
            let checking = CodeHostKey(fingerprints: code.fingerprints)
            hostKey = checking
            accepted = { checking.accepted?.openSSHLine }
        }
        return Dial(destination: code.destination, port: code.port, hostKey: hostKey, accepted: accepted) {
            ServerStore.pair(code: code, hostKey: $0, auth: $1, password: $2)
        }
    }

    @objc private func start() {
        view.endEditing(true)
        let planned: Dial?
        if let code { planned = codeDial(code) } else { planned = typedDial() }
        guard let dial = planned, let key = held else { return }
        // Empty here rather than at the far end: a blank password reaches a
        // server as a refusal, and the refusal it makes is about the server.
        let password = byPassword ? (passwordField.text ?? "") : nil
        if let password, password.isEmpty { return say("Enter the password for that account.") }

        busy(true)
        say("Connecting to \(dial.destination)…")

        // A record with no pin: the dial's host key delegate decides.
        let candidate = ServerRecord(destination: dial.destination, port: dial.port, hostKey: "")
        let transport = SSHTransport(
            generation: 0,
            server: candidate,
            key: key,
            hostKey: dial.hostKey,
            password: password,
            log: { print("[pair] \($0)") }
        )
        dialing = transport
        transport.open(
            ready: { [weak self] result in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.busy(false)
                    // Closed either way: this was a question, and the
                    // connection the app runs on is the page's to open.
                    transport.close()
                    self.dialing = nil
                    switch result {
                    case .failure(let error):
                        self.say(error.localizedDescription)
                    case .success:
                        guard let accepted = dial.accepted() else {
                            return self.say("That server did not offer a host key.")
                        }
                        guard let record = dial.store(accepted, password == nil ? "key" : "password", password ?? "")
                        else {
                            if let code = self.code, case .conflict(let pinned) = code.match(ServerStore.known()) {
                                return self.refuse(code, pinned: pinned)
                            }
                            return self.say("The server list changed while Ledge was connecting. Open the code again.")
                        }
                        self.onPaired(record)
                    }
                }
            },
            bytes: { _ in },
            end: {}
        )
    }

    /// The one question pairing asks, and the two answers it takes.
    private func askAbout(_ offer: HostKeyOffer, _ decide: @escaping (Bool) -> Void) {
        let sheet = UIAlertController(
            title: "Is this the server?",
            message: """
                \(offer.fingerprint)

                Run this on the server to compare:
                ssh-keygen -lf /etc/ssh/ssh_host_\(offer.keyType.contains("ed25519") ? "ed25519" : "ecdsa")_key.pub
                """,
            preferredStyle: .alert
        )
        sheet.addAction(UIAlertAction(title: "Trust", style: .default) { _ in decide(true) })
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in decide(false) })
        present(sheet, animated: true)
    }

    private func busy(_ on: Bool) {
        connect.isEnabled = !on
        field.isEnabled = !on
        passwordField.isEnabled = !on
        authPicker.isEnabled = !on
        on ? spinner.startAnimating() : spinner.stopAnimating()
    }
}

extension PairingViewController: UITextFieldDelegate {
    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        start()
        return true
    }
}
