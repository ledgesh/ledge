import Foundation
import NIOCore
import NIOPosix
import NIOSSH

/// One ssh connection to a Ledge server, as a byte stream and nothing more.
///
/// This is the file phase 4 replaced (ios.md §14): the page is handed a
/// `Duplex`, and a duplex does not know what carries it. Everything above the
/// byte stream — the handshake, the op ids, the reconnect ladder, the held
/// requests — is the same JavaScript the Mac runs over `/usr/bin/ssh`, and the
/// difference is entirely here.
///
/// What `bun/connections.ts` says with argv, this says with objects:
///
/// | `sshCommand`                     | here                            |
/// | -------------------------------- | ------------------------------- |
/// | `command="ledge-server serve"`   | the server's sshd, unchanged    |
/// | `StrictHostKeyChecking=yes`      | `PinnedHostKey`                 |
/// | `UserKnownHostsFile`             | the stored record               |
/// | `BatchMode=yes`                  | no prompt exists to suppress    |
/// | no `-t`                          | an exec request, never a pty    |
/// | `ServerAliveInterval=5`          | `TCP_KEEPALIVE`, `TCP_KEEPINTVL`|
/// | `ServerAliveCountMax=3`          | `TCP_KEEPCNT`                   |
/// | `ConnectTimeout=10`              | `dialTimeout` (a wider bound)   |
///
/// The first row is the one that matters and it is the row that does not move.
/// The restriction lives in the server's `authorized_keys`, so it is indifferent
/// to what the client is written in: a client that speaks SSH badly gets a
/// connection that fails, not a capability nobody granted it.
///
/// The last three rows are the only ones where the phone needs a different
/// MECHANISM rather than a different implementation of the same one, and
/// `probeAfterIdle` below says why.
///
/// This class parses no frame and knows no method name.
final class SSHTransport {
    /// Which connection this is. A reconnect opens the next one while this
    /// one's obituary is still crossing the bridge, and the page drops anything
    /// from a generation it has moved on from (nativeBridge.ts).
    let generation: Int

    /// An ssh destination has no port in it, and neither does this. The Mac
    /// client has the same constraint (`sshCommand` takes a destination), and
    /// the fixture testing.md §6 describes holds 127.0.0.1:22 for exactly that
    /// reason.
    static let port = 22

    /// The whole dial: TCP, key exchange, host key, user auth, and the exec
    /// request. Bounded because a server that accepts a connection and then
    /// says nothing is indistinguishable from a slow one, and the page's
    /// reconnect ladder cannot start until this settles.
    private static let dialTimeout = TimeAmount.seconds(15)

