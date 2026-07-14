import Foundation

/// A single-pass, line-based Markdown scanner.
///
/// Deliberately not a CommonMark parser. It produces two things the editor needs
/// and nothing else: spans to style, and the exact ranges of fenced code blocks.
///
/// Fenced code is the part that has to be right, because a run button anchors to
/// it and a wrong range would execute the wrong text. So fences follow the real
/// CommonMark rules: up to three leading spaces, three or more backticks or
/// tildes, a closing fence of the same character and at least the same length,
/// and an info string that cannot contain a backtick when the fence is backticks.
///
/// Everything else (emphasis, links, list markers) is cosmetic. If it is
/// occasionally wrong on a pathological line, the note still reads fine. When we
/// need real structure (nested lists, reference links, setext headings), that is
/// the moment to bring in swift-markdown, not before.
public enum MarkdownScanner {
    public static func scan(_ text: String) -> MarkdownDocument {
        let ns = text as NSString
        guard ns.length > 0 else { return .empty }

        var tokens: [MarkdownToken] = []
        var codeBlocks: [CodeBlock] = []

        let lines = lineRanges(in: ns)
        var index = 0

        // YAML frontmatter, but only when it opens on the very first line.
        if let first = lines.first, ns.substring(with: first) == "---" {
            var end = 1
            while end < lines.count, ns.substring(with: lines[end]) != "---" { end += 1 }
            if end < lines.count {
                let range = NSRange(
                    location: first.location,
                    length: NSMaxRange(lines[end]) - first.location
                )
                tokens.append(MarkdownToken(range: range, kind: .frontmatter))
                index = end + 1
            }
        }

        while index < lines.count {
            let lineRange = lines[index]
            let line = ns.substring(with: lineRange)

            if let fence = OpeningFence(line: line) {
                index = scanCodeBlock(
                    openedBy: fence,
                    at: index,
                    lines: lines,
                    ns: ns,
                    tokens: &tokens,
                    codeBlocks: &codeBlocks
                )
                continue
            }

            scanTextLine(line, range: lineRange, into: &tokens)
            index += 1
        }

        return MarkdownDocument(tokens: tokens, codeBlocks: codeBlocks)
    }

    // MARK: - Fenced code

    /// An opening fence, already validated.
    private struct OpeningFence {
        let character: Character
        let length: Int
        /// Offset of the fence run within its line, in UTF-16 units.
        let markerOffset: Int
        let markerLength: Int
        let language: String?

        init?(line: String) {
            var indent = 0
            var rest = Substring(line)
            while rest.first == " ", indent < 4 {
                indent += 1
                rest = rest.dropFirst()
            }
            // Four spaces of indent is an indented code block, not a fence.
            guard indent < 4, let marker = rest.first, marker == "`" || marker == "~" else {
                return nil
            }

            let run = rest.prefix { $0 == marker }
            guard run.count >= 3 else { return nil }

            let info = rest.dropFirst(run.count).trimmingCharacters(in: .whitespaces)
            // A backtick fence may not carry a backtick in its info string,
            // otherwise ``` inside a paragraph would open a block.
            if marker == "`", info.contains("`") { return nil }

            character = marker
            length = run.count
            markerOffset = indent
            markerLength = run.count
            // The info string is the language, up to its first space.
            let word = info.split(separator: " ", maxSplits: 1).first.map(String.init)
            language = (word?.isEmpty == false) ? word?.lowercased() : nil
        }

        /// Does this line close the block?
        func closes(_ line: String) -> Bool {
            var indent = 0
            var rest = Substring(line)
            while rest.first == " ", indent < 4 {
                indent += 1
                rest = rest.dropFirst()
            }
            guard indent < 4, rest.first == character else { return false }
            let run = rest.prefix { $0 == character }
            guard run.count >= length else { return false }
            // Nothing but whitespace may follow a closing fence.
            return rest.dropFirst(run.count).allSatisfy { $0 == " " || $0 == "\t" }
        }
    }

