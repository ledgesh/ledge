import AppKit
import LedgeMarkdown

/// Maps scanner tokens to text attributes.
///
/// Ledge shows raw Markdown and styles it, rather than hiding the syntax the way
/// a live-preview editor does. Concealment means the text you edit is not the
/// text on disk, which is a large complexity multiplier in an NSTextView and a
/// bad fit for notes whose code blocks have to be exact.
///
/// So markers stay visible and go dim. The content they mark gets the weight.
@MainActor
enum MarkdownTheme {
    static let baseFont = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    static let lineSpacing: CGFloat = 3

    static var baseAttributes: [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = lineSpacing
        return [
            .font: baseFont,
            .foregroundColor: NSColor.textColor,
            .paragraphStyle: paragraph,
        ]
    }

    static func attributes(for kind: MarkdownToken.Kind) -> [NSAttributedString.Key: Any] {
        switch kind {
        case let .heading(level):
            return [
                .font: headingFont(level: level),
                .foregroundColor: NSColor.textColor,
            ]

        case .marker:
            // Visible but recessive: you can see the structure without the
            // punctuation shouting.
            return [.foregroundColor: NSColor.tertiaryLabelColor]

        case .strong:
            return [.font: bold]

        case .emphasis:
            return [.font: italic]

        case .inlineCode:
            return [
                .foregroundColor: NSColor.systemPink,
                .backgroundColor: codeBackground,
            ]

        case .codeBlock:
            return [.backgroundColor: codeBackground]

        case .codeLanguage:
            return [
                .foregroundColor: NSColor.secondaryLabelColor,
                .backgroundColor: codeBackground,
            ]

        case .link:
            return [.foregroundColor: NSColor.linkColor]

        case .linkURL:
            return [.foregroundColor: NSColor.tertiaryLabelColor]

        case .blockQuote:
            return [.foregroundColor: NSColor.secondaryLabelColor, .font: italic]

        case .thematicBreak:
            return [.foregroundColor: NSColor.tertiaryLabelColor]

        case .frontmatter:
            return [
                .foregroundColor: NSColor.secondaryLabelColor,
                .backgroundColor: codeBackground,
            ]
        }
    }

    // MARK: - Fonts

    private static func headingFont(level: Int) -> NSFont {
        let sizes: [CGFloat] = [20, 18, 16, 15, 14, 13]
        let size = sizes[min(max(level, 1), 6) - 1]
        return NSFont.monospacedSystemFont(ofSize: size, weight: .bold)
    }

    private static let bold = NSFont.monospacedSystemFont(ofSize: 13, weight: .bold)

    private static let italic: NSFont = {
        let base = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        let descriptor = base.fontDescriptor.withSymbolicTraits(.italic)
        return NSFont(descriptor: descriptor, size: 13) ?? base
    }()

    private static let codeBackground = NSColor.textColor.withAlphaComponent(0.06)
}
