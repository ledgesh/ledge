import AppKit
import LedgeMarkdown
import SessionKit
import SwiftUI

/// Places a code block's controls (run, copy) and inline output over the text
/// view, and reserves the vertical space each output occupies so it does not
/// overlap the text below.
///
/// The reservation is the fiddly part. An NSTextView will not let a subview push
/// glyphs down, so instead we add `paragraphSpacing` beneath a code block's
/// final line equal to the height of its output, then park the output subview in
/// that gap. Grow the output, grow the gap. This is the technique PLAN.md P7-1
/// anticipated, and the reason the controls are an overlay rather than a text
/// attachment.
///
/// The controls hide until the block is hovered or holds the caret, so a note at
/// rest reads as plain text. Positions come from layout geometry; visibility is
/// driven separately (hover, selection) so a mouse move never re-runs layout.
@MainActor
final class BlockDecorationController {
    /// Called when the user asks to run the block at a document index. The host
    /// decides whether to show the preflight and, eventually, whether the note
    /// is trusted.
    var onRun: ((Int) -> Void)?

    private weak var textView: NSTextView?
    private var blocks: [CodeBlock] = []
    private var text: String = ""
    private var runProvider: (Int) -> BlockRun? = { _ in nil }

    private var controlHosts: [Int: NSHostingView<BlockControls>] = [:]
    private var outputViews: [Int: OutputHost] = [:]

    /// The last (run-state, visible) a control was built with, so we only rebuild
    /// its SwiftUI view when one actually changes. Rebuilding on every layout or
    /// mouse move would cancel an in-flight click on the control.
    private var controlSignatures: [Int: ControlSignature] = [:]

    /// Each block's rect in text-view (document) coordinates, from the last
    /// layout pass. Used to decide which block the mouse is over.
    private var blockRects: [Int: NSRect] = [:]

    /// Height reserved for each block's output, keyed by document index.
    private var reservedHeights: [Int: CGFloat] = [:]

    private var hoveredIndex: Int?
    private var caretIndex: Int?

    private struct ControlSignature: Equatable {
        var runState: BlockRun.State?
        var visible: Bool
    }

    func attach(to textView: NSTextView) {
        self.textView = textView
    }

    /// Full pass: recompute reserved space and reposition everything. Called
    /// after a highlight (text changed) and whenever a run's output or state
    /// advances, since both change how much space the output needs.
    func update(blocks: [CodeBlock], text: String, runProvider: @escaping (Int) -> BlockRun?) {
        self.blocks = blocks
        self.text = text
        self.runProvider = runProvider
        if let h = hoveredIndex, h >= blocks.count { hoveredIndex = nil }
        if let c = caretIndex, c >= blocks.count { caretIndex = nil }
        applyReservations()
        layoutDecorations()
    }

    /// Positions only, no reservation change. Called after AppKit lays the text
    /// view out (initial sizing, resize): glyph rects moved, but the amount of
    /// reserved space did not, so the text storage must not be touched here.
    func relayout() {
        layoutDecorations()
    }

    // MARK: - Visibility (hover + caret)

    /// The mouse moved to `point` in text-view coordinates, or left the view
    /// (`nil`). Reveals the controls for whichever block it is over.
    func updateHover(point: NSPoint?) {
        let hit: Int?
        if let point {
            hit = blocks.indices.first { blockRects[$0]?.contains(point) == true }
        } else {
            hit = nil
        }
        guard hit != hoveredIndex else { return }
        hoveredIndex = hit
        refreshControlVisibility()
    }

    /// The caret moved to `characterIndex`. Reveals the controls for the block it
    /// landed in, so you can run a block you are editing without reaching for the
    /// mouse.
    func updateCaret(characterIndex: Int) {
        let hit = blocks.indices.first { i in
            let range = blocks[i].range
            return characterIndex >= range.location && characterIndex <= NSMaxRange(range)
        }
        guard hit != caretIndex else { return }
        caretIndex = hit
        refreshControlVisibility()
    }

    private func isVisible(_ index: Int) -> Bool {
        hoveredIndex == index || caretIndex == index
    }

    private func refreshControlVisibility() {
        for (index, host) in controlHosts {
            applyControlView(index: index, host: host)
        }
    }

    // MARK: - Space reservation

