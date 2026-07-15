import AppKit
import LedgeMarkdown
import SwiftUI

/// The Markdown editor: a real `NSTextView` with live syntax highlighting.
///
/// Not a webview and not a SwiftUI `TextEditor`. The editor has to stay fast on
/// large notes, own its undo stack, and eventually anchor run buttons to code
/// block ranges, and only AppKit gives us that.
struct MarkdownEditor: NSViewRepresentable {
    @Binding var text: String

    /// Bump to ask the text view to take first responder. A counter rather than
    /// a Bool, so that repeated focus requests are not swallowed.
    let focusToken: Int

    /// Fired when the user clicks into the text, so the pane can take focus.
    let onFocus: () -> Void

    /// Reports the code blocks found in the current text. The run affordance
    /// will hang off this.
    let onBlocksChanged: ([CodeBlock]) -> Void

    /// Runs the block at a document index inline. Wired to the run buttons the
    /// decoration controller places over the text, and to Cmd+Return.
    let onRunBlock: (Int) -> Void

    /// Runs the block at a document index in the terminal drawer. Wired to
    /// Cmd+Shift+Return.
    let onRunBlockInTerminal: (Int) -> Void

    /// Dismisses the inline output of the block at a document index.
    let onDismissBlock: (Int) -> Void

    /// Bumped by the host whenever a run's state changes, so the editor knows to
    /// re-lay-out its output decorations.
    let decorationRevision: Int

    /// Looks up the latest run for a block index.
    let runProvider: (Int) -> BlockRun?

    /// Toggles the note's terminal drawer (Ctrl+`).
    let onToggleTerminal: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = LedgeTextView()
        textView.delegate = context.coordinator
        textView.onBecomeFirstResponder = onFocus

        textView.isRichText = false
        textView.allowsUndo = true
        textView.isEditable = true
        textView.isSelectable = true
        // Every one of these would corrupt Markdown or code: a smart quote in a
        // shell command is a different command.
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isAutomaticDataDetectionEnabled = false
        textView.isAutomaticLinkDetectionEnabled = false

        textView.font = MarkdownTheme.baseFont
        textView.textColor = .textColor
        textView.backgroundColor = .textBackgroundColor
        textView.drawsBackground = true
        textView.textContainerInset = NSSize(width: 12, height: 14)
        textView.autoresizingMask = [.width]
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.textContainer?.widthTracksTextView = true

        context.coordinator.decorations.attach(to: textView)
        context.coordinator.decorations.onRun = onRunBlock
        context.coordinator.decorations.onDismiss = onDismissBlock

        // Hovering a block, or scrolling/resizing, drives the decorations without
        // a polling timer. Hover only toggles visibility; layout repositions.
        textView.onHoverPoint = { [weak coordinator = context.coordinator] point in
            coordinator?.decorations.updateHover(point: point)
        }
        textView.onLayout = { [weak coordinator = context.coordinator] in
            coordinator?.decorations.relayout()
        }
        textView.controlRects = { [weak coordinator = context.coordinator] in
            coordinator?.decorations.visibleControlFrames() ?? []
        }
        textView.onRunShortcut = { [weak coordinator = context.coordinator, weak textView] destination in
            guard let coordinator, let textView else { return }
            let caret = textView.selectedRange().location
            guard let index = coordinator.decorations.runnableBlockIndex(atCharacter: caret) else { return }
            switch destination {
            case .inline: coordinator.parent.onRunBlock(index)
            case .terminalPane: coordinator.parent.onRunBlockInTerminal(index)
            }
        }
        textView.onToggleTerminal = { [weak coordinator = context.coordinator] in
            coordinator?.parent.onToggleTerminal()
        }

        textView.string = text
        context.coordinator.highlight(textView)

        let scrollView = NSScrollView()
        scrollView.documentView = textView
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = true
        scrollView.backgroundColor = .textBackgroundColor
        scrollView.borderType = .noBorder

        // Decorations are subviews of the document view, so they scroll with the
        // content for free. Only a size change needs a reposition, and the text
        // view reports that through `onLayout`.

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? LedgeTextView else { return }
        context.coordinator.parent = self
        textView.onBecomeFirstResponder = onFocus
        context.coordinator.decorations.onRun = onRunBlock
        context.coordinator.decorations.onDismiss = onDismissBlock

        // Only touch the text when it changed underneath us. Assigning `string`
        // unconditionally would reset the selection on every SwiftUI update.
        if textView.string != text {
            let selection = textView.selectedRange()
            textView.string = text
            textView.setSelectedRange(clamp(selection, to: (text as NSString).length))
            context.coordinator.highlight(textView)
        } else if context.coordinator.lastDecorationRevision != decorationRevision {
            // Text is unchanged but a run advanced, so only the decorations need
            // to move. Avoid a full rehighlight for every streamed output chunk.
            context.coordinator.lastDecorationRevision = decorationRevision
            context.coordinator.relayoutDecorations(textView)
        }

