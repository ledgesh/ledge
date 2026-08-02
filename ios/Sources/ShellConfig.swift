import Foundation

/// The server this phone is paired with.
///
/// This is the client-side configuration remote.md §8 describes, for a client
/// that holds exactly one: an ssh destination and the host key pinned when it
/// was added. Nothing about it is stored on a server, and the private half of
/// the key it authenticates with is not stored here either — it is in the
/// enclave (`DeviceKey`).
struct ServerRecord {
    /// `user@host`. An ssh destination and nothing more: no port, because an
    /// ssh destination has none, and no options, because there is no argv here
    /// for one to be injected into.
    let destination: String
    /// `ssh-ed25519 AAAA…`, pinned at pairing. The bytes, not a fingerprint:
    /// the comparison is on these and the fingerprint is for a human to read.
    let hostKey: String

    var user: String { String(destination.prefix(while: { $0 != "@" })) }
    var host: String { String(destination.drop(while: { $0 != "@" }).dropFirst()) }

    /// What a user typed, refused with a reason or accepted.
    ///
    /// The Mac's `validateConnection` allows a bare host and lets ssh supply
    /// the local username. A phone has no local username worth offering, so the
    /// account is required here, and saying so at pairing is better than the
    /// "Permission denied (publickey)" it would otherwise become — which is
    /// also what a missing `authorized_keys` line looks like.
    static func problem(with destination: String) -> String? {
        let text = destination.trimmingCharacters(in: .whitespaces)
        if text.isEmpty { return "Enter the server, as user@host." }
        if text.contains(where: { $0.isWhitespace }) { return "An ssh destination has no spaces in it." }
        let parts = text.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else {
            return "Write it as user@host: Ledge signs in as an account on that machine."
        }
        if text.hasPrefix("-") { return "An ssh destination cannot start with a dash." }
        if text.contains(":") { return "Leave the port out: Ledge connects on 22, like ssh." }
        return nil
    }
}

/// Who this client is, and what it is pointed at.
///
/// `client` is `@hello`'s other half (mainview/lib/nativeBridge.ts), asked once
/// before any connection exists.
struct ShellConfig {
    /// This install's id, stable across launches (remote.md §5): it keys the
    /// layout on the server, which is what stops a phone restoring a desktop's
    /// three-pane tree onto a 390-point screen.
    let client: String
    /// Nil until this phone has been paired.
    let server: ServerRecord?

    private static let clientKey = "LedgeClientId"
    private static let destinationKey = "LedgeServer"
    private static let hostKeyKey = "LedgeHostKey"

    static func current() -> ShellConfig {
        let defaults = UserDefaults.standard
        // Minted once and kept. Deleting the app destroys it along with
        // everything else in the container, which is correct and is the same
        // fact ios.md §4 records about the ssh key: a reinstall is a new
        // client, and the layout it finds on the server is nobody's.
        let client = defaults.string(forKey: clientKey) ?? UUID().uuidString
        defaults.set(client, forKey: clientKey)

        // Both halves or neither. A destination with no pin is an unpinned
        // connection, which is the one thing remote.md §4 does not allow, and
        // the recovery is to pair again rather than to trust whatever answers.
        let destination = defaults.string(forKey: destinationKey) ?? ""
        let hostKey = defaults.string(forKey: hostKeyKey) ?? ""
        let paired = !destination.isEmpty && !hostKey.isEmpty
        return ShellConfig(
            client: client,
            server: paired ? ServerRecord(destination: destination, hostKey: hostKey) : nil
        )
    }

    /// The destination the pairing screen starts with.
    ///
    /// `simctl launch <device> <bundle> -LedgeServer ledge@127.0.0.1` sets it:
    /// UserDefaults reads `-key value` pairs off the command line for free,
    /// which is how a probe points a build at a scratch server without
    /// rebuilding it. It is a suggestion and never a pin — the host key still
    /// has to be confirmed by whoever is holding the phone.
    static var suggestion: String {
        UserDefaults.standard.string(forKey: destinationKey)
            ?? (Bundle.main.object(forInfoDictionaryKey: destinationKey) as? String)
            ?? ""
    }

    static func remember(_ server: ServerRecord) {
        UserDefaults.standard.set(server.destination, forKey: destinationKey)
        UserDefaults.standard.set(server.hostKey, forKey: hostKeyKey)
    }

    /// Forget the pin but keep the destination as the suggestion: the case this
    /// exists for is a host key that changed, where the address is still the
    /// one the user meant and the key is the thing to look at again.
    static func forgetPin() {
        UserDefaults.standard.removeObject(forKey: hostKeyKey)
    }
}
