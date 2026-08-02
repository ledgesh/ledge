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
    private var pairing: PairingViewController?

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

    /// Pairing until there is a server, then the app.
    ///
    /// The two screens are swapped rather than stacked, so re-pairing tears the
    /// web view down and pairing again builds a new one. That is deliberate:
    /// the page holds a connection and half its state comes from a server, and
    /// there is no useful meaning for "the same page, pointed somewhere else".
    private func show() {
        let config = ShellConfig.current()
        guard let server = config.server else { return showPairing(because: nil) }
        let screen = WebHost(config: config, server: server) { [weak self] why in
            self?.repair(why)
        }
        pairing = nil
        host = screen
        window?.rootViewController = screen
    }

    /// Pairing, unconditionally.
    ///
    /// Asked for by name rather than reached by re-reading the configuration,
    /// because `repair` below has to END somewhere: a stored record that
    /// survives being forgotten would otherwise build another web view, which
    /// would fail the same way, and ask for repair again.
    private func showPairing(because: String?) {
        let screen = PairingViewController(client: ShellConfig.current().client, because: because) { [weak self] _ in
            self?.show()
        }
        host = nil
        pairing = screen
        window?.rootViewController = screen
    }

    /// A failure retrying cannot fix. The pin is dropped and the destination
    /// kept: the address is still the one the user meant, and the key is the
    /// thing to look at again.
    private func repair(_ why: String) {
        // The page's ladder keeps dialing while this decision is being made, so
        // every attempt would otherwise ask for the same screen.
        guard pairing == nil else { return }
        ShellConfig.forgetPin()
        showPairing(because: why)
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
