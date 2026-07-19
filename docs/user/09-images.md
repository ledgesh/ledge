# Images

Notes show their images. A markdown image reference standing alone on its own line renders as the actual picture, and the fastest way to get one there is to paste it.

## Paste to embed

Copy an image anywhere (a screenshot, a picture from the web) and press ⌘V in a note. If the pasteboard holds text, the paste is a text paste, unchanged; if it holds only an image, Ledge saves the image into the workspace and inserts the reference for you:

```
![](.ledge-assets/pasted-2026-07-19.png)
```

The file lands in `.ledge-assets/` inside the workspace folder, named by paste date, so an attached project folder carries its pasted images with it and the references stay relative. The folder is dot-prefixed on purpose: in a real project folder, Ledge's writes stay unmistakably Ledge's.

## What renders

Two kinds of source draw as real images:

- Web URLs: `![](https://example.com/chart.png)` loads straight from the network.
- Workspace files: `.ledge-assets/` pastes, and any image already in the workspace folder, referenced relative to it, so a note in an attached project can show the project's own `img/logo.png`.

The usual formats work: png, jpeg, gif, webp, avif, svg. Absolute paths and references outside the workspace stay as text, deliberately.

An image renders when its reference sits alone on a line and your caret is elsewhere. Click the picture (or move the caret onto its line) and it reverts to the editable markdown; move on and it becomes a picture again, the same reveal-on-touch rule as tables and links (see [[Finding Things]]). A reference inline in a sentence stays compact instead: syntax concealed, alt text styled like a link, no reflow-dodging while you read.

## Housekeeping

Deleting a note never deletes its images: `.ledge-assets/` files are left in place, which is the safe side of the trade (a stray unused image is cheap, a deleted image another note referenced is not). The files are ordinary files, greppable by name and syncable with the workspace.

One privacy note: an image pasted into a locked note is encrypted on disk from the very first byte, and locking a note seals the images it references. [[Note Locking]] has the full story.
