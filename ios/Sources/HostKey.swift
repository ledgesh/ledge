import CryptoKit
import Foundation
import NIOCore
import NIOSSH

/// The server's key, and the one decision Ledge makes about it (ios.md §3).
///
/// remote.md §4 says Ledge parses no key material and computes no hash of its
/// own, because OpenSSH does the pinning and Ledge is only its client. That
/// sentence describes the Mac and stops being true here: there is no OpenSSH in
/// this process, NIOSSH hands the offered key to a delegate, and the app
/// decides.
///
/// So the decision is kept as small as it can be. The pinned key is compared to
/// the offered one as encoded bytes and any difference refuses. An equality
/// test on a blob is not a parser, and "no blind accept, no continue-anyway
/// that remembers" is a property of the UI: there is no button for it.
///
/// The fingerprint below is for a human to read at pairing. It is rendered from
/// the same bytes and never used to decide anything, because a truncated hash
/// is a worse comparison than the thing it summarizes.
struct HostKeyOffer {
    /// `ssh-ed25519 AAAAC3…`, the two fields that identify a key. The same
    /// shape `ssh-keyscan` prints after the hostname, which is what makes a pin
    /// legible next to what the server itself reports.
    let openSSHLine: String
    /// `SHA256:…`, base64 of the digest with the padding stripped, exactly what
    /// `ssh-keygen -lf` prints.
    let fingerprint: String

    var keyType: String { String(openSSHLine.split(separator: " ").first ?? "") }

    init(_ key: NIOSSHPublicKey) {
        self.init(line: String(openSSHPublicKey: key))
    }

    init(line: String) {
        openSSHLine = line
        let parts = line.split(separator: " ")
        guard parts.count >= 2, let blob = Data(base64Encoded: String(parts[1])) else {
            fingerprint = ""
            return
        }
        fingerprint = "SHA256:" + Data(SHA256.hash(data: blob)).base64EncodedString().replacingOccurrences(of: "=", with: "")
    }
}

enum HostKeyError: Error, LocalizedError {
    case changed(expected: HostKeyOffer, offered: HostKeyOffer)
    case declined

    var errorDescription: String? {
        switch self {
        case .changed(let expected, let offered):
            // Both fingerprints, because "the host key changed" without them is
            // a sentence nobody can act on: the question a user has to answer
            // is whether the new one is the server's, and they can only answer
            // it by reading it.
            return """
                This server offered a different host key than the one Ledge pinned when you paired.
                Pinned: \(expected.fingerprint)
                Offered: \(offered.fingerprint)
                """
        case .declined:
            return "The host key was not accepted."
        }
    }
}

/// The pinned case: what every connection after pairing uses.
final class PinnedHostKey: NIOSSHClientServerAuthenticationDelegate {
    private let expected: HostKeyOffer

    init(openSSHLine: String) {
        expected = HostKeyOffer(line: openSSHLine)
    }

    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        let offered = HostKeyOffer(hostKey)
        if offered.openSSHLine == expected.openSSHLine {
            validationCompletePromise.succeed(())
        } else {
            validationCompletePromise.fail(HostKeyError.changed(expected: expected, offered: offered))
        }
    }
}

/// The probe case: take the key on offer and go no further.
///
/// What `ssh-keyscan` is on a Mac (bun/connections.ts), and it has to be a dial
/// because there is no keyscan here: the host key arrives during key exchange,
/// before any authentication, so this learns the fingerprint without the phone's
/// key ever going on the wire and without the server needing to accept it yet.
/// Refusing is the point rather than a side effect — this connection exists to
/// ask a question, and the answer is read off `offered` afterwards.
final class CapturingHostKey: NIOSSHClientServerAuthenticationDelegate {
    private(set) var offered: HostKeyOffer?

    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        offered = HostKeyOffer(hostKey)
        validationCompletePromise.fail(HostKeyError.declined)
    }
}

/// The pairing case: ask, and let the handshake wait for the answer.
///
/// The delegate is asynchronous, which buys a property the Mac client does not
/// have. There, `ssh-keyscan` fetches a key, the user confirms it, and a second
/// connection later trusts what was written down. Here the key being shown IS
/// the key of the connection in progress, and that connection only continues if
/// the person holding the phone says so.
final class ConfirmingHostKey: NIOSSHClientServerAuthenticationDelegate {
    /// Called on the main queue with the offer and a decision callback.
    private let ask: (HostKeyOffer, @escaping (Bool) -> Void) -> Void
    /// What was accepted, for the caller to store once the rest of the
    /// connection has proven the pairing works.
    private(set) var accepted: HostKeyOffer?

    init(ask: @escaping (HostKeyOffer, @escaping (Bool) -> Void) -> Void) {
        self.ask = ask
    }

    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        let offered = HostKeyOffer(hostKey)
        DispatchQueue.main.async {
            self.ask(offered) { yes in
                // Back onto the event loop the promise belongs to: completing a
                // promise from another thread is the kind of bug that only
                // shows up under load.
                validationCompletePromise.futureResult.eventLoop.execute {
                    if yes {
                        self.accepted = offered
                        validationCompletePromise.succeed(())
                    } else {
                        validationCompletePromise.fail(HostKeyError.declined)
                    }
                }
            }
        }
    }
}
