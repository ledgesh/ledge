import Foundation

/// A styled span of the document. Ranges are UTF-16 offsets, which is what
/// `NSTextStorage` speaks, so the editor can apply these without conversion.
public struct MarkdownToken: Equatable, Sendable {
    public let range: NSRange
    public let kind: Kind

    public init(range: NSRange, kind: Kind) {
        self.range = range
        self.kind = kind
    }

    public enum Kind: Equatable, Sendable {
        /// The text of a heading, without its leading hashes.
        case heading(level: Int)
        /// Syntax that is shown but muted: `#`, `>`, `-`, the fence backticks.
        case marker
        case strong
        case emphasis
        case inlineCode
        /// The body of a fenced code block.
        case codeBlock
        /// The language written after the opening fence.
        case codeLanguage
        case link
        case linkURL
        case blockQuote
        case thematicBreak
        /// The YAML frontmatter block, including its delimiters.
        case frontmatter
    }
}

/// A fenced code block. This is the unit that gets a run button, so its ranges
/// have to be exact, not approximate.
public struct CodeBlock: Equatable, Sendable, Identifiable {
    /// Index of the block within the document, counting from zero.
    public let id: Int
    /// The info string after the opening fence, lowercased. Nil when absent.
    public let language: String?
    /// The code itself, with no fences. This is what gets executed.
    public let body: NSRange
    /// The whole block, fences included. This is what a run button anchors to.
    public let range: NSRange
    /// True when the block has no closing fence, because the user is still
    /// typing it. An unterminated block is not runnable.
    public let isUnterminated: Bool

    public init(
        id: Int,
        language: String?,
        body: NSRange,
        range: NSRange,
        isUnterminated: Bool
    ) {
        self.id = id
        self.language = language
        self.body = body
        self.range = range
        self.isUnterminated = isUnterminated
    }
}

/// The result of scanning a document once.
public struct MarkdownDocument: Equatable, Sendable {
    public let tokens: [MarkdownToken]
    public let codeBlocks: [CodeBlock]

    public init(tokens: [MarkdownToken], codeBlocks: [CodeBlock]) {
        self.tokens = tokens
        self.codeBlocks = codeBlocks
    }

    public static let empty = MarkdownDocument(tokens: [], codeBlocks: [])
}
