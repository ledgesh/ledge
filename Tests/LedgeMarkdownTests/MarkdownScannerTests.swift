import Foundation
import Testing

@testable import LedgeMarkdown

// MARK: - Fenced code blocks
//
// These matter more than the rest of the suite: a run button anchors to these
// ranges, so a bad range means running the wrong text.

private func body(of text: String, _ block: CodeBlock) -> String {
    (text as NSString).substring(with: block.body)
}

@Test func findsASimpleFencedBlock() {
    let text = """
    # Notes

    ```sh
    echo hello
    ```

    done
    """
    let doc = MarkdownScanner.scan(text)

    #expect(doc.codeBlocks.count == 1)
    let block = doc.codeBlocks[0]
    #expect(block.language == "sh")
    #expect(body(of: text, block) == "echo hello\n")
    #expect(block.isUnterminated == false)
}

@Test func bodyExcludesTheFences() {
    let text = "```\nline one\nline two\n```\n"
    let block = MarkdownScanner.scan(text).codeBlocks[0]
    #expect(body(of: text, block) == "line one\nline two\n")
}

@Test func handlesMultipleBlocks() {
    let text = """
    ```sh
    one
    ```
    prose
    ```python
    two
    ```
    """
    let doc = MarkdownScanner.scan(text)

    #expect(doc.codeBlocks.count == 2)
    #expect(doc.codeBlocks.map(\.language) == ["sh", "python"])
    #expect(body(of: text, doc.codeBlocks[0]) == "one\n")
    #expect(body(of: text, doc.codeBlocks[1]) == "two\n")
    #expect(doc.codeBlocks.map(\.id) == [0, 1])
}

@Test func languageIsOptionalAndLowercased() {
    #expect(MarkdownScanner.scan("```\nx\n```").codeBlocks[0].language == nil)
    #expect(MarkdownScanner.scan("```Bash\nx\n```").codeBlocks[0].language == "bash")
    #expect(MarkdownScanner.scan("```ts twoslash\nx\n```").codeBlocks[0].language == "ts")
}

@Test func anUnclosedBlockIsMarkedUnterminated() {
    let text = "```sh\necho hi\n"
    let block = MarkdownScanner.scan(text).codeBlocks[0]
    #expect(block.isUnterminated)
}

@Test func aLongerFenceIsNotClosedByAShorterOne() {
    // The inner ``` is content, not a terminator: a closing fence must be at
    // least as long as the one that opened the block.
    let text = """
    ````md
    ```
    nested
    ```
    ````
    """
    let doc = MarkdownScanner.scan(text)

    #expect(doc.codeBlocks.count == 1)
    #expect(doc.codeBlocks[0].isUnterminated == false)
    #expect(body(of: text, doc.codeBlocks[0]) == "```\nnested\n```\n")
}

@Test func tildeFencesWork() {
    let text = "~~~sh\necho hi\n~~~"
    let doc = MarkdownScanner.scan(text)
    #expect(doc.codeBlocks.count == 1)
    #expect(body(of: text, doc.codeBlocks[0]) == "echo hi\n")
}

@Test func aTildeFenceIsNotClosedByBackticks() {
    let text = "~~~\ncode\n```\nstill code\n~~~"
    let doc = MarkdownScanner.scan(text)
    #expect(doc.codeBlocks.count == 1)
    #expect(body(of: text, doc.codeBlocks[0]) == "code\n```\nstill code\n")
}

@Test func aBacktickFenceCannotCarryABacktickInItsInfoString() {
    // Otherwise a paragraph mentioning ``code`` would open a code block.
    let doc = MarkdownScanner.scan("``` `not a fence`\ntext\n")
    #expect(doc.codeBlocks.isEmpty)
}

@Test func fourSpacesOfIndentIsNotAFence() {
    let doc = MarkdownScanner.scan("    ```\n    x\n")
    #expect(doc.codeBlocks.isEmpty)
}

