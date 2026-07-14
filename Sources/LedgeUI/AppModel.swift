import Bonsplit
import LedgeCore
import Observation

/// Root of the UI state: the ordered list of workspaces shown in the vertical
/// sidebar, and which one is selected.
///
/// There is no persistence yet. Session restore attaches here.
@MainActor
@Observable
public final class AppModel {
    public private(set) var sessions: [WorkspaceSession] = []
    public var selectedID: WorkspaceID

    public init() {
        let first = WorkspaceSession(workspace: Workspace(name: "Scratch", symbol: "tray"))
        first.openScratchNote()
        sessions = [first]
        selectedID = first.id
    }

    public var selected: WorkspaceSession? {
        sessions.first { $0.id == selectedID }
    }

    // MARK: - Workspaces

    @discardableResult
    public func newWorkspace() -> WorkspaceSession {
        let n = sessions.count + 1
        let session = WorkspaceSession(
            workspace: Workspace(name: "Workspace \(n)", symbol: "square.stack")
        )
        session.openScratchNote()
        sessions.append(session)
        selectedID = session.id
        return session
    }

    public func closeWorkspace(_ id: WorkspaceID) {
        guard sessions.count > 1, let idx = sessions.firstIndex(where: { $0.id == id })
        else { return }
        sessions.remove(at: idx)
        if selectedID == id {
            selectedID = sessions[min(idx, sessions.count - 1)].id
        }
    }

    public func selectWorkspace(at index: Int) {
        guard sessions.indices.contains(index) else { return }
        selectedID = sessions[index].id
    }

    public func selectWorkspace(offsetBy delta: Int) {
        guard let current = sessions.firstIndex(where: { $0.id == selectedID }) else { return }
        let next = (current + delta + sessions.count) % sessions.count
        selectedID = sessions[next].id
    }

    // MARK: - Commands routed from the menu bar

    public func newTab() {
        selected?.openScratchNote()
    }

    public func closeTab() {
        guard let session = selected,
              let pane = session.controller.focusedPaneId,
              let tab = session.controller.selectedTab(inPane: pane)
        else { return }
        _ = session.controller.closeTab(tab.id, inPane: pane)
    }

    public func split(_ orientation: SplitOrientation) {
        selected?.split(orientation)
    }

    public func closePane() {
        guard let session = selected, let pane = session.controller.focusedPaneId else { return }
        session.controller.closePane(pane)
    }

    public func toggleZoom() {
        selected?.controller.toggleZoom()
    }

    public func selectTab(offsetBy delta: Int) {
        guard let controller = selected?.controller else { return }
        delta < 0 ? controller.selectPreviousTab() : controller.selectNextTab()
    }

    public func navigateFocus(_ direction: NavigationDirection) {
        selected?.controller.navigateFocus(direction: direction)
    }
}
