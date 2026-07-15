import Foundation
import LedgeMarkdown
import Observation
import SessionKit

/// Where a block's output goes when it runs.
public enum RunDestination: Sendable {
    /// Sliced by the marker protocol and shown in a panel under the block.
    case inline
    /// Typed into the note's shell like a command, shown in the terminal drawer.
    case terminalPane

    public var label: String {
        switch self {
        case .inline: "Inline"
        case .terminalPane: "Terminal"
        }
    }
}

/// The run state of a single code block.
@MainActor
@Observable
public final class BlockRun: Identifiable {
    public enum State: Equatable {
        case idle
        case queued
        case running
        case finished(exitCode: Int32)
        case sessionEnded

        /// A stable per-case number, so a layout signature can notice a state
        /// transition (which changes what the decoration draws) without caring
        /// about the exit code.
        var ordinal: Int {
            switch self {
            case .idle: 0
            case .queued: 1
            case .running: 2
            case .finished: 3
            case .sessionEnded: 4
            }
        }
    }

    public let id: String
    public internal(set) var state: State = .idle
    /// Everything the block has printed, with markers already stripped. Fed to
    /// the terminal view as it arrives, and kept so the view can be rebuilt.
    public internal(set) var output = Data()
    public internal(set) var startedAt: Date?
    public internal(set) var finishedAt: Date?

    /// A monotonically increasing counter, bumped on every appended chunk, so a
    /// SwiftUI view can observe "there is new output" without diffing Data.
    public internal(set) var revision = 0

    init(id: String) {
        self.id = id
    }

    var isActive: Bool {
        switch state {
        case .queued, .running: true
        default: false
        }
    }

    var duration: TimeInterval? {
        guard let startedAt, let finishedAt else { return nil }
        return finishedAt.timeIntervalSince(startedAt)
    }
}

/// Owns a note's live shell and the run state of its blocks.
///
/// Created lazily: a note that is only being read never spawns a shell. The
/// first run is what brings the session up, which is why opening twenty notes
/// costs zero shell processes.
@MainActor
@Observable
public final class NoteRuntime {
    /// Run state keyed by block run id. A block can be run more than once; each
    /// run gets a fresh id, and this holds the latest run per block index.
    public private(set) var runs: [String: BlockRun] = [:]

    /// The seed the session starts from. Later this comes from frontmatter.
    public var cwd: String?

    /// The whole shell transcript, verbatim, for the terminal drawer. This is the
    /// raw PTY torrent (prompt, echo, block output, anything typed) accumulated so
    /// a drawer opened late still shows the history, then fed new bytes as they
    /// arrive. Reset when the shell restarts, so it reflects the live process.
    public private(set) var terminalOutput = Data()

    /// Bumped on every appended chunk (and reset), so the drawer can observe "new
    /// terminal bytes" without diffing Data.
    public private(set) var terminalRevision = 0

    /// Forwarded every run event, so the web editor can render inline output.
    /// The web owns the editor surface now; this is how native run state reaches
    /// it. Runs started via `runForWeb` are keyed by the web's own id.
    public var onRunEvent: ((RunEvent) -> Void)?

    private var session: ShellSession?
    private var eventTask: Task<Void, Never>?
    private var rawTask: Task<Void, Never>?
    private var runIndexForBlock: [Int: String] = [:]
    private var webTerminalCounter = 0

    public init(cwd: String? = nil) {
        self.cwd = cwd
    }

    /// The latest run for a block at a given document index, if any.
    public func run(forBlockAt index: Int) -> BlockRun? {
        guard let id = runIndexForBlock[index] else { return nil }
        return runs[id]
    }

    /// A value that changes whenever anything a decoration draws changes: new
    /// output, a state transition, or a fresh run appearing. Reading this from a
    /// view body subscribes the view (via `@Observable`) to exactly those
    /// changes, so the editor re-lays-out its output when it must and stays idle
    /// otherwise. This is what replaces a polling timer.
    public var layoutRevision: Int {
        runs.values.reduce(into: 0) { acc, run in
            acc &+= run.revision
            acc &+= run.state.ordinal
        }
    }

    /// Whether the session is currently alive.
    public var isSessionLive: Bool { session != nil }

    /// Run a block. Spawns the shell on first use.
    ///
    /// `index` is the block's position in the document, used only to associate
    /// the run with a UI slot. The run itself is identified by a fresh unique id
    /// so its output never collides with a previous run of the same block.
    public func run(_ block: CodeBlock, index: Int, code: String) {
        let session = ensureSession()

        let runId = "\(index)-\(runs.count)-\(UInt32.random(in: .min ... .max))"
        let run = BlockRun(id: runId)
        run.state = .queued
        runs[runId] = run
        runIndexForBlock[index] = runId

        session.run(RunRequest(blockId: runId, code: code, language: block.language))
    }

