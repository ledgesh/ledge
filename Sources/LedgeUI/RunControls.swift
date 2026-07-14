import SwiftUI

/// The run affordance pinned to a code block.
struct RunButton: View {
    let state: BlockRun.State
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .labelStyle(.iconOnly)
                .font(.system(size: 11, weight: .semibold))
                .frame(width: 20, height: 20)
                .background(.thinMaterial, in: .circle)
                .overlay(Circle().strokeBorder(.separator))
        }
        .buttonStyle(.plain)
        .help(title)
    }

    private var title: String {
        switch state {
        case .idle, .finished, .sessionEnded: "Run"
        case .queued: "Queued"
        case .running: "Running"
        }
    }

    private var symbol: String {
        switch state {
        case .idle, .finished, .sessionEnded: "play.fill"
        case .queued: "clock"
        case .running: "circle.dotted"
        }
    }
}

/// The status header plus the terminal surface for one block's output.
struct BlockOutputPanel: View {
    let run: BlockRun

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
            }
            .padding(.horizontal, 8)
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
