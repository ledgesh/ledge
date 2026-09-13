import UIKit

/// One window, and the two screens that can be in it.
///
/// The app's whole state is the connection, and that belongs to WebHost. This
/// exists to own a window, to choose between pairing and the app, and to
/// forward the two lifecycle moments that mean something to a client the
/// operating system stops running (ios.md §5): going to the background, and
/// coming back.
@objc(AppDelegate)
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var host: WebHost?
    /// The shell's own screens, when they are what the window is showing: the
    /// welcome screen or the server list at the root, and the pairing form as a
    /// step off either of them.
    private var chooser: UINavigationController?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        self.window = window
        show()
        window.makeKeyAndVisible()
        return true
    }

    /// The shell's screens until there is a server to dial, then the app.
    ///
    /// The two are swapped rather than stacked, so choosing a server tears the
    /// web view down and choosing again builds a new one. The page holds a
    /// connection and half its state comes from a server, so there is no useful
    /// meaning for "the same page, pointed somewhere else".
    private func show() {
        let config = ShellConfig.current()
        guard let server = config.server else { return showServers(because: nil) }
        let screen = WebHost(
            config: config,
            server: server,
            onRepair: { [weak self] refused, why in self?.repair(refused, why) },
            // Either the page removed the last server, or the person holding
            // the phone asked for this list from a page that could not reach
            // anything (mainview/ios.tsx). A phone has no local server to fall
            // back to the way a Mac does (remote.md §8), so the screens before
            // any of this are the answer to both.
            onServers: { [weak self] why in self?.showServers(because: why.isEmpty ? nil : why) }
        )
        chooser = nil
        host = screen
        window?.rootViewController = screen
    }

    /// The server list, or the welcome screen when the list has nothing in it.
    ///
    /// Asked for by name rather than reached by re-reading the configuration,
    /// because `repair` below has to terminate: a stored record that survives
    /// being forgotten would otherwise build another web view, which would fail
    /// the same way and ask for repair again.
    ///
    /// `pairing` pushes the form pre-filled with the record `repair` was handed.
    /// Over the welcome screen, a reason or a launch suggestion pushes it too,
    /// since both are about an address the form can show (testing.md §6).
    private func showServers(because: String?, pairing refused: ServerRecord? = nil) {
        ServerStore.setLaunchAside()
        let stored = ServerStore.load()
        let list = ServerListViewController(
            servers: stored.servers,
            selected: stored.selected,
            because: because,
            // Storing the selection is all this takes: `show` re-reads the
            // configuration, so choosing the record already selected rebuilds
            // the app around it, which is how this screen retries.
            onChosen: { [weak self] id in
                ServerStore.select(id)
                self?.show()
            },
            onAdd: { [weak self] suggest, port in
                guard let self else { return }
                // No reason carried across: whatever sent the app to the list
                // is about a server that is already there, and repeating it
                // over the form for a different one would be a refusal of
                // something nobody has tried yet.
                self.chooser?.pushViewController(
                    self.pairingScreen(suggest: suggest, port: port, because: nil),
                    animated: true
                )
            }
        )
        // Nothing selected falls back to what the launch suggested, which is how
        // a probe points a build at a scratch server.
        let selected = refused ?? stored.servers.first(where: { $0.id == stored.selected })
        let form = {
            self.pairingScreen(
                suggest: selected?.destination ?? ShellConfig.suggestion,
                port: selected?.port ?? ShellConfig.suggestedPort,
                because: because
            )
        }
        let root: UIViewController
        let formOnTop: Bool
        if stored.servers.isEmpty {
            root = WelcomeViewController(
                client: ShellConfig.current().client,
                onScan: { [weak self] in self?.scan() },
                // No scan button on this form: the person chose it instead of one.
                onAddress: { [weak self] in
                    guard let self else { return }
                    self.chooser?.pushViewController(
                        self.pairingScreen(suggest: "", port: 0, because: nil, scannable: false),
                        animated: true
                    )
                }
            )
            formOnTop = refused != nil || because != nil || !ShellConfig.suggestion.isEmpty
        } else {
            root = list
            formOnTop = refused != nil
        }
        let nav = UINavigationController(rootViewController: root)
        nav.navigationBar.prefersLargeTitles = true
        if formOnTop { nav.pushViewController(form(), animated: false) }
        host = nil
        chooser = nav
        window?.rootViewController = nav
    }

    /// The pairing form, pre-filled. A pin dropped by `repair` comes back to a
    /// screen that already knows the address: the key is the thing to look at
    /// again, not the machine.
    private func pairingScreen(
        suggest: String,
        port: Int,
        because: String?,
        scannable: Bool = true
    ) -> PairingViewController {
        PairingViewController(
            client: ShellConfig.current().client,
            start: .typed(suggest: suggest, port: port),
            because: because,
            onScan: scannable ? { [weak self] in self?.scan() } : nil
        ) { [weak self] _ in
            self?.show()
        }
    }

    /// The camera, over the shell's screens. A code it reads opens that code's
    /// pairing screen on top of the form the scan started from.
    private func scan() {
        guard let nav = chooser else { return }
        CodeScannerViewController.open(over: nav) { [weak self] code in
            nav.dismiss(animated: true) { self?.openCode(code, tapped: false) }
        }
    }

    /// A `ledge://pair#…` link. Universal links on ledge.sh arrive the same way
    /// once the site and the Associated Domains entitlement exist (ios.md §12).
    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        switch PairingCode.read(url.absoluteString) {
        case .code(let code):
            openCode(code, tapped: true)
        case .problem(let problem):
            let alert = UIAlertController(title: "Ledge cannot open this link", message: problem, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .cancel))
            topmost()?.present(alert, animated: true)
        }
        return true
    }

    /// A pairing code's screen, which dials only when the person holding the
    /// phone presses Connect (remote.md §4b). Over the app when the app is what
    /// the window shows, so the connection it has stays up until a pairing
    /// replaces it.
    private func openCode(_ code: PairingCode, tapped: Bool) {
        let screen = PairingViewController(
            client: ShellConfig.current().client,
            start: .code(code, tapped: tapped),
            because: nil
        ) { [weak self] _ in
            // The launch arguments would otherwise shadow the record just paired.
            ServerStore.setLaunchAside()
            self?.window?.rootViewController?.dismiss(animated: false)
            self?.show()
        }
        if let chooser { return chooser.pushViewController(screen, animated: true) }
        let sheet = UINavigationController(rootViewController: screen)
        screen.navigationItem.leftBarButtonItem = UIBarButtonItem(
            systemItem: .cancel,
            primaryAction: UIAction { [weak sheet] _ in sheet?.dismiss(animated: true) }
        )
        topmost()?.present(sheet, animated: true)
    }

    /// The view controller a new alert or sheet can be presented from.
    private func topmost() -> UIViewController? {
        var top = window?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }

    /// A failure retrying cannot fix. The refused record's pin is dropped and
    /// its destination kept: the address is still the one the user meant, and
    /// the key is the thing to look at again, so this lands on the form rather
    /// than the list. A launch-argument record has no stored pin to drop.
    private func repair(_ refused: ServerRecord, _ why: String) {
        // The page's ladder keeps dialing while this decision is being made, so
        // every attempt would otherwise ask for the same screen.
        guard chooser == nil else { return }
        ServerStore.forgetPin(of: refused.id)
        showServers(because: why, pairing: refused)
    }

    // iOS suspends an app shortly after it leaves the foreground, and no timer
    // runs while it is suspended (ios.md §5). So the page's reconnect ladder
    // cannot be what notices a wire that died while the app was away: these
    // two notifications are, and the page probes on the second one.
    //
    // Both edges are reported and the page decides. Neither of them closes the
    // socket: a short app switch usually comes back to a wire that still
    // works, and `WebHost.willSuspend` has why.
    func applicationDidEnterBackground(_ application: UIApplication) {
        host?.willSuspend()
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        host?.didResume()
    }
}
