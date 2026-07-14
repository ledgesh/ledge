import Darwin
import Foundation

/// A child process attached to a pseudo-terminal.
///
/// We spawn the PTY ourselves rather than leaning on a terminal library, because
/// the things that go wrong here are process-group and controlling-terminal
/// problems: orphaned dev servers, a Ctrl-C that reaches nothing, a shell that
/// will not start its job control. Those are worth owning directly.
public final class PTYProcess {
    /// The master side. Write to it to type at the shell, read from it to see
    /// everything the shell and its children print.
    public let masterFD: Int32

    /// The child's pid. Because the child is a session leader, this is also its
    /// process group id, which is what lets us signal the whole job at once.
    public let pid: pid_t

    private var reaped = false

    public enum Failure: Error, CustomStringConvertible {
        case openpty(errno: Int32)
        case spawn(errno: Int32)

        public var description: String {
            switch self {
            case let .openpty(errno):
                "could not open a pseudo-terminal: \(String(cString: strerror(errno)))"
            case let .spawn(errno):
                "could not spawn the shell: \(String(cString: strerror(errno)))"
            }
        }
    }

    /// Spawn `executable` on a fresh PTY.
    public init(
        executable: String,
        arguments: [String],
        environment: [String: String],
        cwd: String?,
        columns: UInt16 = 120,
        rows: UInt16 = 30
    ) throws {
        var master: Int32 = 0
        var slave: Int32 = 0
        var size = winsize(ws_row: rows, ws_col: columns, ws_xpixel: 0, ws_ypixel: 0)

        guard openpty(&master, &slave, nil, nil, &size) == 0 else {
            throw Failure.openpty(errno: errno)
        }

        // The parent has no use for the slave fd, only for its path. The child
        // has to open it itself (see below), so hand the path over and let go.
        let slavePath = String(cString: ttyname(slave))
        Darwin.close(slave)

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }

        // The child opens the slave itself, rather than inheriting a dup of it.
        // This is the part that matters: combined with SETSID below, the first
        // terminal a session leader opens becomes its controlling terminal. Get
        // this wrong and the shell starts with no ctty, job control never turns
        // on, and Ctrl-C goes nowhere.
        posix_spawn_file_actions_addopen(&actions, 0, slavePath, O_RDWR, 0)
        posix_spawn_file_actions_adddup2(&actions, 0, 1)
        posix_spawn_file_actions_adddup2(&actions, 0, 2)
        posix_spawn_file_actions_addclose(&actions, master)

        var attrs: posix_spawnattr_t?
        posix_spawnattr_init(&attrs)
        defer { posix_spawnattr_destroy(&attrs) }
        // New session: the child leads its own process group, so we can signal
        // the whole tree later instead of just the shell.
        posix_spawnattr_setflags(&attrs, Int16(POSIX_SPAWN_SETSID))

        let argv: [String] = [executable] + arguments
        var cArgv: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) }
        cArgv.append(nil)
        var cEnv: [UnsafeMutablePointer<CChar>?] = environment
            .map { strdup("\($0.key)=\($0.value)") }
        cEnv.append(nil)
        defer {
            for p in cArgv where p != nil { free(p) }
            for p in cEnv where p != nil { free(p) }
        }

        // chdir in the child, not the parent: chdir(2) is process-wide, so doing
        // it here would move the whole app.
        if let cwd {
            posix_spawn_file_actions_addchdir_np(&actions, cwd)
        }

        var spawned: pid_t = 0
        let result = posix_spawn(&spawned, executable, &actions, &attrs, cArgv, cEnv)

        guard result == 0 else {
            Darwin.close(master)
            throw Failure.spawn(errno: result)
        }

        masterFD = master
        pid = spawned
    }

    /// Type at the shell.
    @discardableResult
    public func write(_ data: Data) -> Bool {
        data.withUnsafeBytes { buffer -> Bool in
            guard let base = buffer.baseAddress else { return false }
            var written = 0
            while written < buffer.count {
                let n = Darwin.write(masterFD, base.advanced(by: written), buffer.count - written)
                if n <= 0 {
                    if errno == EINTR { continue }
                    return false
                }
                written += n
            }
            return true
        }
    }

    public func write(_ string: String) {
        write(Data(string.utf8))
    }

    /// Tell the shell how wide its terminal is.
    public func resize(columns: UInt16, rows: UInt16) {
        var size = winsize(ws_row: rows, ws_col: columns, ws_xpixel: 0, ws_ypixel: 0)
        _ = ioctl(masterFD, TIOCSWINSZ, &size)
    }

    /// Interrupt whatever is running in the foreground, as Ctrl-C would.
    public func interrupt() {
        killpg(pid, SIGINT)
    }

    /// Shut the whole process group down. Nothing survives this, which is the
    /// point: a quit must not leave an orphaned dev server behind.
    public func terminate() {
        guard !reaped else { return }
        killpg(pid, SIGTERM)
    }

    public func kill() {
        guard !reaped else { return }
        killpg(pid, SIGKILL)
    }

    /// Reap the child and close the master. Safe to call more than once.
    public func close() {
        guard !reaped else { return }
        reaped = true
        var status: Int32 = 0
        waitpid(pid, &status, WNOHANG)
        Darwin.close(masterFD)
    }

    deinit {
        if !reaped { Darwin.close(masterFD) }
    }
}
