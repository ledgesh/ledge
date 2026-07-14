import LedgeMarkdown
import SwiftUI

/// What the user is about to run, shown before anything executes.
///
/// "Never auto-run" and "show exactly what will run and where" are not polish,
/// they are the security model. No code path reaches the session without passing
/// through this sheet. The one relaxation allowed later is a per-note "trusted"
/// flag for self-authored local notes, and even then only for notes that never
/// arrived from sync or import.
struct RunPreflight: Identifiable {
    let id = UUID()
    let index: Int
    let block: CodeBlock
    let code: String
    let shell: String
    let cwd: String
    let runnable: Bool
}

struct RunPreflightSheet: View {
    let request: RunPreflight
    let onRun: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "play.circle.fill")
                    .foregroundStyle(.tint)
                Text("Run this block?")
                    .font(.headline)
            }
            .padding(.bottom, 12)

            Text("Ledge is about to run the following in this note's shell.")
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