        if context.coordinator.lastFocusToken != focusToken {
            context.coordinator.lastFocusToken = focusToken
            // The window may not exist yet on the first layout pass.
            DispatchQueue.main.async {
                textView.window?.makeFirstResponder(textView)
            }
        }
    }

    private func clamp(_ range: NSRange, to length: Int) -> NSRange {
        let location = min(range.location, length)
        return NSRange(location: location, length: min(range.length, length - location))
    }

    // MARK: - Coordinator

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MarkdownEditor
        var lastFocusToken = 0
        var lastDecorationRevision = 0
        let decorations = BlockDecorationController()
        private var lastBlocks: [CodeBlock] = []

        init(_ parent: MarkdownEditor) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? LedgeTextView else { return }
            parent.text = textView.string
            highlight(textView)
        }

        /// Reveal a block's controls when the caret lands in it.
        func textViewDidChangeSelection(_ notification: Notification) {
            guard let textView = notification.object as? LedgeTextView else { return }
            decorations.updateCaret(characterIndex: textView.selectedRange().location)
        }

        /// Re-place the output views (and their reserved space) without
        /// re-scanning the text. Used when a run advances.
        func relayoutDecorations(_ textView: NSTextView) {
            decorations.update(blocks: lastBlocks, text: textView.string, runProvider: parent.runProvider)
        }

        /// Re-scan and restyle the whole document.
        ///
        /// A full pass per keystroke is fine at the sizes we are at now and is
        /// far easier to reason about than incremental invalidation. When the
        /// perf harness says it is not fine, the fix is to reuse the scan and
        /// restyle only the changed paragraphs. Do not do that until it earns
        /// its complexity.
        func highlight(_ textView: LedgeTextView) {
            guard let storage = textView.textStorage else { return }
            let document = MarkdownScanner.scan(textView.string)
            let full = NSRange(location: 0, length: storage.length)

            storage.beginEditing()
            storage.setAttributes(MarkdownTheme.baseAttributes, range: full)
            for token in document.tokens {
                // The scanner works on the same string, but defend anyway: a
                // stale range applied to a shorter string is a crash.
                guard NSMaxRange(token.range) <= storage.length else { continue }
                storage.addAttributes(MarkdownTheme.attributes(for: token.kind), range: token.range)
            }
            storage.endEditing()

            // Typing past the end of a styled span must not inherit its style.
            textView.typingAttributes = MarkdownTheme.baseAttributes

            lastBlocks = document.codeBlocks
            parent.onBlocksChanged(document.codeBlocks)
            decorations.update(blocks: document.codeBlocks, text: textView.string, runProvider: parent.runProvider)
        }
    }
}

/// An NSTextView that reports focus, mouse movement, and layout, so pane focus
/// and the caret cannot drift apart and the block decorations know when to
/// reveal and reposition themselves.
final class LedgeTextView: NSTextView {
    var onBecomeFirstResponder: (() -> Void)?
    /// The mouse moved to this point in view coordinates, or `nil` on exit.
    var onHoverPoint: ((NSPoint?) -> Void)?
    /// The view was (re)sized, so decorations pinned to glyph geometry must move.
    var onLayout: (() -> Void)?
    /// Frames (view coordinates) of controls that should show a pointing-hand
    /// cursor. Consulted on every mouse move.
    var controlRects: (() -> [NSRect])?
    /// The user pressed a run hotkey. Carries where the output should go:
    /// Cmd+Return is inline, Cmd+Shift+Return is the terminal drawer.
    var onRunShortcut: ((RunDestination) -> Void)?
    /// The user pressed the terminal-drawer toggle (Ctrl+`).
    var onToggleTerminal: (() -> Void)?

    private var hoverTracking: NSTrackingArea?

    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { onBecomeFirstResponder?() }
        return accepted
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverTracking { removeTrackingArea(hoverTracking) }
        let area = NSTrackingArea(
            rect: .zero,
            options: [.activeInKeyWindow, .inVisibleRect, .mouseMoved, .mouseEnteredAndExited],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        hoverTracking = area
    }

    override func mouseMoved(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        // Over a control, set the pointing hand and skip `super`: NSTextView
        // re-asserts its I-beam inside its own `mouseMoved`, which is what has
        // been overriding every cursor rect we set.
        if controlRects?().contains(where: { $0.contains(point) }) == true {
            NSCursor.pointingHand.set()
        } else {
            super.mouseMoved(with: event)
        }
        onHoverPoint?(point)
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        onHoverPoint?(nil)
    }

    /// Command-modified keys are offered to the view tree as key equivalents
    /// before `keyDown` is ever called, and something in the hierarchy was eating
    /// Cmd+Return there, so it never reached `keyDown`. Handling the run shortcuts
    /// here, where command shortcuts belong, is what makes them fire reliably.
    /// Only the focused editor acts, so a Cmd+Return in another pane is ignored.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let isReturn = event.keyCode == 36 || event.keyCode == 76
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if isReturn, mods.contains(.command), window?.firstResponder === self {
            onRunShortcut?(mods.contains(.shift) ? .terminalPane : .inline)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    override func keyDown(with event: NSEvent) {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        // Ctrl+` toggles the terminal drawer (keyCode 50 is the grave/tilde key).
        // Control keys are not key equivalents, so this stays in keyDown.
        if event.keyCode == 50, mods == .control {
            onToggleTerminal?()
            return
        }
        super.keyDown(with: event)
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        onLayout?()
    }
}