    private static func scanCodeBlock(
        openedBy fence: OpeningFence,
        at openIndex: Int,
        lines: [NSRange],
        ns: NSString,
        tokens: inout [MarkdownToken],
        codeBlocks: inout [CodeBlock]
    ) -> Int {
        let openLine = lines[openIndex]

        tokens.append(MarkdownToken(
            range: NSRange(location: openLine.location + fence.markerOffset, length: fence.markerLength),
            kind: .marker
        ))
        // Whatever follows the fence run on the opening line is the info string.
        let infoStart = openLine.location + fence.markerOffset + fence.markerLength
        let infoLength = NSMaxRange(openLine) - infoStart
        if infoLength > 0 {
            tokens.append(MarkdownToken(
                range: NSRange(location: infoStart, length: infoLength),
                kind: .codeLanguage
            ))
        }

        // Find the closing fence.
        var closeIndex: Int?
        var cursor = openIndex + 1
        while cursor < lines.count {
            if fence.closes(ns.substring(with: lines[cursor])) {
                closeIndex = cursor
                break
            }
            cursor += 1
        }

        let bodyStart = openIndex + 1 < lines.count
            ? lines[openIndex + 1].location
            : NSMaxRange(openLine)
        let bodyEnd: Int
        let blockEnd: Int
        let unterminated: Bool

        if let closeIndex {
            let closeLine = lines[closeIndex]
            bodyEnd = max(bodyStart, closeLine.location)
            blockEnd = NSMaxRange(closeLine)
            unterminated = false
            tokens.append(MarkdownToken(range: closeLine, kind: .marker))
        } else {
            // Still being typed. The block runs to the end of the document and
            // is not runnable until it is closed.
            bodyEnd = ns.length
            blockEnd = ns.length
            unterminated = true
        }

        let body = NSRange(location: bodyStart, length: max(0, bodyEnd - bodyStart))
        if body.length > 0 {
            tokens.append(MarkdownToken(range: body, kind: .codeBlock))
        }

        codeBlocks.append(CodeBlock(
            id: codeBlocks.count,
            language: fence.language,
            body: body,
            range: NSRange(location: openLine.location, length: blockEnd - openLine.location),
            isUnterminated: unterminated
        ))

        return (closeIndex ?? lines.count - 1) + 1
    }

    // MARK: - Everything else

    private static func scanTextLine(
        _ line: String,
        range: NSRange,
        into tokens: inout [MarkdownToken]
    ) {
        let ns = line as NSString

        if let m = Patterns.thematicBreak.firstMatch(line) {
            tokens.append(MarkdownToken(range: shift(m.range, by: range.location), kind: .thematicBreak))
            return
        }

        if let m = Patterns.heading.firstMatch(line) {
            let hashes = m.range(at: 1)
            let level = hashes.length
            tokens.append(MarkdownToken(range: shift(hashes, by: range.location), kind: .marker))
            let textStart = NSMaxRange(hashes)
            let textRange = NSRange(location: textStart, length: ns.length - textStart)
            if textRange.length > 0 {
                tokens.append(MarkdownToken(
                    range: shift(textRange, by: range.location),
                    kind: .heading(level: level)
                ))
            }
            return
        }

        if let m = Patterns.blockQuote.firstMatch(line) {
            tokens.append(MarkdownToken(range: shift(m.range(at: 1), by: range.location), kind: .marker))
            let rest = NSRange(
                location: NSMaxRange(m.range(at: 1)),
                length: ns.length - NSMaxRange(m.range(at: 1))
            )
            if rest.length > 0 {
                tokens.append(MarkdownToken(range: shift(rest, by: range.location), kind: .blockQuote))
            }
            return
        }

        if let m = Patterns.listMarker.firstMatch(line) {
            tokens.append(MarkdownToken(range: shift(m.range(at: 1), by: range.location), kind: .marker))
        }

        scanInline(line, lineStart: range.location, into: &tokens)
    }

