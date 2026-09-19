// The MIME type a dragged note row carries, with the note's path as its data.
// A custom type rather than text/plain because dataTransfer.types is readable
// during dragover while the data is not, so a drop target can tell a note from
// a file dragged in from outside. Read by the folder rows (NoteBrowser.tsx)
// and the workspace rows (workspace/Sidebar.tsx), which is why it lives here.
export const NOTE_DRAG = "application/x-ledge-note";
