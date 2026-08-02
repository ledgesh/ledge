import CryptoKit
import Foundation
import NIOSSH
import UIKit

/// The phone's own SSH key: minted here on first launch, and never a copy of
/// anyone else's (ios.md §4).
///
/// The private half is generated inside the Secure Enclave and cannot be read
/// out of it — what the keychain holds is a wrapped reference that only this
/// device's enclave can use, and signing is a call into hardware. A lost phone
/// therefore hands over no key material at all, and revoking it is deleting one
/// line from `authorized_keys` on the server.
///
/// That decides the key type. The enclave does P-256 and nothing else, so the
/// key is `ecdsa-sha2-nistp256`; OpenSSH accepts it by default, and a server
/// whose `PubkeyAcceptedAlgorithms` has been narrowed to Ed25519 will refuse
/// it, which is a posture to name in the manual rather than debug in the field.
///
/// **Deleting the app destroys the key.** The container goes and the enclave
/// reference with it, so a reinstall is a new client with a new id, a new key,
/// and a stale line in `authorized_keys` that will never authenticate again.
/// Correct, and worth saying out loud: the symptom is "my phone stopped working
/// after I reinstalled" and the fix is pairing again.
enum DeviceKey {
    /// One of the two ways this device can hold a P-256 key.
    ///
    /// The software case exists for the Simulator, which has no enclave. It is
    /// refused on real hardware: a key on disk is a weaker thing than the one
    /// §4 promises, and silently downgrading to it is exactly how a security
    /// property becomes a claim nobody checked.
    enum Held {
        case enclave(SecureEnclave.P256.Signing.PrivateKey)
        case software(P256.Signing.PrivateKey)

        var sshKey: NIOSSHPrivateKey {
            switch self {
            case .enclave(let key): return NIOSSHPrivateKey(secureEnclaveP256Key: key)
            case .software(let key): return NIOSSHPrivateKey(p256Key: key)
            }
        }

        /// `ecdsa-sha2-nistp256 AAAA…`, the two fields that identify a key.
        var openSSHPublicKey: String { String(openSSHPublicKey: sshKey.publicKey) }

        var isEnclave: Bool {
            if case .enclave = self { return true }
            return false
        }
    }

    enum Failure: Error, LocalizedError {
        case noEnclave
        case keychain(OSStatus)
        case unreadable

        var errorDescription: String? {
            switch self {
            case .noEnclave:
                return "This device has no Secure Enclave, and Ledge will not keep an SSH key anywhere else."
            case .keychain(let status):
                return "The keychain refused the key (OSStatus \(status))."
            case .unreadable:
                return "The stored key could not be read. Pair this phone again."
            }
        }
    }

    private static let service = "dev.ledge.ios.ssh"
    private static let account = "device-key"

    /// The key for this install, minted on the first call and returned by every
    /// later one.
    static func load() throws -> Held {
        if let data = try read() {
            guard let held = decode(data) else { throw Failure.unreadable }
            return held
        }
        let minted = try mint()
        try write(encode(minted))
        return minted
    }

    /// The line remote.md §4 specifies, whole, for the user to paste into
    /// `~/.ssh/authorized_keys` on the server.
    ///
    /// `restrict` turns off port forwarding, agent forwarding, X11 and pty
    /// allocation; `command=` means this key cannot ask for anything else. Both
    /// halves are the server's enforcement, not ours — this app only prints the
    /// line, and a client that spoke SSH badly would get a connection that
    /// fails rather than a capability nobody granted it.
    static func authorizedKeysLine(_ held: Held, client: String) -> String {
        // A comment that says which phone, because revoking is deleting the
        // right line out of a file that may have several.
        let label = "ledge-\(deviceName())-\(client.prefix(8).lowercased())"
        return "restrict,command=\"ledge-server serve\" \(held.openSSHPublicKey) \(label)"
    }

    private static func deviceName() -> String {
        // The idiom, not `UIDevice.name`: since iOS 16 the name is the model
        // unless the app holds an entitlement, and asking for one in order to
        // decorate a comment field would be asking for the user's device name
        // for no reason.
        UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone"
    }

    // --- minting ------------------------------------------------------------

    private static func mint() throws -> Held {
        if SecureEnclave.isAvailable {
            // The default access control is `.privateKeyUsage` with
            // "when unlocked, this device only", and that is deliberate: it
            // gates the key on the device being unlocked rather than on a
            // prompt per signature. `.userPresence` would put a Face ID scan in
            // front of every reconnect, and §5's whole point is that
            // reconnecting is the ordinary path on a phone, not the exception.
            return .enclave(try SecureEnclave.P256.Signing.PrivateKey())
        }
        #if targetEnvironment(simulator)
        // The Simulator has no enclave. A software key here is what makes the
        // ssh path testable at all; it is stored with the same keychain
        // protection and it never exists on hardware.
        return .software(P256.Signing.PrivateKey())
        #else
        throw Failure.noEnclave
        #endif
    }

    // --- the keychain -------------------------------------------------------

    // One item, self-describing: the kind and the representation together, so
    // that "which sort of key is this" can never be answered by a second store
    // that has drifted out of step with the first.
    private static func encode(_ held: Held) -> Data {
        switch held {
        case .enclave(let key): return Data("e:\(key.dataRepresentation.base64EncodedString())".utf8)
        case .software(let key): return Data("s:\(key.rawRepresentation.base64EncodedString())".utf8)
        }
    }

    private static func decode(_ data: Data) -> Held? {
        guard let text = String(data: data, encoding: .utf8), text.count > 2 else { return nil }
        guard let bytes = Data(base64Encoded: String(text.dropFirst(2))) else { return nil }
        switch text.prefix(2) {
        case "e:": return (try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: bytes)).map(Held.enclave)
        case "s:": return (try? P256.Signing.PrivateKey(rawRepresentation: bytes)).map(Held.software)
        default: return nil
        }
    }

    private static func read() throws -> Data? {
        var item: CFTypeRef?
        let status = SecItemCopyMatching(
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
            ] as CFDictionary,
            &item
        )
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Failure.keychain(status) }
        return item as? Data
    }

    private static func write(_ data: Data) throws {
        // Delete first: SecItemAdd on an existing account is errSecDuplicateItem,
        // and the only way to be here with an existing item is a decode that
        // failed, which is a key worth replacing.
        SecItemDelete(
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
            ] as CFDictionary
        )
        let status = SecItemAdd(
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
                kSecValueData as String: data,
                // Unlocked, this device only: the key is used while someone is
                // holding the phone, and `ThisDeviceOnly` keeps it out of every
                // backup and off every restored device. For the enclave case
                // the wrapped blob is useless elsewhere anyway; for the
                // Simulator's software key this attribute is the whole of the
                // protection.
                kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            ] as CFDictionary,
            nil
        )
        guard status == errSecSuccess else { throw Failure.keychain(status) }
    }
}