    private static func scanInline(
        _ line: String,
        lineStart: Int,
        into tokens: inout [MarkdownToken]
    ) {
        // Code spans win: nothing inside a backtick span is styled.
        var covered: [NSRange] = []
        for m in Patterns.inlineCode.matches(line) {
            tokens.append(MarkdownToken(range: shift(m.range, by: lineStart), kind: .inlineCode))
            covered.append(m.range)
        }

        func isFree(_ r: NSRange) -> Bool {
            !covered.contains { NSIntersectionRange($0, r).length > 0 }
        }

        for m in Patterns.link.matches(line) where isFree(m.range) {
            tokens.append(MarkdownToken(range: shift(m.range(at: 1), by: lineStart), kind: .link))
            tokens.append(MarkdownToken(range: shift(m.range(at: 2), by: lineStart), kind: .linkURL))
            covered.append(m.range)
        }

        for m in Patterns.strong.matches(line) where isFree(m.range) {
            tokens.append(MarkdownToken(range: shift(m.range, by: lineStart), kind: .strong))
            covered.append(m.range)
        }

        for m in Patterns.emphasis.matches(line) where isFree(m.range) {
            tokens.append(MarkdownToken(range: shift(m.range, by: lineStart), kind: .emphasis))
        }
    }

    // MARK: - Helpers

    private static func shift(_ range: NSRange, by offset: Int) -> NSRange {
        NSRange(location: range.location + offset, length: range.length)
    }

    /// Line ranges excluding their terminators, in document coordinates.
    private static func lineRanges(in ns: NSString) -> [NSRange] {
        var result: [NSRange] = []
        var start = 0
        while start <= ns.length {
            let lineRange = ns.lineRange(for: NSRange(location: start, length: 0))
            let terminatorless = NSRange(
                location: lineRange.location,
                length: lineRange.length - lineTerminatorLength(ns, lineRange)
            )
            result.append(terminatorless)
            if NSMaxRange(lineRange) == start { break }
            start = NSMaxRange(lineRange)
            if start == ns.length {
                // A document ending in a newline has a final empty line.
                result.append(NSRange(location: start, length: 0))
                break
            }
        }
        return result
    }

    private static func lineTerminatorLength(_ ns: NSString, _ range: NSRange) -> Int {
        guard range.length > 0 else { return 0 }
        let last = ns.character(at: NSMaxRange(range) - 1)
        guard last == 0x0A || last == 0x0D else { return 0 }
        if range.length >= 2,
           ns.character(at: NSMaxRange(range) - 2) == 0x0D,
           last == 0x0A {
            return 2
        }
        return 1
    }
}

// MARK: - Patterns

private enum Patterns {
    static let heading = Regex(#"^ {0,3}(#{1,6})(?:\s|$)"#)
    static let thematicBreak = Regex(#"^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$"#)
    static let blockQuote = Regex(#"^ {0,3}(>\s?)"#)
    static let listMarker = Regex(#"^(\s*(?:[-*+]|\d{1,9}[.)])\s)"#)
    static let inlineCode = Regex(#"`[^`\n]+`"#)
    static let link = Regex(#"(\[[^\]\n]*\])(\([^)\n]*\))"#)
    static let strong = Regex(#"(?<!\*)\*\*(?=\S)([^*\n]|\*(?!\*))+?\*\*|__(?=\S)[^_\n]+?__"#)
    static let emphasis = Regex(#"(?<![\*\w])\*(?=\S)[^*\n]+?\*(?![\*\w])|(?<![_\w])_(?=\S)[^_\n]+?_(?![_\w])"#)
}

/// Thin wrapper so the patterns above read as patterns and not as error handling.
private struct Regex {
    private let regex: NSRegularExpression

    init(_ pattern: String) {
        // The patterns are literals in this file. A failure here is a programmer
        // error, caught by the tests, not something to recover from at runtime.
        // swiftlint:disable:next force_try
        regex = try! NSRegularExpression(pattern: pattern)
    }

    func matches(_ s: String) -> [NSTextCheckingResult] {
        regex.matches(in: s, range: NSRange(location: 0, length: (s as NSString).length))
    }

    func firstMatch(_ s: String) -> NSTextCheckingResult? {
        regex.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length))
    }
}
