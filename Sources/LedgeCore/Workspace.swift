import Foundation

/// Stable identifier for a workspace. A workspace is one entry in the vertical
/// sidebar and owns an entire pane tree.
public struct WorkspaceID: Hashable, Codable, Sendable {
    public let raw: UUID

    public init(_ raw: UUID = UUID()) {
        self.raw = raw
    }
}

/// The metadata a workspace shows in the vertical sidebar. Deliberately dumb:
/// the pane tree that belongs to a workspace lives in the UI layer, because it
/// is owned by Bonsplit.
public struct Workspace: Identifiable, Hashable, Sendable {
    public let id: WorkspaceID
    public var name: String
    /// SF Symbol name shown in the sidebar row.
    public var symbol: String

    public init(id: WorkspaceID = WorkspaceID(), name: String, symbol: String = "square.stack") {
        self.id = id
        self.name = name
        self.symbol = symbol
    }
}
