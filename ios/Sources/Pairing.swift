import UIKit

/// The form that adds a server (ios.md §4).
///
/// The root of the shell's stack on a phone with no servers at all, and a step
/// pushed off `ServerListViewController` otherwise. Which of the two it is
/// decides only whether there is a Back button: the form is the same either way.
///
/// Pairing is a line the user copies. The app shows its public key and the
/// whole `authorized_keys` line, forced command included, exactly as
/// remote.md §4 writes it; getting that line onto the server is the user's
/// problem in v1, which is the same problem the Mac client has today.
///
/// The host key is confirmed here rather than scanned. `ssh-keyscan` fetches a
/// key and a later connection trusts what was written down; this asks about the
/// key of the connection in progress, and there is no button that says continue
/// anyway. That is where remote.md §4's "no blind accept" lives on a phone: not
/// in the comparison, which is bytes, but in the fact that the interface offers
/// no third answer.
final class PairingViewController: UIViewController {
    private let client: String
    private let suggestion: String
    /// Where sshd listens on the suggested destination, or 0 for ssh's default.
    /// Carried beside the address because the two were pinned together: a
    /// record being paired again is a record whose port is already known.
    private let suggestedPort: Int
    private let onPaired: (ServerRecord) -> Void

    private let scroll = UIScrollView()
    private let stack = UIStackView()
    private let reason = UILabel()
    private let keyBox = UITextView()
    private let field = UITextField()
    private let portField = UITextField()
    private let authPicker = UISegmentedControl(items: ["A key", "A password"])
    private let passwordField = UITextField()
    private let keyStep = UILabel()
    private let copy = UIButton(type: .system)
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
        suggest: String,
        suggestPort: Int = 0,
        because: String?,
        onPaired: @escaping (ServerRecord) -> Void
    ) {
        self.client = client
        self.suggestion = suggest
        self.suggestedPort = suggestPort
        self.onPaired = onPaired
        super.init(nibName: nil, bundle: nil)
        // The navigation bar's, not a label in the stack: this screen is inside
        // a stack now, and a title drawn twice is a title drawn wrong.
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
        // so it is said plainly instead of retried.
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
        field.text = suggestion
        // Blank for ssh's default, which is what an empty field already means:
        // printing 0 into it would be a port nobody can connect to.
        portField.text = suggestedPort == 0 ? "" : String(suggestedPort)
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

        // Says what the restriction is good for rather than claiming the key is
        // harmless: it narrows ssh's feature set around the protocol, and the
        // protocol behind the forced command runs code by design (remote.md
        // §4a).
        keyStep.text =
            "2. Add this line to ~/.ssh/authorized_keys on the server. It stops that key forwarding ports, copying files, or opening a shell."
        keyStep.font = .preferredFont(forTextStyle: .body)
        keyStep.adjustsFontForContentSizeCategory = true
        keyStep.numberOfLines = 0

        // The machine first and the credential second, which is the order the
        // Mac's form asks in and the order the sentences read in: "the password
        // for that account" needs the account to have been named.
        for view in [
            reason,
            step("1. Which machine, and which account on it."),
            field, portField,
            step("Sign in with"),
            authPicker,
            keyStep, keyBox, copy,
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

    private func say(_ text: String) {
        status.text = text
    }

    @objc private func copyLine() {
        Natives.clipboardWrite(keyBox.text)
        say("Copied. Paste it on the server, then connect.")
    }

    @objc private func authChanged() {
        say("")
        showAuthFields()
    }

    /// One door's fields at a time. Hidden rather than removed, because a
    /// stack view collapses a hidden arranged subview and this way the order
    /// is declared once, above.
    private func showAuthFields() {
        for view in [keyStep, keyBox, copy] { view.isHidden = byPassword }
        for view in [passwordField, passwordNote] { view.isHidden = !byPassword }
    }

    // --- the dial -------------------------------------------------------------

    @objc private func start() {
        view.endEditing(true)
        let destination = (field.text ?? "").trimmingCharacters(in: .whitespaces)
        if let problem = ServerRecord.problem(with: destination) { return say(problem) }
        let typed = (portField.text ?? "").trimmingCharacters(in: .whitespaces)
        // Blank means "ssh decides" and is not a failure; anything else has to
        // be a port rather than quietly becoming one.
        let port = typed.isEmpty ? 0 : Int(typed) ?? -1
        if port < 0 || port > 65535 { return say("A port is a whole number from 1 to 65535.") }
        guard let key = held else { return }
        // Empty here rather than at the far end: a blank password reaches a
        // server as a refusal, and the refusal it makes is about the server.
        let password = byPassword ? (passwordField.text ?? "") : nil
        if let password, password.isEmpty { return say("Enter the password for that account.") }

        busy(true)
        say("Connecting to \(destination)…")

        let confirming = ConfirmingHostKey { [weak self] offer, decide in
            self?.askAbout(offer, decide)
        }
        // A record with no pin: this dial is the one that finds out what the
        // pin should be.
        let candidate = ServerRecord(destination: destination, port: port, hostKey: "")
        let transport = SSHTransport(
            generation: 0,
            server: candidate,
            key: key,
            hostKey: confirming,
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
                        guard let accepted = confirming.accepted else {
                            return self.say("That server did not offer a host key.")
                        }
                        // By address, so re-pairing a server whose host key
                        // changed re-pins the record that is already there
                        // rather than leaving a duplicate beside it.
                        self.onPaired(
                            ServerStore.pair(
                                destination: destination,
                                port: port,
                                hostKey: accepted.openSSHLine,
                                auth: password == nil ? "key" : "password",
                                password: password ?? ""
                            )
                        )
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
