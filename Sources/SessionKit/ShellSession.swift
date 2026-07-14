import Darwin
import Foundation

/// What the UI sees while a block runs.
public enum RunEvent: Sendable {
    case queued(blockId: String)
    case started(blockId: String)
    case output(blockId: String, data: Data)
    case finished(blockId: String, exitCode: Int32)
    /// The shell died. Every queued block is abandoned.
    case sessionEnded
}

/// One block, on its way to the shell.
public struct RunRequest: Sendable {
    public let blockId: String
    public let code: String
    public let language: String?

    public init(blockId: String, code: String, language: String? = nil) {
        self.blockId = blockId
        self.code = code
        self.language = language
    }
}

/// The live shell behind one note.
///
/// One persistent PTY-backed shell per note, and blocks run through it serially.
/// The shell *is* the state: cwd, environment, aliases, functions, and shell
/// variables persist between blocks because it is literally the same process.
/// There is no environment capture and replay anywhere in here, and there should
/// never be: that approach loses functions, loses subshell state, and races on
/// cwd. Keeping the real shell alive is simpler and correct.
public final class ShellSession: @unchecked Sendable {
    public let events: AsyncStream<RunEvent>

    private let nonce: String
    private let runners: RunnerTable
    private let scratch: URL
    private let continuation: AsyncStream<RunEvent>.Continuation

    /// Serializes all mutable state below. Every field after this line is only
    /// touched on this queue.
    private let queue = DispatchQueue(label: "sh.ledge.session")
    private var process: PTYProcess?
    private var parser: MarkerParser
    private var reader: DispatchSourceRead?
    private var pending: [RunRequest] = []
    private var running: RunRequest?
    private var isReady = false
    private var isClosed = false

    public struct Configuration: Sendable {
        public var shell: String
        public var arguments: [String]
        public var cwd: String?
        public var environment: [String: String]
        public var runners: RunnerTable

        public init(
            shell: String? = nil,
            arguments: [String]? = nil,
            cwd: String? = nil,
            environment: [String: String]? = nil,
            runners: RunnerTable = .default
        ) {
            // The user's own shell, as a login and interactive shell, so their
            // rc files run and their aliases and functions exist. That is the
            // whole point: the note should behave like their terminal.
            let resolved = shell ?? ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
            self.shell = resolved
            self.arguments = arguments ?? ["-l", "-i"]
            self.cwd = cwd
            var env = environment ?? ProcessInfo.processInfo.environment
            env["TERM"] = env["TERM"] ?? "xterm-256color"
            // A hook for the user's rc file, should they ever want to know.
            env["LEDGE"] = "1"
            self.environment = env
            self.runners = runners
        }
    }

    private let configuration: Configuration

    public init(configuration: Configuration = Configuration()) {
        self.configuration = configuration
        runners = configuration.runners
        nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        parser = MarkerParser(nonce: nonce)
        scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("ledge-\(nonce)", isDirectory: true)

        var cont: AsyncStream<RunEvent>.Continuation!
        events = AsyncStream { cont = $0 }
        continuation = cont
    }

    // MARK: - Lifecycle

    /// Start the shell. Called on the first run, not when a note opens: twenty
    /// open notes must not mean twenty shells, each having sourced a fat rc file.
    public func start() throws {
        try queue.sync {
            guard process == nil, !isClosed else { return }
            try FileManager.default.createDirectory(
                at: scratch,
                withIntermediateDirectories: true
            )

            let pty = try PTYProcess(
                executable: configuration.shell,
                // PTYProcess supplies argv[0]. Passing the shell path here too
                // would hand zsh its own binary as a script to run.
                arguments: configuration.arguments,
                environment: configuration.environment,
                cwd: configuration.cwd
            )
            process = pty

            let source = DispatchSource.makeReadSource(fileDescriptor: pty.masterFD, queue: queue)
            source.setEventHandler { [weak self] in self?.readAvailable() }
            source.setCancelHandler { [weak self] in self?.handleShellExit() }
            source.resume()
            reader = source
        }
    }

    public func close() {
        queue.sync {
            guard !isClosed else { return }
            isClosed = true
            reader?.cancel()
            reader = nil
            process?.terminate()
            process?.close()
            process = nil
            try? FileManager.default.removeItem(at: scratch)
            continuation.yield(.sessionEnded)
            continuation.finish()
        }
    }

