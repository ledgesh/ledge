import Foundation
import LedgeMarkdown
import Observation
import SessionKit

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

    private var session: ShellSession?
    private var eventTask: Task<Void, Never>?
    private var runIndexForBlock: [Int: String] = [:]

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

    /// Interrupt whatever is currently running.
    public func interrupt() {
        session?.interrupt()
    }

    public func shutdown() {
        eventTask?.cancel()
        eventTask = nil
        session?.close()
        session = nil
    }

    // MARK: - Session

    private func ensureSession() -> ShellSession {
        if let session { return session }

        let expanded = cwd.map { ($0 as NSString).expandingTildeInPath }
        let new = ShellSession(configuration: .init(cwd: expanded))
        session = new

        // Drain the event stream on the main actor: every field it touches is
        // main-actor isolated observable state.
        eventTask = Task { [weak self] in
            for await event in new.events {
                self?.apply(event)
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

    private func apply(_ event: RunEvent) {
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
