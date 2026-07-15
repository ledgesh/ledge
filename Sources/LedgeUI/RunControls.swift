import SwiftUI

/// The controls pinned to a code block's top-right: run (when the block can be
/// run) and copy. Hidden until the block is hovered or holds the caret.
struct BlockControls: View {
    /// The run state, or nil when the block is not runnable (copy only).
    let runState: BlockRun.State?
    let isVisible: Bool
    let onRun: () -> Void
    let onCopy: () -> Void

    @State private var didCopy = false

    var body: some View {
        HStack(spacing: 1) {
            if let runState {
                CodeBlockButton(symbol: runSymbol(runState), help: runHelp(runState), action: onRun)
            }
            CodeBlockButton(
                symbol: didCopy ? "checkmark" : "square.on.square",
                help: didCopy ? "Copied" : "Copy"
            ) {
                onCopy()
                withAnimation(.easeInOut(duration: 0.1)) { didCopy = true }
            }
        }
        .padding(2)
        .background(.regularMaterial, in: .rect(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator.opacity(0.7)))
        .opacity(isVisible ? 1 : 0)
        .allowsHitTesting(isVisible)
        .animation(.easeInOut(duration: 0.12), value: isVisible)
        // Reset the copied checkmark once the cluster hides, so it reads "copy"
        // again next time it appears.
        .onChange(of: isVisible) { _, visible in
            if !visible { didCopy = false }
        }
    }

    private func runSymbol(_ state: BlockRun.State) -> String {
        switch state {
        case .idle, .finished, .sessionEnded: "play.fill"
        case .queued: "clock"
        case .running: "circle.dotted"
        }
    }

    private func runHelp(_ state: BlockRun.State) -> String {
        switch state {
        case .idle, .finished, .sessionEnded: "Run"
        case .queued: "Queued"
        case .running: "Running"
        }
    }
}

/// One small icon button in a block's control cluster, with a subtle hover fill.
private struct CodeBlockButton: View {
    let symbol: String
    let help: String
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 22, height: 22)
                .background(
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.primary.opacity(hovering ? 0.1 : 0))
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(help)
    }
}

/// The status header plus the terminal surface for one block's output.
struct BlockOutputPanel: View {
    let run: BlockRun
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                statusDot
                Text(statusText)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer()
                if let duration = run.duration {
                    Text(format(duration))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 18, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Dismiss output")
            }
            .padding(.leading, 8)
            .padding(.trailing, 4)
            .frame(height: 22)

            BlockOutputView(run: run)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(.quinary, in: .rect(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator))
    }

    private var statusDot: some View {
        Circle()
            .fill(dotColor)
            .frame(width: 7, height: 7)
    }

    private var dotColor: Color {
        switch run.state {
        case .idle: .secondary
        case .queued: .orange
        case .running: .blue
        case let .finished(code): code == 0 ? .green : .red
        case .sessionEnded: .secondary
        }
    }

    private var statusText: String {
        switch run.state {
        case .idle: "Idle"
        case .queued: "Queued"
        case .running: "Running"
        case let .finished(code): code == 0 ? "Done" : "Exited \(code)"
        case .sessionEnded: "Session ended"
        }
    }

    private func format(_ seconds: TimeInterval) -> String {
        seconds < 1 ? String(format: "%.0f ms", seconds * 1000) : String(format: "%.1f s", seconds)
    }
}
