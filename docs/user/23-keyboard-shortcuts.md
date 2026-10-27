# Keyboard Shortcuts

Every command's keyboard shortcut can be changed, removed, or added with the `keys` setting. This page covers the setting and lists every command with its id and default shortcut.

Menus, the command palette (⇧⌘P), and button tooltips show each command's current shortcut.

## Changing a shortcut

Add a `keys` section under This app in Settings (⌘,) and relaunch. Each entry is a command's id and the chords that run it.

```jsonc
"keys": {
  "pane.splitRight": ["Mod-Alt-d"],
  "editor.duplicateLine": "Mod-d",
  "terminal.toggle": []
}
```

With that section, Split Right moves to a new chord, Duplicate Line takes the chord Split Right had, and Toggle Terminal has no shortcut.

- An entry replaces all of its command's default chords.
- A chord you assign is taken from the command that had it. That command keeps its other chords.
- An entry is one chord or a list of chords. An empty list leaves the command with no shortcut.
- A chord you assign also works while you type in a note, in place of whatever the editor used that chord for.

The setting belongs to this app on this computer. It applies whichever server's notes the window shows.

As you type, the Settings dialog lists each entry it cannot use. The command that entry names keeps its default shortcut.

## Writing a chord

A chord is its modifiers and then one key, joined with `-`, as in `Mod-Shift-d`. Joining with `+` works too.

| Part | Write |
| --- | --- |
| Modifiers | `Mod`, `Ctrl`, `Alt`, `Shift`, `Meta` |
| A character key | The character the key types without Shift: `d`, `1`, `,`, `]` |
| A named key | `Enter`, `Backspace`, `Delete`, `Tab`, `Space`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `PageUp`, `PageDown`, `Insert` |
| A function key | `F1` to `F24` |

`Mod` is the Command key on a Mac and Ctrl on Linux and Windows. `Meta` is the Command key on a Mac and the Super or Windows key elsewhere.

A chord needs `Mod`, `Ctrl` or `Alt`, because a key pressed alone is typing. A function key is the exception and can stand alone.

For a character typed with Shift, write `Shift` and the key it is on: `Mod-Shift-]`, not `Mod-}`.

## Shortcuts that cannot be changed

- Escape, which closes or leaves whatever is in front.
- ⌘1 to ⌘9, which switch workspace, and ⌃1 to ⌃9, which go to a tab.
- The single keys that act on a focused row, such as Enter, D and R.
- Copy, paste and select all in the terminal.
- On a Mac, the menu bar's own shortcuts: Hide, Hide Others, Quit, Minimize, Undo, Redo and Enter Full Screen.

With the terminal focused, Ctrl chords go to the shell whatever they are assigned to. On a Mac that is every Ctrl chord. On Linux and Windows it is Ctrl with neither Shift nor Alt.

## Commands and their default shortcuts

The id is what a `keys` entry names. A command with no default has no shortcut until you give it one.

### Notes and search

| Command | Id | Default |
| --- | --- | --- |
| New Note | `note.new` | `Mod-n`, `Mod-t` |
| Open Today's Daily Note | `daily.open` | `Mod-j` |
| New Note from Template… | `note.fromTemplate` | `Alt-Mod-n` |
| New Template | `template.starter` |  |
| Make This Note a Template | `note.templateOn` |  |
| Remove Template Marker | `note.templateOff` |  |
| Edit Daily Template | `daily.templateEdit` |  |
| New Daily Template | `daily.templateNew` |  |
| Go to Note… | `palette.notes` | `Mod-p` |
| Command Palette… | `palette.commands` | `Mod-Shift-p` |
| Search Notes… | `palette.search` | `Alt-Mod-p` |
| Delete Note | `note.deleteCurrent` | `Mod-Backspace` |
| Favorite | `note.favorite` |  |
| Archive | `note.archive` |  |
| Move to Folder… | `note.move` |  |
| Move to Workspace… | `note.moveToWorkspace` |  |
| New Folder… | `folder.new` |  |
| Sort Notes by Last Modified | `note.sortByModified` |  |
| Sort Notes by Title | `note.sortByTitle` |  |
| Empty Trash… | `trash.empty` |  |

### Editing

These run in the note you are typing in.

