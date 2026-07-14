import AppKit
import Bonsplit

@MainActor
public final class AppDelegate: NSObject, NSApplicationDelegate {
    private let model = AppModel()
    private var windowController: MainWindowController?

    public func applicationDidFinishLaunching(_: Notification) {
        NSApp.mainMenu = buildMenu()

        let controller = MainWindowController(model: model)
        controller.showWindow(nil)
        windowController = controller

        NSApp.activate(ignoringOtherApps: true)
    }

    public func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool {
        true
    }

    // MARK: - Commands

    @objc private func newWorkspace(_: Any?) { model.newWorkspace() }
    @objc private func closeWorkspace(_: Any?) { model.closeWorkspace(model.selectedID) }
    @objc private func newTab(_: Any?) { model.newTab() }
    @objc private func closeTab(_: Any?) { model.closeTab() }
    @objc private func splitRight(_: Any?) { model.split(.horizontal) }
    @objc private func splitDown(_: Any?) { model.split(.vertical) }
    @objc private func closePane(_: Any?) { model.closePane() }
    @objc private func toggleZoom(_: Any?) { model.toggleZoom() }
    @objc private func nextTab(_: Any?) { model.selectTab(offsetBy: 1) }
    @objc private func previousTab(_: Any?) { model.selectTab(offsetBy: -1) }
    @objc private func focusLeft(_: Any?) { model.navigateFocus(.left) }
    @objc private func focusRight(_: Any?) { model.navigateFocus(.right) }
    @objc private func focusUp(_: Any?) { model.navigateFocus(.up) }
    @objc private func focusDown(_: Any?) { model.navigateFocus(.down) }
    @objc private func nextWorkspace(_: Any?) { model.selectWorkspace(offsetBy: 1) }
    @objc private func previousWorkspace(_: Any?) { model.selectWorkspace(offsetBy: -1) }

    @objc private func selectWorkspaceByNumber(_ sender: NSMenuItem) {
        model.selectWorkspace(at: sender.tag)
    }

    // MARK: - Menu

    private func buildMenu() -> NSMenu {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let app = NSMenu()
        app.addItem(withTitle: "About Ledge", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Ledge", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit Ledge", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app
        main.addItem(appItem)

        let fileItem = NSMenuItem()
        let file = NSMenu(title: "File")
        add(to: file, "New Tab", #selector(newTab(_:)), "t")
        add(to: file, "New Workspace", #selector(newWorkspace(_:)), "n", [.command, .shift])
        file.addItem(.separator())
        add(to: file, "Close Tab", #selector(closeTab(_:)), "w")
        add(to: file, "Close Workspace", #selector(closeWorkspace(_:)), "w", [.command, .shift])
        fileItem.submenu = file
        main.addItem(fileItem)

        // Standard editing selectors, sent down the responder chain to whatever
        // text view is first responder. Without this, the placeholder editor has
        // no copy, paste, or undo.
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        add(to: edit, "Undo", Selector(("undo:")), "z")
        add(to: edit, "Redo", Selector(("redo:")), "z", [.command, .shift])
        edit.addItem(.separator())
        add(to: edit, "Cut", #selector(NSText.cut(_:)), "x")
        add(to: edit, "Copy", #selector(NSText.copy(_:)), "c")
        add(to: edit, "Paste", #selector(NSText.paste(_:)), "v")
        add(to: edit, "Select All", #selector(NSText.selectAll(_:)), "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        add(to: view, "Toggle Sidebar", #selector(NSSplitViewController.toggleSidebar(_:)), "s", [.command, .control])
        view.addItem(.separator())
        add(to: view, "Split Right", #selector(splitRight(_:)), "d")
        add(to: view, "Split Down", #selector(splitDown(_:)), "d", [.command, .shift])
        add(to: view, "Close Pane", #selector(closePane(_:)), "w", [.command, .option])
        add(to: view, "Zoom Pane", #selector(toggleZoom(_:)), "\r")
        view.addItem(.separator())
        add(to: view, "Focus Pane Left", #selector(focusLeft(_:)), "\u{F702}", [.command, .option])
        add(to: view, "Focus Pane Right", #selector(focusRight(_:)), "\u{F703}", [.command, .option])
        add(to: view, "Focus Pane Up", #selector(focusUp(_:)), "\u{F700}", [.command, .option])
        add(to: view, "Focus Pane Down", #selector(focusDown(_:)), "\u{F701}", [.command, .option])
        view.addItem(.separator())
        add(to: view, "Next Tab", #selector(nextTab(_:)), "]", [.command, .shift])
        add(to: view, "Previous Tab", #selector(previousTab(_:)), "[", [.command, .shift])
        add(to: view, "Next Workspace", #selector(nextWorkspace(_:)), "\u{F701}", [.command, .control])
        add(to: view, "Previous Workspace", #selector(previousWorkspace(_:)), "\u{F700}", [.command, .control])
        view.addItem(.separator())
        for i in 1 ... 9 {
            let item = add(to: view, "Workspace \(i)", #selector(selectWorkspaceByNumber(_:)), "\(i)")
            item.tag = i - 1
            item.isHidden = true
        }
        viewItem.submenu = view
        main.addItem(viewItem)

        return main
    }

    @discardableResult
    private func add(
        to menu: NSMenu,
        _ title: String,
        _ action: Selector,
        _ key: String,
        _ modifiers: NSEvent.ModifierFlags = [.command]
    ) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        // Nil target means the selector walks the responder chain, which is what
        // the standard editing selectors need. Ours are found on the delegate,
        // which sits at the end of that chain.
        menu.addItem(item)
        return item
    }
}
