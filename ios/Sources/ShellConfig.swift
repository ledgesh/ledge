import Foundation
// For `UIDevice`, which is the only thing here that is not Foundation's: the
// device's name for itself is UIKit's to answer.
import UIKit

/// One server this phone can reach.
///
/// This is the client-side configuration remote.md §8 describes: an ssh
/// destination and the host key pinned when it was added. Nothing about it is
/// stored on a server, and the private half of the key it authenticates with is
/// not stored here either — it is in the enclave (`DeviceKey`).
///
/// `id` and `name` are what a list needs and a single record did not: the id
/// survives renaming and re-addressing, and the name is what the connection
/// chrome shows. Both default to empty so that a candidate — a destination
/// someone is still typing, dialled to ask for its fingerprint — can be made
/// without inventing either.
struct ServerRecord: Codable, Equatable {
    var id: String = ""
    var name: String = ""
    /// `user@host`. An ssh destination and nothing more: no port, because an
    /// ssh destination has none, and no options, because there is no argv here
    /// for one to be injected into.
    var destination: String
    /// `ssh-ed25519 AAAA…`, pinned at pairing. The bytes, not a fingerprint:
    /// the comparison is on these and the fingerprint is for a human to read.
    /// Empty for a record whose pin was dropped because the server offered a
    /// different key, which is a record that needs pairing again rather than
    /// one that can be dialled.
    var hostKey: String

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

    // Machine-written state self-heals (architecture.md §6): a field this app
    // wrote in an older shape costs its own default, never the whole list and
    // never the launch. `ServerStore` drops what is left unusable.
    init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        id = try fields.decodeIfPresent(String.self, forKey: .id) ?? ""
        name = try fields.decodeIfPresent(String.self, forKey: .name) ?? ""
        destination = try fields.decodeIfPresent(String.self, forKey: .destination) ?? ""
        hostKey = try fields.decodeIfPresent(String.self, forKey: .hostKey) ?? ""
    }

    init(id: String = "", name: String = "", destination: String, hostKey: String) {
        self.id = id
        self.name = name
        self.destination = destination
        self.hostKey = hostKey
    }
}

/// Every server this phone knows, and which one it is pointed at.
///
/// A list rather than the single record this held before, because a phone is a
/// client like any other and remote.md §8's configuration is a list everywhere
/// else. It lives in `UserDefaults` as one JSON string: the alternative is a
/// key per field per server, which is a schema nobody can read and a migration
/// nobody can write.
///
/// The page owns the shape and this owns the bytes, which is the same split
/// `.layout.json` has on a Mac (architecture.md §6). Swift reads exactly two
/// things out of a record — a destination to dial and a key to pin — and every
/// rule about what may be added, renamed or removed is in the webview
/// (mainview/lib/nativeBridge.ts), beside the Mac's.
enum ServerStore {
    private static let listKey = "LedgeServers"
    // The two keys the single-server build wrote. Read once, to migrate, and
    // then only ever as a launch suggestion (`ShellConfig.suggestion`).
    private static let destinationKey = "LedgeServer"
    private static let hostKeyKey = "LedgeHostKey"

    struct Stored: Codable {
        var version: Int
        var selected: String
        var servers: [ServerRecord]
    }

    /// The list, self-healed: a record with no id or no destination is not a
    /// server, and a selection naming nothing falls back to the first one
    /// there is.
    static func load() -> Stored {
        let raw = UserDefaults.standard.string(forKey: listKey) ?? ""
        var stored = decode(raw) ?? migrated()
        var seen = Set<String>()
        stored.servers = stored.servers.filter { record in
            guard !record.id.isEmpty, !record.destination.isEmpty, ServerRecord.problem(with: record.destination) == nil
            else { return false }
            return seen.insert(record.id).inserted
        }
        if !stored.servers.contains(where: { $0.id == stored.selected }) {
            stored.selected = stored.servers.first?.id ?? ""
        }
        return stored
    }

    /// The selected record, if it is one this app can dial. A record with no
    /// pin is not: connecting to it would mean trusting whatever answers, which
    /// is the one thing remote.md §4 does not allow.
    static func selected() -> ServerRecord? {
        if let launched = launched() { return launched }
        let stored = load()
        guard let record = stored.servers.first(where: { $0.id == stored.selected }), !record.hostKey.isEmpty else {
            return nil
        }
        return record
    }

    /// A pairing that came from the launch arguments, for one launch.
    ///
    /// `-LedgeServer ledge@127.0.0.1 -LedgeHostKey "ssh-ed25519 AAAA…"` is how
    /// testing.md §6 points a Simulator at a scratch server without a human
    /// tapping Trust. Both halves are read from the ARGUMENT domain and BOTH
    /// are required, which is what makes it safe: an address and a pin that
    /// named each other on one command line cannot be mismatched, and that
    /// mismatch is the whole reason `migrated()` below reads the persistent
    /// domain instead. Nothing is written, so this vanishes at the next launch
    /// and shadows what is stored rather than replacing it.
    ///
    /// It is not a back door. Nothing on a device can set an argument domain,
    /// and the pin here is compared on every connection like any other.
    private static func launched() -> ServerRecord? {
        let argv = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
        guard let destination = argv[destinationKey] as? String,
            let hostKey = argv[hostKeyKey] as? String,
            !hostKey.isEmpty,
            ServerRecord.problem(with: destination) == nil
        else { return nil }
        let host = String(destination.drop(while: { $0 != "@" }).dropFirst())
        return ServerRecord(id: "launch-argument", name: host, destination: destination, hostKey: hostKey)
    }

