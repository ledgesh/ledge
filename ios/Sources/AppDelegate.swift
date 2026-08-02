import UIKit

/// One window, one web view, no storyboard.
///
/// The app's whole state is the connection, and that belongs to WebHost. This
/// exists to own a window and to forward the two lifecycle moments that mean
/// something to a client whose socket the operating system will kill
/// (ios.md §5): going to the background, and coming back.
@objc(AppDelegate)
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var host: WebHost?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let host = WebHost(config: ShellConfig.current())
        self.host = host
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window
        return true
    }

    // iOS suspends an app shortly after it leaves the foreground, and a
    // suspended app's socket dies (ios.md §5). No timer runs while suspended,
    // so the page's reconnect ladder cannot be what notices: the client dials
    // on the foreground notification instead, and foregrounding is a boot.
    //
    // Phase 3 reports both edges and lets the page decide. Closing the socket
    // on the way out is deliberate: a half-open one that the OS killed while
    // we were away looks identical to a live one until the first write fails.
    func applicationDidEnterBackground(_ application: UIApplication) {
        host?.willSuspend()
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        host?.didResume()
    }
}
