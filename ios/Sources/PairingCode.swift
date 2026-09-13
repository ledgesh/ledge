/// A pairing code: the server to dial and the host keys it offers, read from a
/// scanned or tapped link. The rules and their order are `shared/pairing.ts`'s,
/// and `shared/pairing.swift.test.ts` holds this file to the same vectors
/// (remote.md §4b). It imports nothing, so that test can compile it on a Mac.
struct PairingCode: Equatable {
    let user: String
    /// A host name or an IPv4 address.
    let host: String
    /// 0 for sshd's default port, the way `ServerRecord.port` stores it.
    let port: Int
    /// `SHA256:…` as `ssh-keygen -lf` prints it, one per host key.
    let fingerprints: [String]

    var destination: String { "\(user)@\(host)" }

    enum Read: Equatable {
        case code(PairingCode)
        case problem(String)
    }

    static let version = 1
    static let maxFingerprints = 4

    enum Problem {
        static let notACode = "This is not a Ledge pairing code."
        static let newer = "This pairing code needs a newer version of Ledge. Update the app, then try the code again."
        static let version = "The pairing code's version is not one Ledge recognizes."
        static let encoding = "The pairing code has a damaged character in it."
        static let user = "The pairing code has no valid account name."
        static let host = "The pairing code has no valid host name or IP address."
        static let port = "The pairing code's port is not a whole number from 1 to 65535."
        static let noFingerprint = "The pairing code has no host key fingerprint."
        static let fingerprint = "The pairing code has a host key fingerprint that is not a SHA256 fingerprint."
        static let tooManyFingerprints = "The pairing code names more than \(maxFingerprints) host keys."
        static func repeated(_ field: String) -> String { "The pairing code gives the \(field) more than once." }
    }

    /// Everything here walks Unicode scalars, not `Character`s. A combining mark
    /// joins the character before it, so "&" followed by one is a `Character`
    /// that is not "&", and the TypeScript reader would still split there.
    static func read(_ text: String) -> Read {
        let scalars = trimmed(Array(text.unicodeScalars))
        guard let hash = scalars.firstIndex(of: "#") else { return .problem(Problem.notACode) }
        let base = asciiLowercased(string(scalars[..<hash]))
        guard base == "https://ledge.sh/pair" || base == "ledge://pair" else { return .problem(Problem.notACode) }

        let fields: [(key: String, raw: String)] = scalars[(hash + 1)...].split(separator: "&").map { segment in
            guard let eq = segment.firstIndex(of: "=") else { return (string(segment), "") }
            return (string(segment[..<eq]), string(segment[(eq + 1)...]))
        }
        func raws(_ key: String) -> [String] { fields.filter { $0.key == key }.map(\.raw) }

        let versions = raws("v")
        if versions.isEmpty { return .problem(Problem.notACode) }
        if versions.count > 1 { return .problem(Problem.repeated("version")) }
        guard let version = versionNumber(versions[0]) else { return .problem(Problem.version) }
        if version > Self.version { return .problem(Problem.newer) }

        for (key, name) in [("u", "account name"), ("h", "host"), ("p", "port")] where raws(key).count > 1 {
            return .problem(Problem.repeated(name))
        }
        var decoded: [String: [String]] = [:]
        for key in ["u", "h", "p", "k"] {
            let values = raws(key).map(percentDecoded)
            if values.contains(where: { $0 == nil }) { return .problem(Problem.encoding) }
            decoded[key] = values.compactMap { $0 }
        }

        var fingerprints: [String] = []
        for fingerprint in decoded["k"] ?? [] where !fingerprints.contains(fingerprint) {
            fingerprints.append(fingerprint)
        }
        let code = PairingCode(
            user: decoded["u"]?.first ?? "",
            host: decoded["h"]?.first ?? "",
            port: portField(decoded["p"]?.first),
            fingerprints: fingerprints
        )
        if let problem = code.problem { return .problem(problem) }
        return .code(code)
    }

    /// A stored server, reduced to what the pin rule reads.
    struct Known: Equatable {
        let id: String
        let destination: String
        let port: Int
        /// The pinned key's `SHA256:…`, or "" for a record whose pin was dropped.
        let fingerprint: String
    }

    /// What the stored servers make of this code (remote.md §4b, the first rule).
    enum Match: Equatable {
        /// No record for this account at this host and port. The key the server
        /// offers has to be one the code names, and it is pinned.
        case new
        /// This account's record, pinned to a key the code names. The pin
        /// decides the dial, and nothing is pinned again.
        case pinned(id: String)
        /// This account's record with its pin dropped. The code's key is pinned.
        case unpinned(id: String)
        /// A record at this host and port is pinned to a key the code does not
        /// name. The code is refused, the way a changed host key is.
        case conflict(pinned: String)
    }

