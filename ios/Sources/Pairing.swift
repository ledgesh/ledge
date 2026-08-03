import UIKit

/// The screen a phone starts on until it has a server (ios.md §4).
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
    private let onPaired: (ServerRecord) -> Void

    private let scroll = UIScrollView()
    private let stack = UIStackView()
    private let reason = UILabel()
    private let keyBox = UITextView()
    private let field = UITextField()
    private let connect = UIButton(type: .system)
    private let status = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)

    private var held: DeviceKey.Held?
    private var dialing: SSHTransport?

    init(client: String, suggest: String, because: String?, onPaired: @escaping (ServerRecord) -> Void) {
        self.client = client
        self.suggestion = suggest
        self.onPaired = onPaired
        super.init(nibName: nil, bundle: nil)
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
    }

    // --- the layout -----------------------------------------------------------

    private func build() {
        stack.axis = .vertical
        stack.spacing = 12
        stack.alignment = .fill
        stack.isLayoutMarginsRelativeArrangement = true
        stack.layoutMargins = UIEdgeInsets(top: 24, left: 20, bottom: 24, right: 20)

        let title = UILabel()
        title.text = "Pair with a server"
        title.font = .preferredFont(forTextStyle: .largeTitle)
        title.adjustsFontForContentSizeCategory = true
        title.numberOfLines = 0

        reason.font = .preferredFont(forTextStyle: .callout)
        reason.textColor = .systemRed
        reason.numberOfLines = 0

        keyBox.isEditable = false
        keyBox.isScrollEnabled = false
        keyBox.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        keyBox.backgroundColor = .secondarySystemBackground
        keyBox.layer.cornerRadius = 8
        keyBox.textContainerInset = UIEdgeInsets(top: 10, left: 8, bottom: 10, right: 8)

        let copy = UIButton(type: .system)
        copy.setTitle("Copy line", for: .normal)
        copy.addTarget(self, action: #selector(copyLine), for: .touchUpInside)

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

        connect.setTitle("Connect", for: .normal)
        connect.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        connect.addTarget(self, action: #selector(start), for: .touchUpInside)

        status.font = .preferredFont(forTextStyle: .footnote)
        status.textColor = .secondaryLabel
        status.numberOfLines = 0

        for view in [
            title, reason,
            step("1. Add this line to ~/.ssh/authorized_keys on the server. It is the only thing that key can do."),
            keyBox, copy,
            step("2. Then say which machine, and which account on it."),
            field, connect, spinner, status,
        ] {
            stack.addArrangedSubview(view)
        }

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

    // --- the dial -------------------------------------------------------------

    @objc private func start() {
        view.endEditing(true)
        let destination = (field.text ?? "").trimmingCharacters(in: .whitespaces)
        if let problem = ServerRecord.problem(with: destination) { return say(problem) }
        guard let key = held else { return }

        busy(true)
        say("Connecting to \(destination)…")

        let confirming = ConfirmingHostKey { [weak self] offer, decide in
            self?.askAbout(offer, decide)
        }
        // A record with no pin: this dial is the one that finds out what the
        // pin should be.
        let candidate = ServerRecord(destination: destination, hostKey: "")
        let transport = SSHTransport(
            generation: 0,
            server: candidate,
            key: key,
            hostKey: confirming,
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
                        self.onPaired(ServerStore.pair(destination: destination, hostKey: accepted.openSSHLine))
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
        on ? spinner.startAnimating() : spinner.stopAnimating()
    }
}

extension PairingViewController: UITextFieldDelegate {
    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        start()
        return true
    }
}
