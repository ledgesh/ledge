import LedgeCore
import SwiftUI

/// The vertical tab strip. Workspaces stack and scroll, which is the whole point
/// of putting them down the side instead of across the top.
struct SidebarView: View {
    @Bindable var model: AppModel

    private var selection: Binding<WorkspaceID?> {
        Binding(
            get: { model.selectedID },
            set: { if let new = $0 { model.selectedID = new } }
        )
    }

    @State private var renamingID: WorkspaceID?

    var body: some View {
        List(selection: selection) {
            Section("Workspaces") {
                ForEach(model.sessions) { session in
                    SidebarRow(
                        session: session,
                        isRenaming: renamingID == session.id,
                        beginRename: { renamingID = session.id },
                        endRename: { renamingID = nil }
                    )
                    .tag(session.id)
                    .contextMenu {
                        Button("Rename") {
                            model.selectedID = session.id
                            renamingID = session.id
                        }
                        Button("Close Workspace") { model.closeWorkspace(session.id) }
                            .disabled(model.sessions.count == 1)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            // The divider and the button must be stacked explicitly. Handing
            // safeAreaInset two sibling views overlays them instead.
            VStack(spacing: 0) {
                Divider()
                Button {
                    model.newWorkspace()
                } label: {
                    Label("New Workspace", systemImage: "plus")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
            }
            .background(.bar)
        }
    }
}

private struct SidebarRow: View {
    let session: WorkspaceSession
    let isRenaming: Bool
    let beginRename: () -> Void
    let endRename: () -> Void

    @State private var draft = ""
    @FocusState private var fieldFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: session.workspace.symbol)
                .foregroundStyle(.secondary)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                if isRenaming {
                    TextField("", text: $draft)
                        .textFieldStyle(.plain)
                        .focused($fieldFocused)
                        .onSubmit(commit)
                        .onExitCommand(perform: endRename)
                        .onChange(of: fieldFocused) { _, focused in
                            if !focused { commit() }
                        }
                } else {
                    Text(session.workspace.name)
                        .lineLimit(1)
                }
                Text(session.summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 3)
        .contentShape(.rect)
        .onTapGesture(count: 2, perform: beginRename)
        .onChange(of: isRenaming) { _, renaming in
            guard renaming else { return }
            draft = session.workspace.name
            fieldFocused = true
        }
    }

    private func commit() {
        session.rename(to: draft)
        endRename()
    }
}
