import AppKit
import SwiftUI

/// The AppKit shell. The window, the split between sidebar and content, and the
/// first responder chain are AppKit's; the leaf views inside are SwiftUI.
@MainActor
public final class MainWindowController: NSWindowController {
    private let model: AppModel

    public init(model: AppModel) {
        self.model = model

        let split = NSSplitViewController()

        let sidebar = NSHostingController(rootView: SidebarView(model: model))
        let sidebarItem = NSSplitViewItem(sidebarWithViewController: sidebar)
        sidebarItem.minimumThickness = 180
        sidebarItem.maximumThickness = 340
        sidebarItem.canCollapse = true
        split.addSplitViewItem(sidebarItem)

        let content = NSHostingController(rootView: WorkspaceContentView(model: model))
        let contentItem = NSSplitViewItem(viewController: content)
        contentItem.minimumThickness = 400
        split.addSplitViewItem(contentItem)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Ledge"
        window.titlebarAppearsTransparent = false
        window.minSize = NSSize(width: 800, height: 500)

        // Assigning a contentViewController resizes the window to that view's
        // fitting size, which discards the contentRect above. So set the size
        // after, not before.
        window.contentViewController = split
        window.setContentSize(NSSize(width: 1200, height: 760))
        window.center()

        // Reuse the last size and position if we have one, then keep saving it.
        window.setFrameUsingName("LedgeMainWindow")
        window.setFrameAutosaveName("LedgeMainWindow")

        super.init(window: window)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }
}