    /// One group for the process. A group per dial would be a thread pair per
    /// reconnect, and reconnecting is the ordinary path on a phone (§5).
    private static let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)

    /// What `ServerAliveInterval` and `ServerAliveCountMax` buy the Mac, in the
    /// two forms TCP has for it (remote.md §7).
    ///
    /// A network that goes away does not end a connection. There is no FIN and
    /// no RST; the socket stays open and the bytes stop. Everything the page
    /// does about a lost server — the ladder, the held requests, the replay
    /// under the same op ids — is armed by the connection ENDING, so on the
    /// client that loses wires for a living, this is what has to end it.
    ///
    /// OpenSSH needs one mechanism for both cases because it counts at the
    /// application layer: a SERVER_ALIVE that went unanswered went unanswered
    /// whether or not there was data outstanding. The kernel has two, and which
    /// one runs depends on exactly that.
    ///
    /// - **Nothing in flight.** Keepalive probes: the first after
    ///   `probeAfterIdle` seconds of quiet, another every `probeEvery`, and the
    ///   socket fails once `probeCount` go unanswered. `SO_KEEPALIVE` alone,
    ///   which is all this asked for before, is this case at Darwin's default
    ///   idle time of two HOURS.
    /// - **A request in flight whose bytes were never acknowledged.** No
    ///   keepalive fires at all — TCP only probes an idle connection — and the
    ///   retransmit timer decides instead. Its own limit is TCP_MAXRXTSHIFT
    ///   doublings, which is minutes. `dropAfterStall` caps the episode.
    ///
    /// Both land on the twenty seconds the Mac measures, and for the same
    /// reason: hanging up on a link that was only stalled costs a reconnect,
    /// and not hanging up costs the session.
    ///
    /// The cost while nothing is happening is one 40-byte segment every five
    /// seconds, and only while the wire is genuinely idle — any traffic in
    /// either direction restarts the idle timer. A suspended app is a separate
    /// question with a separate answer (§5): the ladder is not running then,
    /// and what keeps the sessions is the hold it asked for, not a probe.
    ///
    /// These are now the BACKSTOP rather than the whole answer. The protocol
    /// carries its own heartbeat (remote.md §7) and it runs in the page, in the
    /// same JavaScript the Mac runs, so it reached this client by being written
    /// once: a `ping` after five seconds of quiet, a `pong` from the daemon
    /// itself, three unanswered and the connection ends. That one cannot be
    /// answered on the server's behalf by a proxy, a bastion or a healthy sshd
    /// in front of a stalled daemon, which is what these four cannot say. What
    /// these still cover is the half above — a suspended app runs no timers,
    /// and the kernel does not need one to be scheduled.
    private static let probeAfterIdle: CInt = 5
    private static let probeEvery: CInt = 5
    private static let probeCount: CInt = 3
    private static let dropAfterStall: CInt = 20

    /// A TCP-level option by its Darwin number. NIO gives names to the options
    /// every platform shares (`.tcp_nodelay`) and all four of these are Darwin's
    /// own, so the `netinet/tcp.h` name is what the call sites read.
    private static func tcp(_ name: CInt) -> ChannelOptions.Types.SocketOption {
        .tcpOption(.init(rawValue: name))
    }

    private let server: ServerRecord
    private let key: DeviceKey.Held
    private let hostKeyDelegate: NIOSSHClientServerAuthenticationDelegate
    private let log: (String) -> Void
    private let auth: PublicKeyAuth

    private let lock = NSLock()
    private var parent: Channel?
    private var child: Channel?
    private var ended = false

    init(
        generation: Int,
        server: ServerRecord,
        key: DeviceKey.Held,
        hostKey: NIOSSHClientServerAuthenticationDelegate,
        log: @escaping (String) -> Void
    ) {
        self.generation = generation
        self.server = server
        self.key = key
        self.hostKeyDelegate = hostKey
        self.log = log
        self.auth = PublicKeyAuth(username: server.user, key: key.sshKey)
    }

    /// Connect, authenticate, ask for the server, and read until the far end
    /// stops.
    ///
    /// `ready` fires exactly once. The page is waiting on it to build a
    /// connection over this transport, so a failure has to arrive as a failure
    /// rather than as a silence: a dial that never settles is an app that never
    /// boots and never says why.
    func open(
        ready: @escaping (Result<Void, Error>) -> Void,
        bytes: @escaping (Data) -> Void,
        end: @escaping () -> Void
    ) {
        var settled = false
        var timeout: Scheduled<Void>?
        let loop = Self.group.next()
        // Every closure below runs on this one loop, which is what makes a
        // plain Bool the right guard for "already settled". The timeout is
        // cancelled HERE and not when the channel opens: a channel exists as
        // soon as the far end agrees to one, and the thing being waited for is
        // the exec request's answer, which can still never come.
        let settle: (Result<Void, Error>) -> Void = { result in
            loop.assertInEventLoop()
            guard !settled else { return }
            settled = true
            timeout?.cancel()
            ready(result)
        }

        timeout = loop.scheduleTask(in: Self.dialTimeout) { [weak self] in
            settle(.failure(SSHFailure.timedOut(self?.server.destination ?? "")))
            self?.finish(end)
        }

        let config = SSHClientConfiguration(
            userAuthDelegate: auth,
            serverAuthDelegate: hostKeyDelegate
        )

        ClientBootstrap(group: loop)
            // What this asks of TCP, and the numbers above say why. A phone's
            // connection dies in ways a socket does not notice (a NAT that
            // forgets, a radio that changes, a tunnel that ends), and these turn
            // those into a hangup the page's ladder can act on rather than a
            // write that hangs and a UI that goes on claiming it is connected.
            .channelOption(ChannelOptions.socketOption(.so_keepalive), value: 1)
            .channelOption(Self.tcp(TCP_KEEPALIVE), value: Self.probeAfterIdle)
            .channelOption(Self.tcp(TCP_KEEPINTVL), value: Self.probeEvery)
            .channelOption(Self.tcp(TCP_KEEPCNT), value: Self.probeCount)
            .channelOption(Self.tcp(TCP_RXT_CONNDROPTIME), value: Self.dropAfterStall)
            .channelInitializer { channel in
                // Synchronously, on the loop the channel already belongs to.
                // The asynchronous `addHandlers` wants its handlers to be
                // Sendable and an SSH handler is explicitly not: it is a state
                // machine that only ever runs on one loop, which is what this
                // form says.
                channel.eventLoop.makeCompletedFuture {
                    try channel.pipeline.syncOperations.addHandlers([
                        NIOSSHHandler(
                            role: .client(config),
                            allocator: channel.allocator,
                            inboundChildChannelInitializer: nil
                        ),
                        // The end of the pipeline, and not optional. Everything
                        // that goes wrong during a handshake arrives as an
                        // error rather than as a message: a host key that does
                        // not match the pin, a key the server will not take.
                        // NIOSSH fires those and nothing more, so without a
                        // handler here they reach the tail, get logged by NIO
                        // as unhandled, and leave a connection that is neither
                        // up nor down until the dial times out — which reports
                        // "no answer in time" for a refusal that was immediate
                        // and specific.
                        FailOnError { [weak self] error in
                            settle(.failure(self?.explain(error) ?? error))
                        },
                    ])
                }
            }
            .connect(host: server.host, port: Self.port)
            .flatMap { [weak self] channel -> EventLoopFuture<Channel> in
                guard let self else {
                    return channel.close().flatMapThrowing { () -> Channel in throw SSHFailure.cancelled }
                }
                self.lock.withLock { self.parent = channel }
                let opened = channel.eventLoop.makePromise(of: Channel.self)
                // A connection that dies before the session channel exists,
                // with no error to explain it: a server that hangs up mid
                // handshake, or one that closes the moment it sees us. NIOSSH
                // has nothing to fail the pending channel with there, so
                // without this the dial waits out its timeout and calls a
                // hangup a silence. Failing an already-settled promise is a
                // no-op, so this only speaks when nothing else did.
                channel.closeFuture.whenComplete { _ in opened.fail(SSHFailure.cancelled) }
                channel.pipeline.handler(type: NIOSSHHandler.self).whenComplete { found in
                    switch found {
                    case .failure(let error):
                        opened.fail(error)
                    case .success(let handler):
                        // The session channel, and the command on it. The
                        // server's forced command overrides what is asked for;
                        // asking anyway is what makes this client work against
                        // a server that has not been narrowed.
                        handler.createChannel(opened, channelType: .session) { child, type in
                            guard type == .session else {
                                return child.eventLoop.makeFailedFuture(SSHFailure.wrongChannel)
                            }
                            return child.setOption(ChannelOptions.allowRemoteHalfClosure, value: true)
                                .flatMap {
                                    child.pipeline.addHandler(
                                        ExecHandler(
                                            command: "ledge-server serve",
                                            ready: settle,
                                            bytes: bytes,
                                            end: { [weak self] in self?.finish(end) },
                                            log: self.log
                                        )
                                    )
                                }
                        }
                    }
                }
                return opened.futureResult
            }
            .whenComplete { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(let child):
                    self.lock.withLock { self.child = child }
                    // Ready is the ExecHandler's to declare: a channel exists
                    // once it is open, but the server is only there once the
                    // exec request has been answered.
                    child.closeFuture.whenComplete { _ in self.finish(end) }
                case .failure(let error):
                    settle(.failure(self.explain(error)))
                    self.finish(end)
                }
            }
    }

    func send(_ data: Data) {
        let channel = lock.withLock { child }
        guard let channel else { return }
        var buffer = channel.allocator.buffer(capacity: data.count)
        buffer.writeBytes(data)
        // A write that failed is a wire that is gone, whatever the read side
        // thinks. Reporting it as a hangup is what lets the page's ladder start
        // rather than wait for a timeout.
        channel.writeAndFlush(buffer).whenFailure { [weak self] error in
            self?.log("[ssh] write failed: \(error)")
            self?.hangUp()
        }
    }

    func close() {
        hangUp()
    }

    // --- shutting down --------------------------------------------------------

    private func hangUp() {
        let (parent, child) = lock.withLock { (self.parent, self.child) }
        child?.close(promise: nil)
        parent?.close(promise: nil)
    }

    private func finish(_ end: @escaping () -> Void) {
        let already: Bool = lock.withLock {
            if ended { return true }
            ended = true
            return false
        }
        guard !already else { return }
        hangUp()
        end()
    }

    /// A NIOSSH error, in words a person can act on.
    ///
    /// The authentication case is decided by what this client offered rather
    /// than by matching an error type: the delegate knows it ran out of keys,
    /// and that fact is more stable than the shape of the failure NIOSSH
    /// reports afterwards.
    private func explain(_ error: Error) -> Error {
        // The raw failure as well as the sentence, because the sentence is for
        // the person holding the phone and this is for whoever has to work out
        // why an ssh handshake did not finish.
        log("[ssh] dial failed: \(error) (offered a key: \(auth.offered), out of keys: \(auth.exhausted))")
        if auth.exhausted { return SSHFailure.rejected(server.destination, key.isEnclave) }
        if error is HostKeyError { return error }
        return SSHFailure.unreachable(server.destination, error)
    }
}

