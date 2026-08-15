import Foundation
import Security

/// One server's password, in this phone's keychain (remote.md §4).
///
/// The device key next door is in the Secure Enclave and cannot be exported.
/// This cannot be: a password is a string somebody typed and can type again, so
/// what protects it is the keychain's own scoping rather than hardware.
///
/// **This is where the two clients genuinely differ.** A Mac's item is reached
/// through `/usr/bin/security` and is readable by anything running as that user
/// (bun/secrets.ts). This one is reached through `SecItem` with no access group,
/// so it belongs to this app alone and no other app on the phone can ask for it.
/// The Mac's arrangement is the price of not binding an ACL to a code signature
/// that changes when the app is re-signed; iOS has no such problem, because the
/// item's owner is the application identifier and that does not move.
///
/// `WhenUnlockedThisDeviceOnly` for `DeviceKey`'s reasons: the password is used
/// while somebody is holding the phone, and the attribute keeps it out of every
/// backup and off every restored device.
enum ServerPassword {
    /// The same service string the Mac files these under, which costs nothing
    /// and means one grep finds both.
    private static let service = "sh.ledge.app.server"

    /// The password for a server, or nil when it has none.
    ///
    /// Read at dial time and held only as long as the handshake, so a stored
    /// password is not sitting in this process between connections.
    static func read(_ id: String) -> String? {
        var item: CFTypeRef?
        let status = SecItemCopyMatching(
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: id,
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
            ] as CFDictionary,
            &item
        )
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Whether one is stored, without reading it. `kSecReturnData` is left off,
    /// so asking the question is not a way to get the answer's contents.
    static func has(_ id: String) -> Bool {
        let status = SecItemCopyMatching(
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: id,
                kSecMatchLimit as String: kSecMatchLimitOne,
            ] as CFDictionary,
            nil
        )
        return status == errSecSuccess
    }

    /// Store one, replacing whatever was there. False when the keychain refused.
    @discardableResult
    static func write(_ id: String, _ password: String) -> Bool {
        guard !id.isEmpty else { return false }
        // Delete first, for DeviceKey's reason: SecItemAdd on an existing
        // account is errSecDuplicateItem, and every caller here means "this is
        // the password now" rather than "add one if there is room".
        forget(id)
        let status = SecItemAdd(
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: id,
                kSecValueData as String: Data(password.utf8),
                kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            ] as CFDictionary,
            nil
        )
        return status == errSecSuccess
    }

    /// Drop it, if there is one. Silent about a missing item: every caller is
    /// removing or re-keying a server, and "there was nothing to delete" is a
    /// success for both.
    static func forget(_ id: String) {
        SecItemDelete(
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: id,
            ] as CFDictionary
        )
    }

    /// Every id that is not in `keep` loses its password.
    ///
    /// The page decides what the server list is (mainview/lib/nativeBridge.ts)
    /// and hands the whole list back on every change, so this is where a removal
    /// takes the credential with it. Sweeping rather than deleting one by id
    /// keeps that rule in one place: a record can leave the list by being
    /// removed, by failing to decode, or by an install being restored over
    /// another, and only the survivors are knowable here.
    static func keepOnly(_ keep: [String]) {
        var item: CFTypeRef?
        let status = SecItemCopyMatching(
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecReturnAttributes as String: true,
                kSecMatchLimit as String: kSecMatchLimitAll,
            ] as CFDictionary,
            &item
        )
        guard status == errSecSuccess, let found = item as? [[String: Any]] else { return }
        let wanted = Set(keep)
        for attributes in found {
            guard let account = attributes[kSecAttrAccount as String] as? String, !wanted.contains(account) else {
                continue
            }
            forget(account)
        }
    }
}
