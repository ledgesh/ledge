import Foundation

/// How Ledge knows which bytes belong to which code block, and what each block
/// exited with.
///
/// Everything in a note flows through one shell on one PTY, so the byte stream
/// is a single mixed torrent: prompts, the shell's echo of what we typed, and
/// the actual output of each block. To pull that apart we wrap every command we
/// submit in OSC 133 semantic markers, which is the same convention Ghostty,
/// WezTerm, and iTerm2 use for shell integration:
///
///     printf '\033]133;C;ledge=<nonce>:<block>\a'
///     <the command>
///     printf '\033]133;D;<exit code>;ledge=<nonce>:<block>\a'
///
/// The reader keeps only the bytes between a C and its matching D. Prompt
/// noise, the echoed command line, and anything a fancy prompt emits in between
/// commands all fall outside a window and are dropped.
///
/// Two details that are load-bearing:
///
/// **The echo cannot forge a marker.** The shell echoes the command line we
/// typed, which contains the literal characters `\033]133;C;...`, backslash and
/// all. The real escape byte only appears when printf actually runs. We match on
/// the escape byte, so the echo is inert.
///
/// **A block cannot forge its own terminator.** The nonce is fresh per session
/// and never written into the note, so a block would have to read it out of its
/// own environment to fake an end marker. That is not a threat model, it is a
/// magic trick.
public enum MarkerProtocol {
    /// ESC ] 1 3 3 ;
    static let oscPrefix = Data([0x1B, 0x5D, 0x31, 0x33, 0x33, 0x3B])
    /// BEL, which ends the sequence.
    static let bell: UInt8 = 0x07
    /// ESC \, the other legal terminator (ST). Accepted on input for safety.
    static let stringTerminator = Data([0x1B, 0x5C])

    /// Build the line submitted to the shell for one block.
    ///
    /// The block body is never inlined here. It goes to a file and the file is
    /// sourced or handed to an interpreter, which sidesteps quoting, heredocs,
    /// line continuations, and anything else multi-line text does to a shell
    /// that is being typed at.
    public static func command(
        runner: String,
        nonce: String,
        blockId: String
    ) -> String {
        let tag = "ledge=\(nonce):\(blockId)"
        return """
        printf '\\033]133;C;\(tag)\\a'; \(runner); __ledge_rc=$?; \
        printf '\\033]133;D;%d;\(tag)\\a' "$__ledge_rc"

        """
    }
}

/// What the parser found in the byte stream.
public enum MarkerEvent: Equatable, Sendable {
    /// A block started producing output.
    case began(blockId: String)
    /// Output belonging to the currently open block.
    case output(blockId: String, data: Data)
    /// A block finished, with its exit status.
    case ended(blockId: String, exitCode: Int32)
}

/// Slices the PTY byte stream into per-block output.
///
/// Byte-oriented on purpose. Decoding to a String here would corrupt any block
/// whose output is binary, and would break a multi-byte character that happens
/// to straddle a read boundary. Decoding is the caller's problem, once it owns a
/// whole span.
public struct MarkerParser {
    private let nonce: String
    private var buffer = Data()
    private var openBlock: String?

    public init(nonce: String) {
        self.nonce = nonce
    }

    /// Feed bytes from the PTY. Returns whatever became unambiguous.
    public mutating func feed(_ data: Data) -> [MarkerEvent] {
        buffer.append(data)
        var events: [MarkerEvent] = []

        while !buffer.isEmpty {
            guard let start = firstOSC(in: buffer) else {
                // No marker ahead. Everything we hold is either output or noise,
                // except for a possible partial escape at the very end, which we
                // must keep in case the rest arrives in the next read.
                let safe = buffer.count - partialOSCSuffixLength(buffer)
                if safe > 0 {
                    emit(buffer.prefix(safe), into: &events)
                    buffer.removeFirst(safe)
                }
                break
            }

            // Bytes before the marker belong to whatever is open.
            if start > 0 {
                emit(buffer.prefix(start), into: &events)
                buffer.removeFirst(start)
            }

            guard let (marker, consumed) = parseMarker(buffer) else {
                // Marker is still arriving. Wait for more bytes.
                break
            }

            buffer.removeFirst(consumed)
            switch marker {
            case let .began(id):
                openBlock = id
                events.append(.began(blockId: id))
            case let .ended(id, code):
                if openBlock == id {
                    openBlock = nil
                }
                events.append(.ended(blockId: id, exitCode: code))
            case .unknown:
                // Some other OSC 133 sequence, or one from a shell integration
                // that is not ours. Not our business, and not output either.
                break
            }
        }

        return events
    }

