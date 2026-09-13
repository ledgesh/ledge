import UIKit

/// The first screen on a phone with no servers (ios.md §4).
///
/// It says what Ledge on a phone is before asking for anything, then offers the
/// ways in: a pairing code first, the setup commands for someone with no server
/// yet, and the address form last.
final class WelcomeViewController: UIViewController {
    private let client: String
    private let onScan: () -> Void
    private let onAddress: () -> Void

    private let scroll = UIScrollView()
    private let stack = UIStackView()

    init(client: String, onScan: @escaping () -> Void, onAddress: @escaping () -> Void) {
        self.client = client
        self.onScan = onScan
        self.onAddress = onAddress
        super.init(nibName: nil, bundle: nil)
        // No title, so the bar stays empty over the heading below it.
        navigationItem.largeTitleDisplayMode = .never
        navigationItem.backButtonTitle = "Welcome"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("no storyboard") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        build()
        // The key is minted here, on the first launch, so its `[pair]` line is
        // on the console before anyone taps (testing.md §6). A failure waits
        // for the pairing form, which reports it.
        if let key = try? DeviceKey.load() { DeviceKey.log(key, client: client) }
    }

    private func build() {
        stack.axis = .vertical
        stack.alignment = .fill
        stack.spacing = 12
        stack.isLayoutMarginsRelativeArrangement = true
        stack.layoutMargins = UIEdgeInsets(top: 12, left: 20, bottom: 24, right: 20)

        let heading = label("Connect to your Ledge server", style: .largeTitle)
        heading.font = UIFontMetrics(forTextStyle: .largeTitle).scaledFont(
            for: .systemFont(ofSize: 32, weight: .bold)
        )
        heading.accessibilityTraits = .header
        let lede = label(
            "Your notes live on a server, and Ledge reaches them over ssh. None of them are stored on this device.",
            style: .body
        )
        lede.textColor = .secondaryLabel

        let scan = UIButton(configuration: .filled())
        scan.configuration?.title = "Scan a pairing code"
        scan.configuration?.image = UIImage(systemName: "qrcode.viewfinder")
        scan.configuration?.imagePadding = 8
        scan.configuration?.buttonSize = .large
        scan.addAction(UIAction { [weak self] _ in self?.onScan() }, for: .touchUpInside)
        let scanNote = label("ledge-server pair shows one in a terminal on the server.", style: .footnote)
        scanNote.textColor = .secondaryLabel
        scanNote.textAlignment = .center

        let setup = row(
            title: "I don't have a server yet",
            subtitle: "Set one up on a Linux machine",
            symbol: "server.rack"
        )
        setup.addAction(
            UIAction { [weak self] _ in
                guard let self else { return }
                self.navigationController?.pushViewController(
                    ServerSetupViewController(onScan: self.onScan),
                    animated: true
                )
            },
            for: .touchUpInside
        )

        let address = UIButton(configuration: .plain())
        address.configuration?.title = "Enter an address instead"
        address.addAction(UIAction { [weak self] _ in self?.onAddress() }, for: .touchUpInside)

        // The mark in a row of its own, so the labels below it fill the width
        // and wrap rather than taking the width of one long line.
        let markRow = UIStackView(arrangedSubviews: [LedgeMark(side: 64), UIView()])
        let hero = UIStackView(arrangedSubviews: [markRow, heading, lede])
        hero.axis = .vertical
        hero.spacing = 12
        hero.setCustomSpacing(18, after: markRow)

        for view in [hero, scan, scanNote, setup, address] {
            stack.addArrangedSubview(view)
        }
        stack.setCustomSpacing(28, after: hero)
        stack.setCustomSpacing(32, after: scanNote)
        stack.setCustomSpacing(16, after: setup)

        scroll.addSubview(stack)
        view.addSubview(scroll)
        scroll.translatesAutoresizingMaskIntoConstraints = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        // As wide as the screen on a phone, and a column in the middle of an iPad.
        let wide = stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor)
        wide.priority = .required - 1
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            stack.centerXAnchor.constraint(equalTo: scroll.frameLayoutGuide.centerXAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 560),
            wide,
        ])
    }

    private func label(_ text: String, style: UIFont.TextStyle) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: style)
        label.adjustsFontForContentSizeCategory = true
        label.numberOfLines = 0
        return label
    }

    /// A grouped-table row as a button: a symbol, a title over a subtitle, and
    /// a chevron that says it leads to another screen.
    private func row(title: String, subtitle: String, symbol: String) -> UIButton {
        var config = UIButton.Configuration.gray()
        config.baseBackgroundColor = .secondarySystemGroupedBackground
        config.baseForegroundColor = .label
        config.cornerStyle = .large
        config.image = UIImage(systemName: symbol)
        config.imageColorTransformer = UIConfigurationColorTransformer { _ in .systemIndigo }
        config.imagePadding = 14
        config.title = title
        config.subtitle = subtitle
        config.titleAlignment = .leading
        config.titlePadding = 2
        config.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 40)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer {
            var attributes = $0
            attributes.font = UIFont.preferredFont(forTextStyle: .body)
            return attributes
        }
        config.subtitleTextAttributesTransformer = UIConfigurationTextAttributesTransformer {
            var attributes = $0
            attributes.font = UIFont.preferredFont(forTextStyle: .subheadline)
            attributes.foregroundColor = UIColor.secondaryLabel
            return attributes
        }
        let button = UIButton(configuration: config)
        button.contentHorizontalAlignment = .leading

        let chevron = UIImageView(image: UIImage(systemName: "chevron.forward"))
        chevron.tintColor = .tertiaryLabel
        chevron.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .footnote, scale: .default)
        chevron.translatesAutoresizingMaskIntoConstraints = false
        button.addSubview(chevron)
        NSLayoutConstraint.activate([
            chevron.trailingAnchor.constraint(equalTo: button.trailingAnchor, constant: -16),
            chevron.centerYAnchor.constraint(equalTo: button.centerYAnchor),
        ])
        return button
    }
}

/// The Ledge mark from `assets/logo.svg`, lime on the app icon's dark tile.
private final class LedgeMark: UIView {
    private let mark = CAShapeLayer()

    init(side: CGFloat) {
        super.init(frame: .zero)
        backgroundColor = UIColor(white: 0.102, alpha: 1)
        layer.cornerRadius = side * 0.225
        layer.cornerCurve = .continuous
        mark.fillColor = UIColor(red: 0.902, green: 0.949, blue: 0.337, alpha: 1).cgColor
        layer.addSublayer(mark)
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: side),
            heightAnchor.constraint(equalToConstant: side),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("no storyboard") }

    override func layoutSubviews() {
        super.layoutSubviews()
        // The logo's box is 91.80 by 84.95. The icon draws it at two thirds of
        // the tile's width, centred (assets/Ledge.icon).
        let box = CGSize(width: 91.80, height: 84.95)
        let scale = bounds.width * 0.664 / box.width
        let path = UIBezierPath()
        path.move(to: CGPoint(x: 0, y: 70))
        path.addLine(to: CGPoint(x: 15.5, y: 70))
        path.addLine(to: CGPoint(x: 60.96, y: 0))
        path.addLine(to: CGPoint(x: 45.46, y: 0))
        path.close()
        path.append(UIBezierPath(rect: CGRect(x: 33.8, y: 73.9, width: 58, height: 11.05)))
        path.apply(
            CGAffineTransform(
                translationX: (bounds.width - box.width * scale) / 2,
                y: (bounds.height - box.height * scale) / 2
            ).scaledBy(x: scale, y: scale)
        )
        mark.path = path.cgPath
    }
}
