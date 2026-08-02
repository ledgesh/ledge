import Foundation

/// Who this client is and which server it is pointed at.
///
/// Both are `@hello`'s answer (mainview/lib/nativeBridge.ts), asked once before
/// any socket exists.
struct ShellConfig {
    let host: String
    let port: UInt16
    /// This install's id, stable across launches (remote.md §5): it keys the
    /// layout on the server, which is what stops a phone restoring a desktop's
    /// three-pane tree onto a 390-point screen.
    let client: String

    var destination: String { "\(host):\(port)" }

    private static let clientKey = "LedgeClientId"
    private static let serverKey = "LedgeServer"

    /// The fixture's address, in `host:port`, from — in order — a launch
    /// argument, the Info.plist, or loopback.
    ///
    /// The launch argument is what `simctl launch <device> <bundle>
    /// -LedgeServer 127.0.0.1:8787` sets: UserDefaults reads `-key value` pairs
    /// off the command line for free, which is the whole reason the probe can
    /// point a build at a scratch server without rebuilding it.
    ///
    /// Loopback is the default because the Simulator shares this Mac's network
    /// stack. A real device needs the Mac's LAN address here and
    /// `bun run lan -- --lan` at the other end.
    static func current() -> ShellConfig {
        let raw =
            UserDefaults.standard.string(forKey: serverKey)
            ?? (Bundle.main.object(forInfoDictionaryKey: serverKey) as? String)
            ?? "127.0.0.1:8787"
        let (host, port) = split(raw)

        let defaults = UserDefaults.standard
        // Minted once and kept. Deleting the app destroys it along with
        // everything else in the container, which is correct and is the same
        // fact ios.md §4 records about the ssh key: a reinstall is a new
        // client, and the layout it finds on the server is nobody's.
        let client = defaults.string(forKey: clientKey) ?? UUID().uuidString
        defaults.set(client, forKey: clientKey)

        return ShellConfig(host: host, port: port, client: client)
    }

    /// `host:port`, with an IPv6 literal in brackets. A bare host keeps the
    /// default port rather than failing: the address is a developer's typing,
    /// and the useful failure is the connection's, which names what it tried.
    static func split(_ raw: String) -> (String, UInt16) {
        let text = raw.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("["), let close = text.firstIndex(of: "]") {
            let host = String(text[text.index(after: text.startIndex)..<close])
            let rest = text[text.index(after: close)...]
            return (host, rest.hasPrefix(":") ? UInt16(rest.dropFirst()) ?? 8787 : 8787)
        }
        guard let colon = text.lastIndex(of: ":") else { return (text, 8787) }
        let host = String(text[text.startIndex..<colon])
        let port = UInt16(text[text.index(after: colon)...]) ?? 8787
        return (host.isEmpty ? "127.0.0.1" : host, port)
    }
}
