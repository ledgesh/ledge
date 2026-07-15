import AppKit
import SwiftTerm
import SwiftUI

/// The terminal drawer: a faithful, interactive view of the note's one shell.
///
/// Where `BlockOutputView` shows one block's sliced output and takes no input,
/// this shows the raw PTY transcript and sends keystrokes straight back, so you
/// can type commands directly into the same shell the blocks run in.
struct TerminalDrawer: View {
    let runtime: NoteRuntime
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            // Reading the observable transcript here subscribes the drawer to new
            // bytes; the terminal view feeds only what it has not seen yet.
            LiveTerminalView(
                runtime: runtime,
                output: runtime.terminalOutput,
                revision: runtime.terminalRevision
            )
        }
        .background(Color(nsColor: .textBackgroundColor))
        // Opening the drawer is what brings the shell up, so an untouched note
        // that you only want a terminal in still gets a live prompt.
        .onAppear { runtime.activateTerminal() }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "terminal")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
            Text("Terminal")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
            if let cwd = runtime.cwd {
                Text(cwd)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 20, height: 20)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Close terminal")
            // SwiftTerm turns on `acceptsMouseMovedEvents` for the whole window, so
            // AppKit runs its own cursor management on every mouse move and resets
            // the header to the arrow just after any one-shot `NSCursor.set()`. The
            // way to win is to join that mechanism: a `cursorUpdate` tracking area
            // is how AppKit itself decides the cursor, so the pointing hand sticks.
            .overlay(PointingHandCursor())
        }
        .padding(.horizontal, 8)
        .frame(height: 26)
        .background(.quinary)
    }
}

/// A transparent overlay that asserts the pointing-hand cursor over its bounds.
///
/// Placed as an `.overlay` on the close button. It owns a `cursorUpdate` tracking
/// area, which is the same mechanism AppKit uses to choose the cursor, so it holds
/// against the terminal view's window-wide mouse-moved cursor management. It is
/// invisible to mouse clicks (`hitTest` returns nil), so the button underneath
/// still receives the tap.
private struct PointingHandCursor: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { CursorView() }
    func updateNSView(_ nsView: NSView, context: Context) {}

    final class CursorView: NSView {
        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            for area in trackingAreas { removeTrackingArea(area) }
            addTrackingArea(
                NSTrackingArea(
                    rect: bounds,
                    options: [.activeInActiveApp, .mouseEnteredAndExited, .cursorUpdate],
                    owner: self,
                    userInfo: nil,
                ),
            )
        }

        override func cursorUpdate(with event: NSEvent) {
            NSCursor.pointingHand.set()
        }
    }
}

/// A thin draggable strip that sizes the drawer. Dragging up grows the terminal.
struct TerminalResizeHandle: View {
    @Binding var height: CGFloat

    @State private var dragStartHeight: CGFloat?

    private static let minHeight: CGFloat = 120
    private static let maxHeight: CGFloat = 600

    var body: some View {
        Divider()
            .frame(height: 6)
            .contentShape(Rectangle())
            .onHover { inside in
                if inside { NSCursor.resizeUpDown.set() } else { NSCursor.arrow.set() }
            }
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let start = dragStartHeight ?? height
                        if dragStartHeight == nil { dragStartHeight = start }
                        let proposed = start - value.translation.height
                        height = min(max(proposed, Self.minHeight), Self.maxHeight)
                    }
                    .onEnded { _ in dragStartHeight = nil }
            )
    }
}

/// An interactive SwiftTerm surface bound to the note's shell.
///
/// Feeds the accumulated transcript on first appearance and each new chunk after,
/// and routes keystrokes and resizes back to the shell through `NoteRuntime`. The
/// terminal never spawns a process of its own: `ShellSession` still owns the PTY.
struct LiveTerminalView: NSViewRepresentable {
    let runtime: NoteRuntime
    let output: Data
    let revision: Int

    func makeCoordinator() -> Coordinator { Coordinator(runtime: runtime) }

    func makeNSView(context: Context) -> TerminalView {
        let view = TerminalView(frame: .init(x: 0, y: 0, width: 600, height: 200))
        view.terminalDelegate = context.coordinator
        view.configureNativeColors()
        if let terminal = view.terminal {
            terminal.silentLog = true
        }
        context.coordinator.feed(view, output: output, force: true)
        return view
    }

    func updateNSView(_ view: TerminalView, context: Context) {
        context.coordinator.feed(view, output: output)
    }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency TerminalViewDelegate {
        private let runtime: NoteRuntime
        /// How many bytes of the transcript we have already fed. On a shell
        /// restart the transcript resets and shrinks, so we re-feed from zero.
        private var fedBytes = 0

        init(runtime: NoteRuntime) {
            self.runtime = runtime
        }

        func feed(_ view: TerminalView, output: Data, force: Bool = false) {
            if force || output.count < fedBytes {
                fedBytes = 0
                view.getTerminal().resetToInitialState()
            }
            guard output.count > fedBytes else { return }
            let slice = output[output.index(output.startIndex, offsetBy: fedBytes)...]
            view.feed(byteArray: ArraySlice(slice))
            fedBytes = output.count
        }

        // Keystrokes typed into the drawer go straight to the shell.
        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            runtime.sendToTerminal(Data(data))
        }

        // The view resized: tell the shell its new dimensions so full-screen
        // programs (top, vim) lay out correctly.
        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            runtime.resizeTerminal(columns: UInt16(newCols), rows: UInt16(newRows))
        }

        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func scrolled(source: TerminalView, position: Double) {}
        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}
        func bell(source: TerminalView) {}
        func clipboardCopy(source: TerminalView, content: Data) {}
        func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }
}
