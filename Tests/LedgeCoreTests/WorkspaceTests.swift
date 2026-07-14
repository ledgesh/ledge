import Testing

@testable import LedgeCore

@Test func workspaceIDsAreUnique() {
    let a = Workspace(name: "One")
    let b = Workspace(name: "One")
    #expect(a.id != b.id)
}

@Test func noteRefCarriesFolder() {
    let note = NoteRef(title: "Deploy", folder: "ops")
    #expect(note.folder == "ops")
    #expect(note.isDirty == false)
}
