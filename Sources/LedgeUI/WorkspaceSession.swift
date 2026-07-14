import Bonsplit
import LedgeCore
import Observation

/// One sidebar entry: a workspace plus the live pane tree that belongs to it.
///
/// Each workspace owns its own `BonsplitController`, so switching workspaces in
/// the sidebar preserves every workspace's splits, tabs, and selection. This is
/// also the seam where a note's shell session will later be attached, which is
/// why the `TabID -> NoteRef` mapping lives here rather than in a view.
@MainActor
@Observable
public final class WorkspaceSession: @MainActor Identifiable {
    public var workspace: Workspace
    public let controller: BonsplitController

    /// Which note is shown in which Bonsplit tab. Bonsplit's `TabID` is opaque
    /// and app-assigned ids cannot be pushed into it, so we map instead.
    public private(set) var notes: [TabID: NoteRef] = [:]

    /// Mirrored from Bonsplit's delegate callbacks. Bonsplit's own split state
    /// is not observable from out here, so anything the sidebar or a pane needs
    /// to react to has to be tracked on this side.
    public private(set) var paneCount: Int = 1
    public private(set) var focusedPane: PaneID?

    /// Retained because `BonsplitController.delegate` is weak.
    private var events: WorkspaceEvents?

    public var id: WorkspaceID { workspace.id }

    public init(workspace: Workspace) {
        self.workspace = workspace
        controller = BonsplitController(
            configuration: BonsplitConfiguration(
                allowCloseLastPane: false,
                // Keep every tab's view alive. The editor is an NSTextView and
                // later a live terminal: rebuilding those on tab switch would
                // throw away cursor position, scroll, undo stack, and PTY view
                // state. This is the single most important config flag here.
                contentViewLifecycle: .keepAllAlive,
                appearance: .compact
            )
        )

        let events = WorkspaceEvents()
        events.session = self
        controller.delegate = events
        self.events = events

        // Bonsplit starts with one focused pane but does not announce it, and an
        // unset focus would render the only pane as dimmed and inactive.
        focusedPane = controller.focusedPaneId
    }

    // MARK: - Tabs

    /// Opens a note in a new tab. Auto-open is the default everywhere in Ledge:
    /// no modifier key, opening a note always gets you a tab.
    @discardableResult
    public func openNote(_ note: NoteRef, inPane pane: PaneID? = nil) -> TabID? {
        guard let tabId = controller.createTab(
            title: note.title,
            icon: note.isDirty ? "doc.text.fill" : "doc.text",
            isDirty: note.isDirty,
            inPane: pane
        ) else { return nil }
        notes[tabId] = note
        return tabId
    }

    public func note(for tabId: TabID) -> NoteRef? {
        notes[tabId]
    }

    fileprivate func forgetTab(_ tabId: TabID) {
        notes.removeValue(forKey: tabId)
    }

    /// Bonsplit owns the tab's title. This keeps our note in step with it.
    /// Once notes are files, this is where the rename hits disk.
    fileprivate func renameNote(_ tabId: TabID, to title: String) {
        notes[tabId]?.title = title
    }

    public func rename(to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        workspace.name = trimmed
    }

    fileprivate func setFocusedPane(_ pane: PaneID?) {
        focusedPane = pane
    }

    fileprivate func setPaneCount(_ count: Int) {
        paneCount = count
    }

    /// Placeholder note factory for Phase 0. Goes away with the note store.
    public func openScratchNote(inPane pane: PaneID? = nil) {
        let n = notes.count + 1
        openNote(
            NoteRef(title: "Untitled \(n)", folder: ["inbox", "projects", "log"][n % 3]),
            inPane: pane
        )
    }

    // MARK: - Splits

    public func split(_ orientation: SplitOrientation) {
        controller.splitPane(orientation: orientation)
        // The new pane is seeded in the delegate, not here: Bonsplit's own split
        // buttons in the tab bar call `splitPane` directly, so seeding here would
        // only cover splits that came from our menu.
    }

    fileprivate func seedIfEmpty(_ pane: PaneID) {
        guard controller.tabs(inPane: pane).isEmpty else { return }
        openScratchNote(inPane: pane)
    }

    // MARK: - Sidebar subtitle

    public var summary: String {
        let tabs = notes.count
        return "\(tabs) \(tabs == 1 ? "tab" : "tabs"), \(paneCount) \(paneCount == 1 ? "pane" : "panes")"
    }
}

/// Bonsplit's delegate is a class-bound protocol held weakly, so it cannot be
/// the `@Observable` session itself without a retain cycle. This forwards, and
/// mirrors the bits of Bonsplit's state we need to observe.
/// `@preconcurrency`: BonsplitDelegate is not actor-annotated, but Bonsplit only
/// ever calls it from `BonsplitController`, which is `@MainActor`.
@MainActor
private final class WorkspaceEvents: @preconcurrency BonsplitDelegate {
    weak var session: WorkspaceSession?

    func splitTabBar(_: BonsplitController, didCloseTab tabId: TabID, fromPane _: PaneID) {
        session?.forgetTab(tabId)
    }

    func splitTabBar(_: BonsplitController, didRenameTab tab: Bonsplit.Tab, inPane _: PaneID) {
        session?.renameNote(tab.id, to: tab.title)
    }

    func splitTabBar(_ controller: BonsplitController, didFocusPane pane: PaneID) {
        session?.setFocusedPane(pane)
        session?.setPaneCount(controller.allPaneIds.count)
    }

    func splitTabBar(
        _ controller: BonsplitController,
        didSplitPane _: PaneID,
        newPane: PaneID,
        orientation _: SplitOrientation
    ) {
        session?.setFocusedPane(newPane)
        session?.setPaneCount(controller.allPaneIds.count)
        // Bonsplit leaves a new pane empty. An empty pane is a dead grey
        // rectangle you cannot close by closing a tab, because it has none, so
        // every split gets a note.
        session?.seedIfEmpty(newPane)
    }

    func splitTabBar(_ controller: BonsplitController, didClosePane _: PaneID) {
        session?.setFocusedPane(controller.focusedPaneId)
        session?.setPaneCount(controller.allPaneIds.count)
    }
}
