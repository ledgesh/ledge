import Foundation

/// Stable identifier for a note.
///
/// This is Ledge's own id, not Bonsplit's. Bonsplit mints an opaque `TabID` for
/// every tab it creates and offers no way to construct one from a value we
/// choose, so the UI layer keeps a `TabID -> NoteID` mapping rather than trying
/// to make the two id spaces agree. Restoring a layout means replaying the tabs
/// and rebuilding that mapping, not reinstating Bonsplit's old ids.
public struct NoteID: Hashable, Codable, Sendable {
    public let raw: UUID

    public init(_ raw: UUID = UUID()) {
        self.raw = raw
    }
}

/// What a tab needs to know about a note in order to render its row.
///
/// Phase 0 placeholder: there is no file behind this yet. When the note store
/// lands, this becomes a projection of a note on disk.
public struct NoteRef: Identifiable, Hashable, Sendable {
    public let id: NoteID
    public var title: String
    /// Folder the note lives in, relative to the notes root. Nil means the root.
    public var folder: String?
    public var isDirty: Bool

    public init(
        id: NoteID = NoteID(),
        title: String,
        folder: String? = nil,
        isDirty: Bool = false
    ) {
        self.id = id
        self.title = title
        self.folder = folder
        self.isDirty = isDirty
    }
}
