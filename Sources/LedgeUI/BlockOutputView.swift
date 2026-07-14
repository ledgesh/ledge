import AppKit
import SwiftTerm
import SwiftUI

/// Renders one block's output in a real terminal surface.
///
/// SwiftTerm here is a display only. It never spawns a process: our ShellSession
/// owns the PTY and the marker protocol, slices the stream per block, and we
/// feed each block its own bytes. That keeps colors, cursor addressing, and
/// progress bars working without giving SwiftTerm control of anything.
struct BlockOutputView: NSViewRepresentable {
    let run: BlockRun

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> TerminalView {
        let view = TerminalView(frame: .init(x: 0, y: 0, width: 400, height: 80))
        view.terminalDelegate = context.coordinator
        view.configureNativeColors()
        view.allowMouseReporting = false

        if let terminal = view.terminal {
            terminal.silentLog = true
        }
        context.coordinator.feed(view, run: run, force: true)
        return view
    }

    func updateNSView(_ view: TerminalView, context: Context) {
        context.coordinator.feed(view, run: run)
    }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency TerminalViewDelegate {
        /// How many bytes of the run's output we have already fed. On a new run
        /// (revision resets, output shrinks) we reset and re-feed from zero.
        private var fedBytes = 0
        private var lastRunId: String?

        func feed(_ view: TerminalView, run: BlockRun, force: Bool = false) {
            if force || run.id != lastRunId || run.output.count < fedBytes {
                lastRunId = run.id
                fedBytes = 0
                view.getTerminal().resetToInitialState()
            }
            guard run.output.count > fedBytes else { return }
            let slice = run.output[run.output.index(run.output.startIndex, offsetBy: fedBytes)...]
            view.feed(byteArray: ArraySlice(slice))
            fedBytes = run.output.count
        }

        // Display-only: the terminal has nothing to send input to yet. When
        // interactive blocks land, this routes keystrokes back to the session.
        func send(source: TerminalView, data: ArraySlice<UInt8>) {}
        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {}
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
