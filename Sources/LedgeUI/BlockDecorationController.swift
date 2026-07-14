import AppKit
import LedgeMarkdown
import SwiftUI

/// Places run buttons and inline output over the text view, and reserves the
/// vertical space each output occupies so it does not overlap the text below.
///
/// The reservation is the fiddly part. An NSTextView will not let a subview push
/// glyphs down, so instead we add `paragraphSpacing` beneath a code block's
/// final line equal to the height of its output, then park the output subview in
/// that gap. Grow the output, grow the gap. This is the technique PLAN.md P7-1
/// anticipated, and the reason the run affordance is an overlay rather than a
/// text attachment.
@MainActor
final class BlockDecorationController {
    /// Called when the user asks to run the block at a document index. The host
    /// decides whether to show the preflight and, eventually, whether the note
    /// is trusted.
    var onRun: ((Int) -> Void)?

    private weak var textView: NSTextView?
    private var blocks: [CodeBlock] = []
    private var runProvider: (Int) -> BlockRun? = { _ in nil }

    private var runButtons: [Int: NSHostingView<RunButton>] = [:]
    private var outputViews: [Int: OutputHost] = [:]

    /// The state each run button was last built with. A SwiftUI Button loses an
    /// in-progress click if its host's `rootView` is reassigned mid-press, and
    /// the host relays out on a timer, so we only rebuild a button when its state
    /// actually changed rather than on every layout pass.
    private var buttonStates: [Int: BlockRun.State] = [:]

    /// Height reserved for each block's output, keyed by document index.
    private var reservedHeights: [Int: CGFloat] = [:]

    func attach(to textView: NSTextView) {
        self.textView = textView
    }

    /// Called after every highlight pass with the current blocks, and on every
    /// run-state change.
    func update(blocks: [CodeBlock], runProvider: @escaping (Int) -> BlockRun?) {
        self.blocks = blocks
        self.runProvider = runProvider
        applyReservations()
        layoutDecorations()
    }

    // MARK: - Space reservation

    /// Set paragraph spacing under each block's last line to make room for its
    /// output. Done directly on the text storage so layout accounts for it.
    private func applyReservations() {
        guard let textView, let storage = textView.textStorage else { return }
        var next: [Int: CGFloat] = [:]

        for (index, block) in blocks.enumerated() {
            guard let run = runProvider(index), hasContent(run) else { continue }
            let height = outputHeight(for: run)
            next[index] = height
        }

        guard next != reservedHeights else { return }
        reservedHeights = next

        storage.beginEditing()
        // Reset any spacing we previously added, then re-apply. We only touch the
        // final line of each block, so this does not fight the highlighter, which
        // sets foreground and background but not paragraph spacing.
        let full = NSRange(location: 0, length: storage.length)
        storage.enumerateAttribute(.paragraphStyle, in: full) { value, range, _ in
            if let style = value as? NSParagraphStyle, style.paragraphSpacing > 0 {
                let clean = MarkdownTheme.baseAttributes[.paragraphStyle]
                storage.addAttribute(.paragraphStyle, value: clean as Any, range: range)
            }
        }
        for (index, height) in reservedHeights {
            guard index < blocks.count else { continue }
            let lastLine = lastLineRange(of: blocks[index], in: storage)
            let style = NSMutableParagraphStyle()
            style.lineSpacing = MarkdownTheme.lineSpacing
            style.paragraphSpacing = height + Metrics.outputGap
            storage.addAttribute(.paragraphStyle, value: style, range: lastLine)
        }
        storage.endEditing()
    }

    private func lastLineRange(of block: CodeBlock, in storage: NSTextStorage) -> NSRange {
        let end = min(NSMaxRange(block.range), storage.length)
        guard end > 0 else { return NSRange(location: 0, length: 0) }
        return (storage.string as NSString).lineRange(for: NSRange(location: end - 1, length: 0))
    }

    // MARK: - Decoration layout