    /// A host key belongs to a host and a port rather than to an account, so a
    /// pin on any account there can refuse the code. A host name compares
    /// without regard to ASCII case, since DNS ignores it.
    func match(_ known: [Known]) -> Match {
        let host = Self.asciiLowercased(self.host)
        let here = known.filter { Self.asciiLowercased(Self.host(of: $0.destination)) == host && $0.port == port }
        if let stale = here.first(where: { !$0.fingerprint.isEmpty && !fingerprints.contains($0.fingerprint) }) {
            return .conflict(pinned: stale.fingerprint)
        }
        guard let mine = here.first(where: { Self.user(of: $0.destination) == user }) else { return .new }
        return mine.fingerprint.isEmpty ? .unpinned(id: mine.id) : .pinned(id: mine.id)
    }

    private static func user(of destination: String) -> String {
        String(destination.unicodeScalars.prefix(while: { $0 != "@" }))
    }

    private static func host(of destination: String) -> String {
        String(String.UnicodeScalarView(destination.unicodeScalars.drop(while: { $0 != "@" }).dropFirst()))
    }

    /// The first problem with the fields, checked in `pairingProblem`'s order.
    var problem: String? {
        if !Self.isName(user, maxLength: 64) { return Problem.user }
        if !Self.isName(host, maxLength: 253) { return Problem.host }
        if port != 0 && !(1...65535).contains(port) { return Problem.port }
        if fingerprints.isEmpty { return Problem.noFingerprint }
        if !fingerprints.allSatisfy(Self.isFingerprint) { return Problem.fingerprint }
        if Set(fingerprints).count > Self.maxFingerprints { return Problem.tooManyFingerprints }
        return nil
    }

    private static let digits = Set("0123456789".unicodeScalars)
    private static let hex = Set("0123456789ABCDEFabcdef".unicodeScalars)
    private static let nameStart = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_".unicodeScalars)
    private static let base64 = nameStart.subtracting(["_"]).union(["+", "/"])
    // The last of 43 base64 characters holds four bits of a 32-byte digest.
    private static let base64Last = Set("AEIMQUYcgkosw048".unicodeScalars)

    /// ASCII, not starting with "-" or ".", so it cannot become an ssh option.
    private static func isName(_ text: String, maxLength: Int) -> Bool {
        let scalars = Array(text.unicodeScalars)
        guard let first = scalars.first, nameStart.contains(first), scalars.count <= maxLength else { return false }
        return scalars.allSatisfy { nameStart.contains($0) || $0 == "." || $0 == "-" }
    }

    private static func isFingerprint(_ text: String) -> Bool {
        let scalars = Array(text.unicodeScalars)
        guard scalars.count == 50, string(scalars[..<7]) == "SHA256:", let last = scalars.last else { return false }
        return scalars[7..<49].allSatisfy { base64.contains($0) } && base64Last.contains(last)
    }

    private static func versionNumber(_ text: String) -> Int? {
        let scalars = Array(text.unicodeScalars)
        guard (1...6).contains(scalars.count), scalars.allSatisfy(digits.contains), scalars[0] != "0" else { return nil }
        return Int(text)
    }

    /// -1 for text that is not a port, so `problem` reports it in its turn.
    private static func portField(_ text: String?) -> Int {
        guard let text else { return 0 }
        let scalars = Array(text.unicodeScalars)
        guard (1...5).contains(scalars.count), scalars.allSatisfy(digits.contains), let port = Int(text),
            (1...65535).contains(port)
        else { return -1 }
        return port == 22 ? 0 : port
    }

    /// Only escapes of ASCII bytes, like the TypeScript reader: every field is
    /// ASCII, so a byte above 0x7f is damage.
    private static func percentDecoded(_ raw: String) -> String? {
        let scalars = Array(raw.unicodeScalars)
        var out = String.UnicodeScalarView()
        var at = 0
        while at < scalars.count {
            guard scalars[at] == "%" else {
                out.append(scalars[at])
                at += 1
                continue
            }
            // The digits are checked first because `UInt8(_:radix:)` also takes
            // a sign, and would read "%+F" as 15.
            guard at + 2 < scalars.count, hex.contains(scalars[at + 1]), hex.contains(scalars[at + 2]),
                let byte = UInt8(string(scalars[(at + 1)...(at + 2)]), radix: 16), byte <= 0x7f
            else { return nil }
            out.append(Unicode.Scalar(byte))
            at += 3
        }
        return String(out)
    }

    private static func trimmed(_ scalars: [Unicode.Scalar]) -> ArraySlice<Unicode.Scalar> {
        let blank: Set<Unicode.Scalar> = [" ", "\t", "\r", "\n"]
        guard let start = scalars.firstIndex(where: { !blank.contains($0) }),
            let end = scalars.lastIndex(where: { !blank.contains($0) })
        else { return [] }
        return scalars[start...end]
    }

    private static func asciiLowercased(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            out.append(("A"..."Z").contains(scalar) ? Unicode.Scalar(scalar.value + 32)! : scalar)
        }
        return String(out)
    }

    private static func string<S: Sequence>(_ scalars: S) -> String where S.Element == Unicode.Scalar {
        var out = String.UnicodeScalarView()
        out.append(contentsOf: scalars)
        return String(out)
    }
}
