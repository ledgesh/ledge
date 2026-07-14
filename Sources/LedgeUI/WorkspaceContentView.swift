import Bonsplit
import Foundation
import LedgeCore
import LedgeMarkdown
import SessionKit
import SwiftUI

/// The right-hand side: the selected workspace's pane tree, where every pane has
/// its own horizontal tab bar.
struct WorkspaceContentView: View {
    let model: AppModel

    var body: some View {
        if let session = model.selected {
            BonsplitView(controller: session.controller) { tab, paneId in
                PaneContentView(session: session, tab: tab, paneId: paneId)
            } emptyPane: { paneId in
                EmptyPaneView(session: session, paneId: paneId)
            }
            // A fresh controller per workspace means a fresh view tree per
            // workspace. Without an identity, SwiftUI would try to reuse the
            // previous workspace's panes.
            .id(session.id)
        } else {
            Color(nsColor: .textBackgroundColor)
        }
    }
}

private struct PaneContentView: View {
    let session: WorkspaceSession
    // Fully qualified: SwiftUI has its own `Tab` type.
    let tab: Bonsplit.Tab
    let paneId: PaneID

    @State private var text = Sample.note
    @State private var focusToken = 0
    @State private var runtime = NoteRuntime(cwd: "~/Projects/ledge")
    @State private var preflight: RunPreflight?

    private var isFocusedPane: Bool { session.focusedPane == paneId }

    var body: some View {
        MarkdownEditor(
            text: $text,
            focusToken: focusToken,
            onFocus: {
                guard session.focusedPane != paneId else { return }
                session.controller.focusPane(paneId)
            },
            onBlocksChanged: { _ in },
            onRunBlock: requestRun,
            // Reading `layoutRevision` here subscribes the pane to run-state
            // changes; the editor re-lays-out its output only when this moves.
            decorationRevision: runtime.layoutRevision,
            runProvider: { runtime.run(forBlockAt: $0) }
        )
        // Inactive panes recede. The focused pane is the one that will receive a
        // keystroke, and later the one a run command targets, so it has to be
        // unmistakable at a glance.
        .opacity(isFocusedPane ? 1 : 0.45)
        .background(Color(nsColor: .textBackgroundColor))
        .sheet(item: $preflight) { request in
            RunPreflightSheet(
                request: request,
                onRun: {
                    preflight = nil
                    runtime.run(request.block, index: request.index, code: request.code)
                },
                onCancel: { preflight = nil }
            )
        }
        .onDisappear { runtime.shutdown() }
        .onChange(of: session.focusedPane) { _, focused in
            // Pane focus moved here from the menu or a keyboard shortcut, so put
            // the caret in the pane that is now lit. Non-selected tabs are still
            // in the hierarchy at zero opacity, so this must never fire for one:
            // it would hand the caret to an invisible view. Read the selection
            // now rather than in `body`, which keeps it out of Bonsplit's
            // unobservable internal state.
            guard focused == paneId,
                  session.controller.selectedTab(inPane: paneId)?.id == tab.id
            else { return }
            focusToken += 1
        }
    }

    /// The preflight gate. Every run passes through here: it is the whole of the
    /// "never auto-run, show exactly what will run and where" model.
    private func requestRun(_ index: Int) {
        // Re-scan rather than trust `blocks`: `onBlocksChanged` fires inside a
        // SwiftUI update pass, where a state mutation is dropped, so the cached
        // array can be empty. The scan is cheap and is the source of truth.
        let codeBlocks = MarkdownScanner.scan(text).codeBlocks
        guard index < codeBlocks.count else { return }
        let block = codeBlocks[index]
        guard !block.isUnterminated else { return }

        let code = (text as NSString).substring(with: block.body)
        let runners = RunnerTable.default
        preflight = RunPreflight(
            index: index,
            block: block,
            code: code,
            shell: (ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"),
            cwd: (runtime.cwd ?? "~"),
            runnable: runners.canRun(block.language)
        )
    }
}

private struct EmptyPaneView: View {
    let session: WorkspaceSession
    let paneId: PaneID

    var body: some View {
        VStack(spacing: 12) {
            Text("No open notes")
                .foregroundStyle(.secondary)
            Button("New Note") { session.openScratchNote(inPane: paneId) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .textBackgroundColor))
        .contentShape(.rect)
        .onTapGesture { session.controller.focusPane(paneId) }
    }
}

/// Placeholder content until notes come from disk.
private enum Sample {
    static let note = """
    ---
    cwd: ~/Projects/ledge
    ---

    # Scratch

    A note is **plain Markdown** on disk, with *no* lock-in. Ledge styles the
    syntax rather than hiding it, so `what you edit` is what is in the file.

    ## Runnable blocks

    Fenced code blocks become runnable, with output inline underneath:

    ```sh
    echo "hello from Ledge"
    uname -sm
    ```

    Every block runs in the note's own shell, so this sees the cd above:

    ```sh
    pwd
    ```

    - Plain text is just Markdown that uses no syntax
    - See [ledge.sh](https://ledge.sh)

    > Nothing runs unless you ask it to.
    """
}