    private func layoutDecorations() {
        guard let textView,
              let layoutManager = textView.layoutManager,
              let container = textView.textContainer
        else { return }

        let inset = textView.textContainerInset
        var liveIndices = Set<Int>()

        for (index, block) in blocks.enumerated() {
            liveIndices.insert(index)
            let blockRect = boundingRect(
                for: block.range,
                layoutManager: layoutManager,
                container: container,
                inset: inset
            )

            // Run button, pinned to the block's top-right corner. Pinned to the
            // content's right edge, not the widest glyph run, so every block's
            // button lines up in the same column regardless of code width.
            let run = runProvider(index)
            let state = run?.state ?? .idle
            let button: NSHostingView<RunButton>
            if let existing = runButtons[index] {
                button = existing
                if buttonStates[index] != state {
                    button.rootView = RunButton(state: state) { [weak self] in
                        self?.onRun?(index)
                    }
                    buttonStates[index] = state
                }
            } else {
                button = NSHostingView(rootView: RunButton(state: state) { [weak self] in
                    self?.onRun?(index)
                })
                button.translatesAutoresizingMaskIntoConstraints = true
                textView.addSubview(button)
                runButtons[index] = button
                buttonStates[index] = state
            }
            // Vertically center on the opening fence line, horizontally against a
            // fixed right margin. Using the first line's rect (not the whole
            // block's) keeps the button put when output space is reserved below.
            let firstLine = boundingRect(
                for: NSRange(location: block.range.location, length: min(1, block.range.length)),
                layoutManager: layoutManager,
                container: container,
                inset: inset
            )
            let buttonSize = button.fittingSize
            let contentRight = textView.bounds.width - inset.width
            button.frame = NSRect(
                x: contentRight - buttonSize.width - Metrics.buttonInset,
                y: firstLine.midY - buttonSize.height / 2,
                width: buttonSize.width,
                height: buttonSize.height
            )

            // Output, parked in the reserved gap under the block.
            if let run, hasContent(run) {
                let host = outputViews[index] ?? {
                    let h = OutputHost(run: run)
                    textView.addSubview(h)
                    outputViews[index] = h
                    return h
                }()
                host.setRun(run)
                let height = outputHeight(for: run)
                host.frame = NSRect(
                    x: blockRect.minX,
                    y: blockRect.maxY + Metrics.outputGap,
                    width: blockRect.width,
                    height: height
                )
            } else if let stale = outputViews.removeValue(forKey: index) {
                stale.removeFromSuperview()
            }
        }

        // Drop decorations for blocks that no longer exist.
        for (index, view) in runButtons where !liveIndices.contains(index) {
            view.removeFromSuperview()
            runButtons.removeValue(forKey: index)
            buttonStates.removeValue(forKey: index)
        }
        for (index, view) in outputViews where !liveIndices.contains(index) {
            view.removeFromSuperview()
            outputViews.removeValue(forKey: index)
        }
    }

    private func boundingRect(
        for range: NSRange,
        layoutManager: NSLayoutManager,
        container: NSTextContainer,
        inset: NSSize
    ) -> NSRect {
        let glyphRange = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        var rect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: container)
        rect.origin.x += inset.width
        rect.origin.y += inset.height
        return rect
    }

    // MARK: - Sizing

    private func hasContent(_ run: BlockRun) -> Bool {
        run.isActive || !run.output.isEmpty || {
            if case .finished = run.state { return true }
            if case .sessionEnded = run.state { return true }
            return false
        }()
    }

    private func outputHeight(for run: BlockRun) -> CGFloat {
        let lines = run.output.reduce(into: 1) { count, byte in
            if byte == 0x0A { count += 1 }
        }
        let bodyLines = min(max(lines, 1), Metrics.maxOutputLines)
        return CGFloat(bodyLines) * Metrics.lineHeight + Metrics.outputChrome
    }

    private enum Metrics {
        static let buttonInset: CGFloat = 6
        static let outputGap: CGFloat = 6
        static let lineHeight: CGFloat = 15
        static let maxOutputLines = 18
        static let outputChrome: CGFloat = 34
    }
}

/// A container view that holds the status header and the terminal surface.
@MainActor
final class OutputHost: NSView {
    private let hosting: NSHostingView<BlockOutputPanel>

    init(run: BlockRun) {
        hosting = NSHostingView(rootView: BlockOutputPanel(run: run))
        super.init(frame: .zero)
        addSubview(hosting)
        hosting.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            hosting.leadingAnchor.constraint(equalTo: leadingAnchor),
            hosting.trailingAnchor.constraint(equalTo: trailingAnchor),
            hosting.topAnchor.constraint(equalTo: topAnchor),
            hosting.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func setRun(_ run: BlockRun) {
        hosting.rootView = BlockOutputPanel(run: run)
    }
}