    /// Run a block for the web editor, tagged with the web's own id so the events
    /// it streams back can be matched to the right inline panel. Not tracked as a
    /// `BlockRun`; the web holds the output. Output still flows through the marker
    /// protocol, so it is sliced per id and forwarded via `onRunEvent`.
    public func runForWeb(id: String, code: String, language: String?) {
        ensureSession().run(RunRequest(blockId: id, code: code, language: language))
    }

    /// Run a block in the terminal drawer for the web editor: types the runner
    /// command into the shell, output appears in the drawer, no inline panel.
    public func runInTerminalForWeb(code: String, language: String?) {
        webTerminalCounter += 1
        let request = RunRequest(blockId: "term-web-\(webTerminalCounter)", code: code, language: language)
        ensureSession().runInTerminal(request)
    }

    /// Run a block in the terminal drawer instead of inline: the runner command
    /// is typed into the shell like any other command, so its output (and any
    /// prompt it shows) lives in the drawer and can be interacted with. Unlike
    /// `run`, this is not tracked as a `BlockRun`; the terminal is the output.
    public func runInTerminal(_ block: CodeBlock, index: Int, code: String) {
        // The block's output now lives in the drawer, so drop any inline panel
        // left over from a previous inline run of the same block.
        if let stale = runIndexForBlock.removeValue(forKey: index) {
            runs.removeValue(forKey: stale)
        }
        let request = RunRequest(
            blockId: "term-\(index)-\(runs.count)",
            code: code,
            language: block.language
        )
        ensureSession().runInTerminal(request)
    }

    /// Dismiss a block's inline output. Drops the run so the panel and its
    /// reserved space go away; the block can be run again to bring it back.
    public func clearRun(forBlockAt index: Int) {
        guard let id = runIndexForBlock.removeValue(forKey: index) else { return }
        runs.removeValue(forKey: id)
    }

    /// Interrupt whatever is currently running.
    public func interrupt() {
        session?.interrupt()
    }

    // MARK: - Terminal drawer

    /// Bring the shell up so the drawer has a live prompt to talk to, even before
    /// any block has run. Opening the drawer calls this.
    public func activateTerminal() {
        _ = ensureSession()
    }

    /// Raw keystrokes from the drawer straight to the shell. Starts the shell if
    /// the drawer is the first thing the user touches.
    public func sendToTerminal(_ data: Data) {
        ensureSession().send(data)
    }

    /// The drawer's terminal was resized; tell the shell its new dimensions.
    public func resizeTerminal(columns: UInt16, rows: UInt16) {
        session?.resize(columns: columns, rows: rows)
    }

    public func shutdown() {
        eventTask?.cancel()
        eventTask = nil
        rawTask?.cancel()
        rawTask = nil
        session?.close()
        session = nil
    }

    // MARK: - Session

    private func ensureSession() -> ShellSession {
        if let session { return session }

        let expanded = cwd.map { ($0 as NSString).expandingTildeInPath }
        let new = ShellSession(configuration: .init(cwd: expanded))
        session = new

        // A fresh shell means a fresh transcript: the drawer should show this
        // process, not the ghost of a previous one that ended.
        terminalOutput.removeAll(keepingCapacity: true)
        terminalRevision &+= 1

        // Drain the event stream on the main actor: every field it touches is
        // main-actor isolated observable state.
        eventTask = Task { [weak self] in
            for await event in new.events {
                self?.apply(event)
            }
        }

        // The raw torrent feeds the terminal drawer. Kept separate from `events`
        // so the drawer's verbatim mirror and the per-block slicing never contend.
        rawTask = Task { [weak self] in
            for await chunk in new.rawOutput {
                self?.appendTerminal(chunk)
            }
        }

        do {
            try new.start()
        } catch {
            // Surface the failure on whatever is queued rather than hanging.
            for run in runs.values where run.isActive {
                run.state = .sessionEnded
            }
        }
        return new
    }

    private func appendTerminal(_ chunk: Data) {
        terminalOutput.append(chunk)
        terminalRevision &+= 1
    }

    private func apply(_ event: RunEvent) {
        // The web editor is the inline-output surface; forward everything to it.
        onRunEvent?(event)

        switch event {
        case let .queued(id):
            runs[id]?.state = .queued

        case let .started(id):
            let run = runs[id]
            run?.state = .running
            run?.startedAt = Date()

        case let .output(id, data):
            guard let run = runs[id] else { return }
            run.output.append(data)
            run.revision &+= 1

        case let .finished(id, code):
            let run = runs[id]
            run?.state = .finished(exitCode: code)
            run?.finishedAt = Date()

        case .sessionEnded:
            for run in runs.values where run.isActive {
                run.state = .sessionEnded
            }
            session = nil
        }
    }
}
