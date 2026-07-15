import LedgeMarkdown
import SwiftUI

/// What the user is about to run, shown before anything executes.
///
/// Not wired into the run path by default: runs currently go straight to the
/// shell. This sheet is kept for an opt-in "confirm before running" setting
/// (global, or a per-note flag for notes that arrived from sync or import), so
/// the "show exactly what will run and where" affordance is ready when we want
/// it without rebuilding it.
struct RunPreflight: Identifiable {
    let id = UUID()
    let index: Int
    let block: CodeBlock
    let code: String
    let shell: String
    let cwd: String
    let runnable: Bool
    let destination: RunDestination
}

struct RunPreflightSheet: View {
    let request: RunPreflight
    let onRun: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: request.destination == .terminalPane ? "terminal.fill" : "play.circle.fill")
                    .foregroundStyle(.tint)
                Text(request.destination == .terminalPane ? "Run in terminal?" : "Run this block?")
                    .font(.headline)
            }
            .padding(.bottom, 12)

            Text(subtitle)
                .foregroundStyle(.secondary)
                .font(.callout)
                .padding(.bottom, 12)

            ScrollView {
                Text(request.code.isEmpty ? "(empty)" : request.code)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
            .frame(maxHeight: 180)
            .background(.quinary, in: .rect(cornerRadius: 6))
            .padding(.bottom, 12)

            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 4) {
                detail("Language", request.block.language ?? "shell")
                detail("Shell", request.shell)
                detail("Directory", request.cwd)
                detail("Output", request.destination.label)
            }
            .font(.callout)
            .padding(.bottom, 4)

            if !request.runnable {
                Label(
                    "No runner is configured for this language.",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.callout)
                .foregroundStyle(.orange)
                .padding(.top, 8)
            }

            HStack {
                Spacer()
                Button("Cancel", role: .cancel, action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button("Run", action: onRun)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(!request.runnable)
            }
            .padding(.top, 16)
        }
        .padding(20)
        .frame(width: 480)
    }

    private var subtitle: String {
        switch request.destination {
        case .inline:
            "Ledge is about to run the following in this note's shell."
        case .terminalPane:
            "Ledge is about to run the following in this note's shell, in the terminal drawer."
        }
    }

    @ViewBuilder
    private func detail(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label)
                .foregroundStyle(.secondary)
                .gridColumnAlignment(.trailing)
            Text(value)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
        }
    }
}
