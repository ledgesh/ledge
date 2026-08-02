import Foundation
import Network

/// One TCP connection to a Ledge server, as a byte stream and nothing more.
///
/// **This transport is a phase-3 fixture and must never ship** (ios.md §14).
/// remote.md §3's first claim is that the server opens no port, and everything
/// §4 does rests on it: an `authorized_keys` forced command can only narrow
/// what ssh already authenticated, and there is no authentication here at all.
/// What this proves is the view, the bridge, and §5's boot latency, with the
/// hardest piece — NIOSSH, the Secure Enclave key, the host-key delegate — out
/// of the way. Phase 4 replaces this file and nothing above it: the page sees a
/// `Duplex`, and a duplex does not know what carries it.
///
/// Everything below the byte stream stays here, and everything above it is
/// JavaScript. This class parses no frame and knows no method name.
final class Socket {
    private let connection: NWConnection
    private let queue = DispatchQueue(label: "ledge.socket")
    /// Which socket this is. A reconnect opens the next one while this one's
    /// obituary is still crossing the bridge, and the page drops anything from
    /// a generation it has moved on from (nativeBridge.ts).
    let generation: Int

    private var onBytes: ((Data) -> Void)?
    private var onEnd: (() -> Void)?
    private var ended = false

    init(generation: Int, host: String, port: UInt16) {
        self.generation = generation
        self.connection = NWConnection(
            host: NWEndpoint.Host(host),
            port: NWEndpoint.Port(rawValue: port) ?? 8787,
            using: .tcp
        )
    }

    /// Connect, then read until the far end stops.
    ///
    /// `ready` fires once. The page is waiting on it to build a connection over
    /// this socket, so a failure has to arrive as a failure rather than as a
    /// silence: a dial that never settles is an app that never boots and never
    /// says why.
    func open(
        ready: @escaping (Result<Void, Error>) -> Void,
        bytes: @escaping (Data) -> Void,
        end: @escaping () -> Void
    ) {
        onBytes = bytes
        onEnd = end
        var settled = false

        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                if !settled {
                    settled = true
                    ready(.success(()))
                }
                self.read()
            case .failed(let error):
                if !settled {
                    settled = true
                    ready(.failure(error))
                }
                self.finish()
            case .cancelled:
                self.finish()
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    func send(_ data: Data) {
        connection.send(
            content: data,
            completion: .contentProcessed { [weak self] error in
                // A write that failed is a wire that is gone, whatever the
                // read side thinks. Reporting it as a hangup is what lets the
                // page's ladder start rather than wait for a timeout.
                if error != nil { self?.finish() }
            }
        )
    }

    func close() {
        connection.cancel()
    }

    private func read() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) {
            [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty { self.onBytes?(data) }
            if isComplete || error != nil { return self.finish() }
            self.read()
        }
    }

    private func finish() {
        guard !ended else { return }
        ended = true
        connection.cancel()
        onEnd?()
    }
}
