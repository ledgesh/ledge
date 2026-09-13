import UIKit

/// The commands that turn a Linux machine into a Ledge server (ios.md §4).
///
/// The phone cannot run them, so the screen hands them to a computer that can,
/// by the pasteboard or the share sheet. The last command prints a pairing code,
/// and the scan button reads it.
final class ServerSetupViewController: UIViewController {
    /// docs/user/09's "Install the server", then `pair` for the account that
    /// ran it.
    static let commands = [
        "curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/usr/local bash",
        "sudo BUN_INSTALL=/usr/local bun add -g ledge-server",
        "ledge-server pair",
    ]

    private let onScan: () -> Void

    private let scroll = UIScrollView()
    private let stack = UIStackView()
    private let copy = UIButton(type: .system)
    private let share = UIButton(type: .system)
    private let copied = UILabel()

    init(onScan: @escaping () -> Void) {
        self.onScan = onScan
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

        let buttons = UIStackView(arrangedSubviews: [copy, share, UIView()])
        buttons.axis = .horizontal
        buttons.spacing = 16
        // Said below the buttons rather than in the button's title, which would
        // change its width and move Share out from under a second tap.
        copy.setTitle("Copy commands", for: .normal)
        copy.addAction(
            UIAction { [weak self, weak buttons] _ in
                guard let self, let buttons else { return }
                Natives.clipboardWrite(Self.commands.joined(separator: "\n"))
                self.copied.isHidden = false
                self.stack.setCustomSpacing(4, after: buttons)
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

        copied.text = "Copied. Paste them into a terminal on the server."
        copied.font = .preferredFont(forTextStyle: .footnote)
        copied.adjustsFontForContentSizeCategory = true
        copied.textColor = .secondaryLabel
        copied.numberOfLines = 0
        copied.isHidden = true

        let views: [UIView] = [
            label(
                "A server is a Linux machine that stays on and accepts ssh, such as a VPS or a computer at home.",
                style: .body
            ),
            label(
                "In a terminal on that machine, signed in as the account Ledge should use, run these three commands. The first two need sudo.",
                style: .body
            ),
            commandBox(),
            buttons,
            copied,
            label("The last command shows a pairing code for that account.", style: .body),
            scan,
            footnote(
                "The machine needs glibc 2.29 or newer, on arm64 or x64: Debian 11, Ubuntu 20.04, RHEL 9, or later. This device has to be able to reach its address."
            ),
        ]
        for view in views {
            stack.addArrangedSubview(view)
        }
        stack.setCustomSpacing(4, after: views[2])
        stack.setCustomSpacing(20, after: buttons)
        stack.setCustomSpacing(20, after: copied)
        stack.setCustomSpacing(16, after: scan)

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
    private func commandBox() -> UITextView {
        let paragraph = NSMutableParagraphStyle()
        paragraph.headIndent = 16
        paragraph.paragraphSpacing = 6
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.hyphenationFactor = 0
        paragraph.usesDefaultHyphenation = false
        let font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: 13, weight: .regular))

        let box = UITextView()
        box.isEditable = false
        box.isScrollEnabled = false
        box.adjustsFontForContentSizeCategory = true
        box.backgroundColor = .secondarySystemBackground
        box.layer.cornerRadius = 8
        box.textContainerInset = UIEdgeInsets(top: 10, left: 8, bottom: 10, right: 8)
        box.attributedText = NSAttributedString(
            string: Self.commands.joined(separator: "\n"),
            attributes: [.font: font, .paragraphStyle: paragraph, .foregroundColor: UIColor.label]
        )
        return box
    }

    private func label(_ text: String, style: UIFont.TextStyle) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: style)
        label.adjustsFontForContentSizeCategory = true
        label.numberOfLines = 0
        return label
    }

    private func footnote(_ text: String) -> UILabel {
        let label = self.label(text, style: .footnote)
        label.textColor = .secondaryLabel
        return label
    }
}
