import UIKit

/// One window, and the two screens that can be in it.
///
/// The app's whole state is the connection, and that belongs to WebHost. This
/// exists to own a window, to choose between pairing and the app, and to
/// forward the two lifecycle moments that mean something to a client whose
/// socket the operating system will kill (ios.md §5): going to the background,
/// and coming back.
@objc(AppDelegate)
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var host: WebHost?
    /// The shell's own screens — the server list and the pairing form — when
    /// they are what the window is showing. A navigation controller because
    /// adding a server is a step off the list, and a step off wants a way back:
    /// the form pushed onto it is the same form that is the ROOT on a phone
    /// with no servers at all, where there is nothing to go back to.
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
    /// web view down and choosing again builds a new one. That is deliberate:
    /// the page holds a connection and half its state comes from a server, and
    /// there is no useful meaning for "the same page, pointed somewhere else".
    private func show() {
        let config = ShellConfig.current()
        guard let server = config.server else { return showServers(because: nil) }
        let screen = WebHost(
            config: config,
            server: server,
            onRepair: { [weak self] why in self?.repair(why) },
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

    /// The server list, and the pairing form when the list has nothing in it.
    ///
    /// Asked for by name rather than reached by re-reading the configuration,
    /// because `repair` below has to END somewhere: a stored record that
    /// survives being forgotten would otherwise build another web view, which
    /// would fail the same way, and ask for repair again.
    ///
    /// A phone with no servers roots the stack at the form, so a first launch
    /// is one screen and has no Back button pointing at an empty list. Every
    /// other case roots it at the list, which is the screen that can get a
    /// phone out of a saved server that stopped answering.
    private func showServers(because: String?, pairing pairFirst: Bool = false) {
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
                // No reason carried across: whatever sent us to the list is
                // about a server that is already there, and repeating it over
                // the form for a different one would be a refusal of something
                // nobody has tried yet.
                self.chooser?.pushViewController(
                    self.pairingScreen(suggest: suggest, port: port, because: nil),
                    animated: true
                )
            }
        )
        // Nothing selected falls back to what the launch suggested, which is how
        // a probe points a build at a scratch server.
        let selected = stored.servers.first(where: { $0.id == stored.selected })
        let form = {
            self.pairingScreen(
                suggest: selected?.destination ?? ShellConfig.suggestion,
                port: selected?.port ?? 0,
                because: because
            )
        }
        let nav = UINavigationController(rootViewController: stored.servers.isEmpty ? form() : list)
        nav.navigationBar.prefersLargeTitles = true
        if !stored.servers.isEmpty, pairFirst { nav.pushViewController(form(), animated: false) }
        host = nil
        chooser = nav
        window?.rootViewController = nav
    }

    /// The pairing form, pre-filled. A pin dropped by `repair` comes back to a
    /// screen that already knows the address: the key is the thing to look at
    /// again, not the machine.
    private func pairingScreen(suggest: String, port: Int, because: String?) -> PairingViewController {
        PairingViewController(
            client: ShellConfig.current().client,
            suggest: suggest,
            suggestPort: port,
            because: because
        ) { [weak self] _ in
            self?.show()
        }
    }

    /// A failure retrying cannot fix. The pin is dropped and the destination
    /// kept: the address is still the one the user meant, and the key is the
    /// thing to look at again, so this lands on the form rather than the list.
    private func repair(_ why: String) {
        // The page's ladder keeps dialing while this decision is being made, so
        // every attempt would otherwise ask for the same screen.
        guard chooser == nil else { return }
        ServerStore.forgetPin()
        showServers(because: why, pairing: true)
    }

    // iOS suspends an app shortly after it leaves the foreground, and a
    // suspended app's socket dies (ios.md §5). No timer runs while suspended,
    // so the page's reconnect ladder cannot be what notices: the client dials
    // on the foreground notification instead, and foregrounding is a boot.
    //
    // Both edges are reported and the page decides. Closing the socket on the
    // way out is deliberate: a half-open one that the OS killed while we were
    // away looks identical to a live one until the first write fails.
    func applicationDidEnterBackground(_ application: UIApplication) {
        host?.willSuspend()
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        host?.didResume()
    }
}
