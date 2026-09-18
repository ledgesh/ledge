import UIKit

/// The commands that turn a Mac or a Linux machine into a Ledge server (ios.md §4).
///
/// The phone cannot run them, so the screen hands them to a computer that can,
/// by the pasteboard or the share sheet. The last command prints a pairing code,
/// and the scan button reads it.
final class ServerSetupViewController: UIViewController {
    /// ledge.sh/server.sh, then the pair verb by its full path, because the
    /// PATH line the installer adds reaches only new terminals. One set for
    /// Linux and a Mac alike: the installer brings its own Bun, and both apps'
    /// ssh command puts `~/.ledge/.server/bin` on PATH (remote.md §11).
    static let commands = [
        "curl -fsSL https://ledge.sh/server.sh | sh",
        "~/.ledge/.server/bin/ledge pair",
    ]

    private let onScan: () -> Void
    private let onExisting: () -> Void

    private let scroll = UIScrollView()
    private let stack = UIStackView()
    private let steps = UILabel()
    private let macNote = UILabel()
    private let box = UITextView()
    private let buttons = UIStackView()
    private let copy = UIButton(type: .system)
    private let share = UIButton(type: .system)
    private let copied = UILabel()
    private let requirements = UILabel()

    init(onScan: @escaping () -> Void, onExisting: @escaping () -> Void) {
        self.onScan = onScan
        self.onExisting = onExisting
        super.init(nibName: nil, bundle: nil)
        title = "Set up a server"
        // `.automatic` would take the welcome screen's `.never`.
        navigationItem.largeTitleDisplayMode = .always
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("no storyboard") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        build()
    }

    private func build() {
        stack.axis = .vertical
        stack.alignment = .fill
        stack.spacing = 12
        stack.isLayoutMarginsRelativeArrangement = true
        stack.layoutMargins = UIEdgeInsets(top: 16, left: 20, bottom: 24, right: 20)

        style(steps, .body)
        // The installer refuses root: the server lives in the home of the
        // account Ledge signs in to.
        steps.text = "In a terminal on that machine, signed in as the account Ledge should use rather than root, run these two commands. Neither needs sudo."
        style(macNote, .body)
        // Remote Login is off on a new Mac. A Mac with the app has a server
        // already, and the app's Install Shell Command writes its launcher to
        // the same `~/.ledge/.server/bin/ledge` (remote.md §11), so the second
        // command works after it unchanged.
        macNote.text = "On a Mac, turn on Remote Login first, in System Settings under General, then Sharing. If the Ledge app runs on that Mac, choose Install Shell Command (ledge) in the app instead of the first command."

        buttons.addArrangedSubview(copy)
        buttons.addArrangedSubview(share)
        buttons.addArrangedSubview(UIView())
        buttons.axis = .horizontal
        buttons.spacing = 16
        // Said below the buttons rather than in the button's title, which would
        // change its width and move Share out from under a second tap.
        copy.setTitle("Copy commands", for: .normal)
        copy.addAction(
            UIAction { [weak self] _ in
                guard let self else { return }
                Natives.clipboardWrite(Self.commands.joined(separator: "\n"))
                self.copied.isHidden = false
                self.stack.setCustomSpacing(4, after: self.buttons)
            },
            for: .touchUpInside
        )
        share.setTitle("Share commands", for: .normal)
        share.addAction(
            UIAction { [weak self] _ in
                guard let self else { return }
                Natives.share(Self.commands.joined(separator: "\n"), over: self, from: self.share)
            },
            for: .touchUpInside
        )

        let scan = UIButton(configuration: .filled())
        scan.configuration?.title = "Scan the pairing code"
        scan.configuration?.image = UIImage(systemName: "qrcode.viewfinder")
        scan.configuration?.imagePadding = 8
        scan.configuration?.buttonSize = .large
        scan.addAction(UIAction { [weak self] _ in self?.onScan() }, for: .touchUpInside)

        // For someone who opened this screen and has a server after all.
        let existing = UIButton(configuration: .plain())
        existing.configuration?.title = "Add an existing server"
        existing.addAction(UIAction { [weak self] _ in self?.onExisting() }, for: .touchUpInside)

        style(copied, .footnote)
        copied.text = "Copied. Paste them into a terminal on the server."
        copied.textColor = .secondaryLabel
        style(requirements, .footnote)
        requirements.textColor = .secondaryLabel
        requirements.text = "The server runs on macOS, or on Linux with glibc 2.29 or newer (Debian 11, Ubuntu 20.04, RHEL 9, or later), on arm64 or x64. The machine needs sshd running, and this device has to be able to reach its address."

        box.isEditable = false
        box.isScrollEnabled = false
        box.adjustsFontForContentSizeCategory = true
        box.backgroundColor = .secondarySystemBackground
        box.layer.cornerRadius = 8
        box.textContainerInset = UIEdgeInsets(top: 10, left: 8, bottom: 10, right: 8)
        box.attributedText = commandText(Self.commands)

        let intro = UILabel()
        style(intro, .body)
        intro.text = "A server is a Mac or Linux machine that stays on and accepts ssh, such as a VPS or a computer at home."
        let last = UILabel()
        style(last, .body)
        last.text = "The second command shows a pairing code for that account."
        copied.isHidden = true

        for view in [intro, steps, box, buttons, copied, last, macNote, scan, requirements, existing] {
            stack.addArrangedSubview(view)
        }
        stack.setCustomSpacing(16, after: intro)
        stack.setCustomSpacing(4, after: box)
        stack.setCustomSpacing(20, after: buttons)
        stack.setCustomSpacing(20, after: copied)
        stack.setCustomSpacing(20, after: macNote)
        stack.setCustomSpacing(16, after: scan)
        stack.setCustomSpacing(24, after: requirements)

        scroll.addSubview(stack)
        view.addSubview(scroll)
        scroll.translatesAutoresizingMaskIntoConstraints = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
        ])
    }

    /// One paragraph per command. A command too long for the line wraps at a
    /// space with its continuation indented, and is never hyphenated: a hyphen
    /// UIKit adds would read as part of the command.
    private func commandText(_ commands: [String]) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.headIndent = 16
        paragraph.paragraphSpacing = 6
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.hyphenationFactor = 0
        paragraph.usesDefaultHyphenation = false
        let font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: 13, weight: .regular))
        return NSAttributedString(
            string: commands.joined(separator: "\n"),
            attributes: [.font: font, .paragraphStyle: paragraph, .foregroundColor: UIColor.label]
        )
    }

    private func style(_ label: UILabel, _ style: UIFont.TextStyle) {
        label.font = .preferredFont(forTextStyle: style)
        label.adjustsFontForContentSizeCategory = true
        label.numberOfLines = 0
    }
}