/// The failures this transport reports, split by what a user would do about
/// them. `WebHost` sends the pairing ones back to the pairing screen and lets
/// the page retry the rest, because retrying a wrong key forever is the one
/// failure mode a reconnect ladder turns into a battery complaint.
enum SSHFailure: Error, LocalizedError {
    case notPaired
    case timedOut(String)
    case unreachable(String, Error)
    case rejected(String, Bool)
    case outOfKeys
    case wrongChannel
    case commandRefused
    case cancelled

    var errorDescription: String? {
        switch self {
        case .notPaired:
            return "This phone is not paired with a server yet."
        case .timedOut(let where_):
            return "\(where_) did not finish an ssh handshake in time."
        case .unreachable(let where_, let error):
            return "could not reach \(where_): \(error.localizedDescription)"
        case .rejected(let where_, let enclave):
            return """
                \(where_) refused this phone's key. Add its line to ~/.ssh/authorized_keys there, \
                and check that the account and the key type are ones it accepts\
                \(enclave ? "" : " (this build is using a software key, which a Simulator has to)")\
                .
                """
        case .outOfKeys:
            // Reworded by `explain` into the destination's own sentence; this
            // is what it says if it ever escapes on its own.
            return "The server did not accept this phone's key."
        case .wrongChannel:
            return "The server opened a channel Ledge did not ask for."
        case .commandRefused:
            return "The server refused to run ledge-server."
        case .cancelled:
            return "The connection was closed while it was being made."
        }
    }