@Test func closingFenceMayNotHaveTrailingText() {
    let text = "```\ncode\n``` nope\n```\n"
    let doc = MarkdownScanner.scan(text)
    #expect(doc.codeBlocks.count == 1)
    #expect(body(of: text, doc.codeBlocks[0]) == "code\n``` nope\n")
}

@Test func emptyBlockHasEmptyBody() {
    let text = "```\n```"
    let doc = MarkdownScanner.scan(text)
    #expect(doc.codeBlocks.count == 1)
    #expect(body(of: text, doc.codeBlocks[0]).isEmpty)
}

@Test func rangesSurviveEmoji() {
    // UTF-16 offsets, not character offsets: a surrogate pair must not shift the
    // fence ranges.
    let text = "note 🧑‍🚀 here\n\n```sh\necho hi\n```\n"
    let block = MarkdownScanner.scan(text).codeBlocks[0]
    #expect(body(of: text, block) == "echo hi\n")
}

// MARK: - Inline and block styling

private func kinds(_ text: String) -> [MarkdownToken.Kind] {
    MarkdownScanner.scan(text).tokens.map(\.kind)
}

@Test func headingsCarryTheirLevel() {
    #expect(kinds("# One").contains(.heading(level: 1)))
    #expect(kinds("### Three").contains(.heading(level: 3)))
    #expect(kinds("####### Seven").contains(.heading(level: 7)) == false)
    // No space after the hashes is not a heading.
    #expect(kinds("#hashtag").contains(.heading(level: 1)) == false)
}

@Test func emphasisAndStrong() {
    #expect(kinds("**bold**").contains(.strong))
    #expect(kinds("*italic*").contains(.emphasis))
    #expect(kinds("__bold__").contains(.strong))
    // snake_case in prose must not become emphasis: this is the main way
    // Markdown highlighting mangles ordinary text.
    #expect(kinds("call some_function_name now").contains(.emphasis) == false)
}

@Test func inlineCodeSuppressesEverythingInsideIt() {
    let text = "run `echo *not emphasis*` now"
    let doc = MarkdownScanner.scan(text)
    #expect(doc.tokens.contains { $0.kind == .inlineCode })
    #expect(doc.tokens.contains { $0.kind == .emphasis } == false)
}

@Test func linksSplitTextFromURL() {
    let doc = MarkdownScanner.scan("see [the docs](https://ledge.sh)")
    #expect(doc.tokens.contains { $0.kind == .link })
    #expect(doc.tokens.contains { $0.kind == .linkURL })
}

@Test func listMarkersAndQuotes() {
    #expect(kinds("- item").contains(.marker))
    #expect(kinds("1. item").contains(.marker))
    #expect(kinds("> quoted").contains(.blockQuote))
}

@Test func thematicBreak() {
    #expect(kinds("---\n").contains(.thematicBreak))
}

@Test func frontmatterIsRecognisedOnlyAtTheTop() {
    let top = MarkdownScanner.scan("---\ncwd: ~/x\n---\n\n# Note")
    #expect(top.tokens.contains { $0.kind == .frontmatter })

    // A `---` further down is a thematic break, not frontmatter.
    let lower = MarkdownScanner.scan("# Note\n\n---\ncwd: ~/x\n---\n")
    #expect(lower.tokens.contains { $0.kind == .frontmatter } == false)
}

@Test func emptyDocumentScansCleanly() {
    #expect(MarkdownScanner.scan("") == .empty)
}

@Test func everyTokenRangeIsInsideTheDocument() {
    let text = """
    ---
    cwd: ~/p
    ---
    # Title

    Some *text* with `code` and a [link](https://x.dev).

    - one
    - two

    ```sh
    echo hi
    ```
    """
    let length = (text as NSString).length
    for token in MarkdownScanner.scan(text).tokens {
        #expect(token.range.location >= 0)
        #expect(NSMaxRange(token.range) <= length)
    }
}