    private func emit(_ bytes: Data, into events: inout [MarkerEvent]) {
        // Output outside a block is prompt noise or the shell's echo. Drop it.
        guard let openBlock, !bytes.isEmpty else { return }
        events.append(.output(blockId: openBlock, data: Data(bytes)))
    }

    // MARK: - Scanning

    private enum Marker {
        case began(String)
        case ended(String, Int32)
        case unknown
    }

    private func firstOSC(in data: Data) -> Int? {
        guard data.count >= MarkerProtocol.oscPrefix.count else {
            return data.firstIndex(of: 0x1B).map { $0 - data.startIndex }
        }
        return data.range(of: MarkerProtocol.oscPrefix).map { $0.lowerBound - data.startIndex }
    }

    /// How many trailing bytes might be the beginning of a marker we have not
    /// fully received? Those must not be emitted as output yet.
    private func partialOSCSuffixLength(_ data: Data) -> Int {
        let maxPartial = min(MarkerProtocol.oscPrefix.count - 1, data.count)
        guard maxPartial > 0 else { return 0 }
        for length in stride(from: maxPartial, through: 1, by: -1) {
            let suffix = data.suffix(length)
            if suffix.elementsEqual(MarkerProtocol.oscPrefix.prefix(length)) {
                return length
            }
        }
        return 0
    }

    /// Parse a marker sitting at the head of `data`. Returns nil if incomplete.
    private func parseMarker(_ data: Data) -> (Marker, Int)? {
        let prefix = MarkerProtocol.oscPrefix
        if !data.starts(with: prefix) {
            // The buffer begins with ESC but does not yet hold the whole prefix.
            // If what we have is a leading slice of our prefix, the rest is still
            // in flight: wait, do not emit or skip. This is the marker-split-
            // across-reads case, and getting it wrong leaks marker bytes into
            // output.
            if data.count < prefix.count, prefix.starts(with: data) {
                return nil
            }
            // A real ESC that is not our OSC 133. Skip one byte so we do not
            // spin, and treat it as noise.
            return (.unknown, 1)
        }

        let bodyStart = data.startIndex + MarkerProtocol.oscPrefix.count
        let tail = data[bodyStart...]

        // Find the terminator: BEL, or ESC backslash.
        var end: Int?
        var terminatorLength = 0
        if let bel = tail.firstIndex(of: MarkerProtocol.bell) {
            end = bel
            terminatorLength = 1
        }
        if let st = tail.range(of: MarkerProtocol.stringTerminator) {
            if end == nil || st.lowerBound < end! {
                end = st.lowerBound
                terminatorLength = 2
            }
        }
        guard let end else { return nil }

        let body = String(decoding: tail[tail.startIndex ..< end], as: UTF8.self)
        let consumed = (end - data.startIndex) + terminatorLength

        let fields = body.split(separator: ";", omittingEmptySubsequences: false).map(String.init)
        guard let kind = fields.first else { return (.unknown, consumed) }

        // C;ledge=<nonce>:<block>
        if kind == "C", fields.count >= 2, let id = blockId(fromTag: fields[1]) {
            return (.began(id), consumed)
        }

        // D;<code>;ledge=<nonce>:<block>
        if kind == "D", fields.count >= 3,
           let code = Int32(fields[1]),
           let id = blockId(fromTag: fields[2]) {
            return (.ended(id, code), consumed)
        }

        return (.unknown, consumed)
    }

    /// Pull the block id out of `ledge=<nonce>:<block>`, but only if the nonce
    /// is ours.
    private func blockId(fromTag tag: String) -> String? {
        guard tag.hasPrefix("ledge=") else { return nil }
        let payload = tag.dropFirst("ledge=".count)
        guard let separator = payload.firstIndex(of: ":") else { return nil }
        guard payload[payload.startIndex ..< separator] == nonce else { return nil }
        return String(payload[payload.index(after: separator)...])
    }
}