    /// Whether the answer is "pair again" rather than "try again".
    static func needsPairing(_ error: Error) -> Bool {
        if error is HostKeyError { return true }
        switch error as? SSHFailure {
        case .rejected, .outOfKeys, .notPaired: return true
        default: return false
        }
    }
}

/// The tail of the connection's pipeline: an error is the end of this dial.
///
/// NIO's default is to log an unhandled error and carry on, which for a
/// handshake is the worst of the three options — the connection stays open,
/// nothing else is coming, and the only thing left to notice is a timeout.
private final class FailOnError: ChannelInboundHandler {
    typealias InboundIn = Any

    private let report: (Error) -> Void

    init(report: @escaping (Error) -> Void) {
        self.report = report
    }

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        report(error)
        context.close(promise: nil)
    }
}

/// One key, offered once.
///
/// The phone has exactly one identity and no agent to enumerate, so this is the
/// whole of user auth: offer the device key, and if the server comes back
/// asking for more, there is nothing more. Saying so by completing the promise
/// with `nil` is what turns a rejection into a failed connection with a reason,
/// instead of a loop.
private final class PublicKeyAuth: NIOSSHClientUserAuthenticationDelegate {
    private let username: String
    private let key: NIOSSHPrivateKey

    /// Whether the key was ever put on the wire.
    private(set) var offered = false

    /// Set once the server has asked for another method, which it only does
    /// after refusing the first.
    private(set) var exhausted = false

