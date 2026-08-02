# Images

A Markdown image reference alone on its own line renders as the picture. The fastest way to get one there is to paste it.

## Paste an image

Copy an image anywhere, a screenshot or a picture from the web, and press ⌘V in a note. Ledge saves the image into the workspace and inserts the reference:

```
![](.ledge-assets/pasted-2026-07-19.png)
```

Ledge embeds only when the pasteboard holds an image and no text. A pasteboard holding text pastes as text, converted from formatting where there is any ([[Notes and Workspaces]]).

The file lands in `.ledge-assets/` inside the workspace folder, named by paste date. An attached project folder carries its pasted images with it, and the references stay relative. The folder is dot-prefixed so that Ledge's writes are identifiable inside a real project.

## Insert a picture you have not copied

Run **Insert Image…** from the palette to pick a picture instead of pasting one. Ledge saves it and inserts the reference exactly as a paste does.

On a Mac this opens a file dialog. On a phone it opens the photo library, and the button for it sits on the bar above the keyboard: a phone has no ⌘V, so this is the way pictures get into a note there.

A picture chosen this way is saved as a JPEG when it already is one (a photograph off a camera roll stays a tenth of the size it would be as a PNG), and as a PNG otherwise. Location data is not carried over.

## What renders

Two kinds of source draw as images:

- **Web URLs.** `![](https://example.com/chart.png)` loads from the network.
- **Workspace files.** `.ledge-assets/` pastes, and any image already in the workspace folder referenced relative to it. A note in an attached project can show the project's own `img/logo.png`.

Supported formats are png, jpeg, gif, webp, avif, and svg. Absolute paths and references outside the workspace stay as text.

An image renders when its reference sits alone on a line and your caret is elsewhere. Click the picture, or move the caret onto its line, and it reverts to editable Markdown; move away and it draws again. This is the same reveal-on-touch behavior as tables and links.

A reference inline in a sentence stays compact instead: the syntax is concealed and the alt text is styled like a link, so the line does not reflow while you read.

## Deleting notes and images

Deleting a note leaves its images in place. A stray unused image is cheaper than an image another note still references.

The files are ordinary files, so you can grep them by name and sync them with the workspace.

An image pasted into a locked note is encrypted on disk from the first byte, and locking a note seals the images it references. See [[Note Locking]].