    /// Set paragraph spacing under each block's last line to make room for its
    /// output. Done directly on the text storage so layout accounts for it.
    private func applyReservations() {
        guard let textView, let storage = textView.textStorage else { return }
        var next: [Int: CGFloat] = [:]

        for index in blocks.indices {
            guard let run = runProvider(index), hasContent(run) else { continue }
            next[index] = outputHeight(for: run)
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

        // Force glyph layout so the rects below are real. Without this, an early
        // pass (before the view has laid out) reads zero rects and parks the
        // controls off-screen: the bug that made the run button "disappear".
        layoutManager.ensureLayout(for: container)

        let inset = textView.textContainerInset
        let contentRight = textView.bounds.width - inset.width
        var liveIndices = Set<Int>()
        blockRects.removeAll(keepingCapacity: true)

        for (index, block) in blocks.enumerated() {
            liveIndices.insert(index)
            let blockRect = boundingRect(
                for: block.range,
                layoutManager: layoutManager,
                container: container,
                inset: inset
            )
            blockRects[index] = blockRect

            // Control cluster, pinned to the block's top-right with padding.
            let host = controlHosts[index] ?? {
                let created = NSHostingView(
                    rootView: makeControls(
                        index: index,
                        runState: currentRunState(index),
                        visible: isVisible(index)
                    )
                )
                created.translatesAutoresizingMaskIntoConstraints = true
                textView.addSubview(created)
                controlHosts[index] = created
                controlSignatures[index] = ControlSignature(
                    runState: currentRunState(index),
                    visible: isVisible(index)
                )
                return created
            }()
            applyControlView(index: index, host: host)
            let size = host.fittingSize
            host.frame = NSRect(
                x: contentRight - size.width - Metrics.controlInset,
                y: blockRect.minY + Metrics.controlInset,
                width: size.width,
                height: size.height
            )

            // Output, parked in the reserved gap under the block.
            if let run = runProvider(index), hasContent(run) {
                let outputHost = outputViews[index] ?? {
                    let created = OutputHost(run: run)
                    textView.addSubview(created)
                    outputViews[index] = created
                    return created
                }()
                outputHost.setRun(run)
                let height = outputHeight(for: run)
                outputHost.frame = NSRect(
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
        for (index, view) in controlHosts where !liveIndices.contains(index) {
            view.removeFromSuperview()
            controlHosts.removeValue(forKey: index)
            controlSignatures.removeValue(forKey: index)
        }
        for (index, view) in outputViews where !liveIndices.contains(index) {
            view.removeFromSuperview()
            outputViews.removeValue(forKey: index)
        }
    }

    /// Rebuild a control's SwiftUI view only when its run state or visibility
    /// changed. The guard is what keeps a click from being cancelled by an
    /// unrelated relayout.
    private func applyControlView(index: Int, host: NSHostingView<BlockControls>) {
        let signature = ControlSignature(runState: currentRunState(index), visible: isVisible(index))
        guard controlSignatures[index] != signature else { return }
        controlSignatures[index] = signature
        host.rootView = makeControls(index: index, runState: signature.runState, visible: signature.visible)
    }

    /// Frames (text-view coordinates) of controls that are currently shown.
    func visibleControlFrames() -> [NSRect] {
        controlHosts.compactMap { index, host in isVisible(index) ? host.frame : nil }
    }

    private func makeControls(index: Int, runState: BlockRun.State?, visible: Bool) -> BlockControls {
        BlockControls(
            runState: runState,
            isVisible: visible,
            onRun: { [weak self] in self?.onRun?(index) },
            onCopy: { [weak self] in self?.copy(index) }
        )
    }

    /// The run state to show, or nil when the block cannot be run (so no run
    /// button appears and only copy is offered).
    private func currentRunState(_ index: Int) -> BlockRun.State? {
        guard index < blocks.count, RunnerTable.default.canRun(blocks[index].language) else { return nil }
        return runProvider(index)?.state ?? .idle
    }

    private func copy(_ index: Int) {
        guard index < blocks.count else { return }
        let body = blocks[index].body
        let string = text as NSString
        guard NSMaxRange(body) <= string.length else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(string.substring(with: body), forType: .string)
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
        static let controlInset: CGFloat = 6
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
