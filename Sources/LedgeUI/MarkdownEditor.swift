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

    /// Runs the block at a document index. Wired to the run buttons the
    /// decoration controller places over the text.
    let onRunBlock: (Int) -> Void

    /// Bumped by the host whenever a run's state changes, so the editor knows to
    /// re-lay-out its output decorations.
    let decorationRevision: Int

    /// Looks up the latest run for a block index.
    let runProvider: (Int) -> BlockRun?

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

        textView.string = text
        context.coordinator.highlight(textView)

        let scrollView = NSScrollView()
        scrollView.documentView = textView
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = true
        scrollView.backgroundColor = .textBackgroundColor
        scrollView.borderType = .noBorder

        // Re-place decorations as the text scrolls: subviews are in the document
        // view's coordinate space, so they move with content, but a run whose
        // output height changed needs a fresh layout pass.
        scrollView.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(
            forName: NSView.boundsDidChangeNotification,
            object: scrollView.contentView,
            queue: .main
        ) { [weak coordinator = context.coordinator, weak textView] _ in
            guard let coordinator, let textView else { return }
            coordinator.relayoutDecorations(textView)
        }

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? LedgeTextView else { return }
        context.coordinator.parent = self
        textView.onBecomeFirstResponder = onFocus
        context.coordinator.decorations.onRun = onRunBlock

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

        /// Move the run buttons and output views without re-scanning the text.
        func relayoutDecorations(_ textView: NSTextView) {
            decorations.update(blocks: lastBlocks, runProvider: parent.runProvider)
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
            decorations.update(blocks: document.codeBlocks, runProvider: parent.runProvider)
        }
    }
}

/// An NSTextView that reports when it takes focus, so pane focus and the caret
/// cannot drift apart.
final class LedgeTextView: NSTextView {
    var onBecomeFirstResponder: (() -> Void)?

    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { onBecomeFirstResponder?() }
        return accepted
    }
}