    /// Ctrl-C: interrupt whatever is running right now.
    public func interrupt() {
        queue.sync { process?.interrupt() }
    }

    public func resize(columns: UInt16, rows: UInt16) {
        queue.sync { process?.resize(columns: columns, rows: rows) }
    }

    /// Type into the running block, for a command that prompts.
    public func send(_ input: String) {
        queue.sync { process?.write(input) }
    }

    // MARK: - Running blocks

    /// Queue a block. Blocks run one at a time, in order, through the one shell.
    public func run(_ request: RunRequest) {
        queue.async { [self] in
            guard !isClosed else { return }
            pending.append(request)
            continuation.yield(.queued(blockId: request.blockId))
            pump()
        }
    }

    /// Drop a block that has not started yet. Returns false if it is already
    /// running, which is what `interrupt()` is for.
    @discardableResult
    public func cancelQueued(blockId: String) -> Bool {
        queue.sync {
            guard let index = pending.firstIndex(where: { $0.blockId == blockId }) else {
                return false
            }
            pending.remove(at: index)
            return true
        }
    }

    private func pump() {
        guard running == nil, !pending.isEmpty, let process else { return }

        let request = pending.removeFirst()
        running = request

        guard let command = submission(for: request) else {
            // No runner for this language. Report it as a failure rather than
            // silently doing nothing.
            running = nil
            continuation.yield(.started(blockId: request.blockId))
            let message = "ledge: no runner configured for language '\(request.language ?? "")'\n"
            continuation.yield(.output(blockId: request.blockId, data: Data(message.utf8)))
            continuation.yield(.finished(blockId: request.blockId, exitCode: 127))
            pump()
            return
        }

        continuation.yield(.started(blockId: request.blockId))
        process.write(command)
    }

    /// Write the block body to a file and build the line we type at the shell.
    private func submission(for request: RunRequest) -> String? {
        let ext = runners.fileExtension(for: request.language)
        let file = scratch.appendingPathComponent("block-\(request.blockId).\(ext)")
        do {
            try request.code.write(to: file, atomically: true, encoding: .utf8)
        } catch {
            return nil
        }
        guard let runner = runners.command(for: request.language, path: file.path) else {
            return nil
        }
        return MarkerProtocol.command(
            runner: runner,
            nonce: nonce,
            blockId: request.blockId
        )
    }

    // MARK: - Reading

    private func readAvailable() {
        guard let process else { return }
        var buffer = [UInt8](repeating: 0, count: 8192)
        let n = read(process.masterFD, &buffer, buffer.count)

        guard n > 0 else {
            // 0 is EOF, and anything negative that is not EINTR/EAGAIN is fatal.
            if n == 0 || (errno != EINTR && errno != EAGAIN) {
                reader?.cancel()
            }
            return
        }

        isReady = true
        let chunk = Data(buffer[0 ..< n])
        if ProcessInfo.processInfo.environment["LEDGE_TRACE"] == "1" {
            // The raw byte channel. Debugging the marker protocol without this is
            // guesswork, so it is built in rather than added when needed.
            let dump = String(decoding: chunk, as: UTF8.self)
                .replacingOccurrences(of: "\u{1B}", with: "<ESC>")
                .replacingOccurrences(of: "\u{07}", with: "<BEL>")
            FileHandle.standardError.write(Data("[pty] \(dump)\n".utf8))
        }
        for event in parser.feed(chunk) {
            switch event {
            case let .began(blockId):
                continuation.yield(.started(blockId: blockId))

            case let .output(blockId, data):
                continuation.yield(.output(blockId: blockId, data: data))

            case let .ended(blockId, exitCode):
                continuation.yield(.finished(blockId: blockId, exitCode: exitCode))
                if running?.blockId == blockId {
                    running = nil
                    pump()
                }
            }
        }
    }

    private func handleShellExit() {
        guard !isClosed else { return }
        isClosed = true
        process?.close()
        process = nil
        pending.removeAll()
        running = nil
        continuation.yield(.sessionEnded)
        continuation.finish()
    }

    deinit {
        process?.terminate()
        process?.close()
        try? FileManager.default.removeItem(at: scratch)
    }
}