    static func save(servers: [ServerRecord], selected: String) {
        let stored = Stored(version: 1, selected: selected, servers: servers)
        guard let data = try? JSONEncoder().encode(stored), let text = String(data: data, encoding: .utf8) else { return }
        UserDefaults.standard.set(text, forKey: listKey)
    }

    /// Add a freshly pinned server, or re-pin the one already at that address.
    ///
    /// By destination and not by id, because the pairing screen has no id to
    /// carry: it is reached on a first launch, and again when a host key
    /// changed under a record that still exists. Matching on the address keeps
    /// that record's name and id rather than leaving a duplicate beside it.
    @discardableResult
    static func pair(destination: String, hostKey: String) -> ServerRecord {
        var stored = load()
        if let at = stored.servers.firstIndex(where: { $0.destination == destination }) {
            stored.servers[at].hostKey = hostKey
            stored.selected = stored.servers[at].id
            save(servers: stored.servers, selected: stored.selected)
            return stored.servers[at]
        }
        // Named after the machine, because pairing asks one question and a
        // second field for a label it can guess would be a second question. It
        // is editable from the connection list afterwards.
        let host = String(destination.drop(while: { $0 != "@" }).dropFirst())
        let record = ServerRecord(
            id: UUID().uuidString,
            name: host.isEmpty ? destination : host,
            destination: destination,
            hostKey: hostKey
        )
        stored.servers.append(record)
        save(servers: stored.servers, selected: record.id)
        return record
    }

    /// Forget the selected record's pin but keep the record: the case this
    /// exists for is a host key that changed, where the address is still the
    /// one the user meant and the key is the thing to look at again.
    static func forgetPin() {
        var stored = load()
        guard let at = stored.servers.firstIndex(where: { $0.id == stored.selected }) else { return }
        stored.servers[at].hostKey = ""
        save(servers: stored.servers, selected: stored.selected)
    }

    private static func decode(_ text: String) -> Stored? {
        guard !text.isEmpty, let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(Stored.self, from: data)
    }

    /// The single-server build's two keys, as a one-record list.
    ///
    /// Written back on the first `save`, and the old keys are cleared here so
    /// that `LedgeServer` means only what a launch argument put there
    /// afterwards. An install with nothing stored lands on the same empty list,
    /// which is the pairing screen.
    private static func migrated() -> Stored {
        let defaults = UserDefaults.standard
        // The persistent domain and not `string(forKey:)`, because a probe
        // launches with `-LedgeServer ledge@127.0.0.1` and the argument domain
        // wins over the stored value: migrating what a launch argument said
        // would pair a previously stored HOST KEY to a different address.
        let persistent = defaults.persistentDomain(forName: Bundle.main.bundleIdentifier ?? "") ?? [:]
        let destination = persistent[destinationKey] as? String ?? ""
        let hostKey = persistent[hostKeyKey] as? String ?? ""
        guard !destination.isEmpty, !hostKey.isEmpty else { return Stored(version: 1, selected: "", servers: []) }
        let host = String(destination.drop(while: { $0 != "@" }).dropFirst())
        let record = ServerRecord(
            id: UUID().uuidString,
            name: host.isEmpty ? destination : host,
            destination: destination,
            hostKey: hostKey
        )
        save(servers: [record], selected: record.id)
        defaults.removeObject(forKey: destinationKey)
        defaults.removeObject(forKey: hostKeyKey)
        return Stored(version: 1, selected: record.id, servers: [record])
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
    /// Nil until this phone has a server it can dial.
    let server: ServerRecord?

    private static let clientKey = "LedgeClientId"

    static func current() -> ShellConfig {
        let defaults = UserDefaults.standard
        // Minted once and kept. Deleting the app destroys it along with
        // everything else in the container, which is correct and is the same
        // fact ios.md §4 records about the ssh key: a reinstall is a new
        // client, and the layout it finds on the server is nobody's.
        let client = defaults.string(forKey: clientKey) ?? UUID().uuidString
        defaults.set(client, forKey: clientKey)
        return ShellConfig(client: client, server: ServerStore.selected())
    }

    /// The destination the pairing screen starts with when it has nothing
    /// better to offer.
    ///
    /// `simctl launch <device> <bundle> -LedgeServer ledge@127.0.0.1` sets it:
    /// UserDefaults reads `-key value` pairs off the command line for free,
    /// which is how a probe points a build at a scratch server without
    /// rebuilding it. It is a suggestion and never a pin — the host key still
    /// has to be confirmed by whoever is holding the phone.
    static var suggestion: String {
        UserDefaults.standard.string(forKey: "LedgeServer")
            ?? (Bundle.main.object(forInfoDictionaryKey: "LedgeServer") as? String)
            ?? ""
    }

    /// What this device calls itself, for the presence list every other client
    /// on the same server is pushed (shared/wire.ts `Hello.label`).
    ///
    /// Since iOS 16 this is the MODEL name — "iPhone", "iPad" — for any app
    /// without the user-assigned-device-name entitlement, and that is the right
    /// answer to ship: the sentence it has to make is "iPhone took this shell",
    /// which needs a device and not a person. An app that later earns the
    /// entitlement gets the user's own name for it here with no other change.
    static var label: String {
        UIDevice.current.name
    }
}