    init(username: String, key: NIOSSHPrivateKey) {
        self.username = username
        self.key = key
    }

    func nextAuthenticationType(
        availableMethods: NIOSSHAvailableUserAuthenticationMethods,
        nextChallengePromise: EventLoopPromise<NIOSSHUserAuthenticationOffer?>
    ) {
        guard availableMethods.contains(.publicKey), !offered else {
            exhausted = true
            // FAILED, not succeeded with nil. The protocol's own documentation
            // says a delegate with nothing left should fail this promise, and
            // it means it: NIOSSH has a `noFurtherMethods()` for the nil case
            // that nothing in the library ever calls, so answering nil sends
            // no message and the connection sits there until something else
            // gives up. The symptom is a refused key reported fifteen seconds
            // later as a timeout, which is the wrong sentence and the wrong
            // wait (ios.md §3: building blocks, not a client).
            nextChallengePromise.fail(SSHFailure.outOfKeys)
            return
        }
        offered = true
        nextChallengePromise.succeed(
            NIOSSHUserAuthenticationOffer(
                username: username,
                serviceName: "",
                offer: .privateKey(.init(privateKey: key))
            )
        )
    }
}

/// The session channel: a command, and the bytes it reads and writes.
///
/// Outbound plain `ByteBuffer`s become channel data here, so nothing above this
/// handler has to know that SSH has a notion of stream types. Inbound, the
/// split matters: stderr is the server's diagnostics and the page must never
/// see it, because a length-prefixed protocol given a line of English decodes
/// garbage and blames the wire.
private final class ExecHandler: ChannelDuplexHandler {
    typealias InboundIn = SSHChannelData
    typealias InboundOut = Never
    typealias OutboundIn = ByteBuffer
    typealias OutboundOut = SSHChannelData

    private let command: String
    private let ready: (Result<Void, Error>) -> Void
    private let bytes: (Data) -> Void
    private let end: () -> Void
    private let log: (String) -> Void

    init(
        command: String,
        ready: @escaping (Result<Void, Error>) -> Void,
        bytes: @escaping (Data) -> Void,
        end: @escaping () -> Void,
        log: @escaping (String) -> Void
    ) {
        self.command = command
        self.ready = ready
        self.bytes = bytes
        self.end = end
        self.log = log
    }

    func channelActive(context: ChannelHandlerContext) {
        context.triggerUserOutboundEvent(SSHChannelRequestEvent.ExecRequest(command: command, wantReply: true))
            .whenFailure { [weak self] error in self?.ready(.failure(error)) }
        context.fireChannelActive()
    }

    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        switch event {
        case is ChannelSuccessEvent:
            // The command is running: this is the moment the far end became a
            // server rather than an ssh session.
            ready(.success(()))
        case is ChannelFailureEvent:
            ready(.failure(SSHFailure.commandRefused))
        case let status as SSHChannelRequestEvent.ExitStatus:
            // A server that exits is a server that said why on stderr a moment
            // ago, and the two lines together are the whole diagnosis.
            log("[ssh] ledge-server exited \(status.exitStatus)")
        case ChannelEvent.inputClosed:
            end()
        default:
            break
        }
        context.fireUserInboundEventTriggered(event)
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let payload = unwrapInboundIn(data)
        guard case .byteBuffer(let buffer) = payload.data else { return }
        if payload.type == .channel {
            bytes(Data(buffer.readableBytesView))
        } else if payload.type == .stdErr {
            let text = String(decoding: buffer.readableBytesView, as: UTF8.self)
            log("[ssh] \(text.trimmingCharacters(in: .whitespacesAndNewlines))")
        }
    }

    func write(context: ChannelHandlerContext, data: NIOAny, promise: EventLoopPromise<Void>?) {
        let buffer = unwrapOutboundIn(data)
        context.write(wrapOutboundOut(SSHChannelData(type: .channel, data: .byteBuffer(buffer))), promise: promise)
    }

    func channelInactive(context: ChannelHandlerContext) {
        // If the channel closed before the exec was answered, the dial failed
        // and nobody else is going to say so.
        ready(.failure(SSHFailure.cancelled))
        end()
        context.fireChannelInactive()
    }

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        log("[ssh] \(error)")
        ready(.failure(error))
        context.close(promise: nil)
    }
}