| Command | Id | Default |
| --- | --- | --- |
| Save | `editor.save` | `Mod-s` |
| Cut | `editor.cut` | `Mod-x` |
| Copy | `editor.copy` | `Mod-c` |
| Paste | `editor.paste` | `Mod-v` |
| Paste as Plain Text | `editor.pastePlain` | `Mod-Shift-v` |
| Select All | `editor.selectAll` | `Mod-a` |
| Find | `editor.find` | `Mod-f` |
| Find and Replace | `editor.replace` | `Mod-Alt-f`, `Mod-Shift-f` |
| Find Next | `editor.findNext` | `Mod-g`, `F3` |
| Find Previous | `editor.findPrev` | `Mod-Shift-g`, `Shift-F3` |
| Select Next Occurrence | `editor.selectNextOccurrence` |  |
| Duplicate Line | `editor.duplicateLine` |  |
| Run Block Inline | `block.runInline` | `Mod-Enter` |
| Run Block in Terminal | `block.runInTerminal` | `Mod-Shift-Enter` |
| Bold | `format.bold` | `Mod-b` |
| Italic | `format.italic` | `Mod-i` |
| Insert Link | `format.link` | `Mod-k` |
| Indent | `format.indent` |  |
| Outdent | `format.outdent` |  |
| Link to Note | `format.wikiLink` |  |
| Code Block | `format.codeBlock` |  |
| Insert Image… | `image.insert` |  |
| Open Link | `link.open` |  |
| Toggle Checkbox | `task.toggle` |  |

### Tabs and panes

| Command | Id | Default |
| --- | --- | --- |
| Close Tab | `tab.close` | `Mod-w` |
| Close Other Tabs | `tab.closeOthers` |  |
| Keep Tab Open | `tab.keep` |  |
| Next Tab | `tab.next` | `Ctrl-Tab`, `Mod-Shift-]` |
| Previous Tab | `tab.prev` | `Ctrl-Shift-Tab`, `Mod-Shift-[` |
| Split Right | `pane.splitRight` | `Mod-d` |
| Split Down | `pane.splitDown` | `Mod-Shift-d` |
| Close Pane | `pane.close` | `Mod-Shift-w` |

### Workspaces

| Command | Id | Default |
| --- | --- | --- |
| New Workspace | `workspace.new` | `Mod-Shift-n` |
| Attach Folder as Workspace… | `workspace.attach` |  |
| Rename Workspace… | `workspace.rename` |  |
| Change Icon… | `workspace.icon` |  |
| Delete Workspace | `workspace.remove` |  |

### Locking and note settings

| Command | Id | Default |
| --- | --- | --- |
| Restart Note Shell | `session.restart` |  |
| Edit Note Profile… | `profile.open` |  |
| Edit Frontmatter | `frontmatter.edit` | `Alt-Mod-,` |
| Lock Notes | `vault.lock` | `Mod-l` |
| Unlock Notes… | `vault.unlock` |  |
| Lock This Note… | `note.lockOn` |  |
| Remove Lock… | `note.lockOff` |  |
| Change Vault Passphrase… | `vault.changePassphrase` |  |

### Window and app

| Command | Id | Default |
| --- | --- | --- |
| Documentation | `docs.toggle` |  |
| Third-Party Licenses | `docs.licenses` |  |
| Toggle Sidebar | `sidebar.toggle` | `Alt-Mod-b` |
| Toggle Backlinks | `backlinks.toggle` | `Alt-Mod-l` |
| Toggle Outline | `outline.toggle` | `Alt-Mod-o` |
| Toggle Tags | `tags.toggle` | `Alt-Mod-t` |
| Toggle Terminal | `terminal.toggle` | `` Ctrl-` `` |
| Close Terminal | `terminal.close` |  |
| Settings… | `settings.open` | `Mod-,` |
| Notes On… | `connection.switch` |  |
| Reconnect | `connection.reconnect` |  |
| New Window | `window.new` |  |
| Install Shell Command (ledge) | `cli.install` |  |
| Reveal Log in Finder (File Manager off macOS) | `log.reveal` |  |
| Check for Updates… | `update.check` |  |
| Restart to Install Update | `update.install` |  |
| Quit Ledge | `app.quit` | `Mod-q` |
| About Ledge | `app.about` |  |

### Sidebar and panel rows

These act on the focused row of a list, where each already has a single key. A chord given to one works while a row of its kind has focus.

| Command | Id | Default |
| --- | --- | --- |
| Switch to Workspace | `workspace.open` |  |
| Restore | `workspace.restore` |  |
| Delete Permanently… | `workspace.purge` |  |
| Open | `note.open` |  |
| Open | `backlink.open` |  |
| Jump to Heading | `outline.jump` |  |
| Copy Link | `outline.copyLink` |  |
| Show Notes | `tag.open` |  |
| Open | `tag.openNote` |  |
| Delete | `note.delete` |  |
| Copy Path | `note.copyPath` |  |
| New Note in Folder | `note.newInFolder` |  |
| Expand | `folder.toggle` |  |
| Search in Folder | `folder.search` |  |
| Rename Folder… | `folder.rename` |  |
| Delete Folder… | `folder.delete` |  |
| Restore | `note.restore` |  |
| Delete Permanently… | `trash.delete` |  |
