import Foundation
import SessionKit

/// Headless driver for SessionKit.
///
/// The point of this tool is that the riskiest part of Ledge can be proven
/// without a window: spawn a real shell, run real blocks, and check that output
/// lands under the right block with the right exit code. If the marker protocol
/// is going to break on a fancy prompt or an rc file that prints things, it
/// breaks here, where the failure is legible.
///
///     make probe                  run the standard block sequence
///     .build/debug/LedgeProbe -v  also dump the raw PTY bytes

let verbose = CommandLine.arguments.contains("-v")

struct Block {
    let id: String
    let language: String?
    let code: String
    let expect: String
}

// Chosen to catch the specific things that go wrong here.
let blocks: [Block] = [
    Block(id: "1", language: "sh", code: "echo hello from ledge", expect: "output and exit 0"),
    Block(id: "2", language: "sh", code: "cd /tmp", expect: "no output, exit 0"),
    Block(
        id: "3",
        language: "sh",
        code: "pwd",
        expect: "/tmp, proving state persists across blocks"
    ),
    Block(id: "4", language: "sh", code: "export LEDGE_TEST=42", expect: "no output, exit 0"),
    Block(id: "5", language: "sh", code: "echo $LEDGE_TEST", expect: "42, proving env persists"),
    // A subshell exit, so we capture a non-zero code without killing the
    // session. Literal top-level `exit` in a sourced block ends the shell, which
    // is correct but tested separately, not here.
    Block(id: "6", language: "sh", code: "(exit 3)", expect: "exit code 3 (not 0)"),
    Block(
        id: "7",
        language: "sh",
        code: "ls --color=always /nonexistent 2>&1 || true",
        expect: "an error message, exit 0 from the || true"
    ),
    Block(id: "8", language: "sh", code: "printf 'a\\nb\\nc\\n'", expect: "three lines"),
    Block(id: "9", language: "python", code: "print('hi from python')", expect: "python runs"),
]

/// Shared collection state, lock-guarded so the event consumer can run on any
/// thread while the main thread blocks waiting for completion. The earlier
/// version made this a MainActor task and then blocked main on a semaphore,
/// which deadlocked: the consumer could never be scheduled.
final class Collector: @unchecked Sendable {
    private let lock = NSLock()
    private var collected: [String: Data] = [:]
    private var exitCodes: [String: Int32] = [:]
    private var finished = Set<String>()
    private let total: Int
    let done = DispatchSemaphore(value: 0)

    init(total: Int) { self.total = total }

    func append(_ id: String, _ data: Data) {
        lock.lock(); defer { lock.unlock() }
        collected[id, default: Data()].append(data)
    }

    func finish(_ id: String, _ code: Int32) {
        lock.lock()
        exitCodes[id] = code
        finished.insert(id)
        let complete = finished.count == total
        lock.unlock()
        if complete { done.signal() }
    }

    func sessionEnded() { done.signal() }

    func text(_ id: String) -> String {
        lock.lock(); defer { lock.unlock() }
        // A PTY emits CRLF line endings. A terminal treats CR as "cursor to
        // column zero"; for plain text we drop it, which is what the editor's
        // static output view will do too.
        return (collected[id].map { String(decoding: $0, as: UTF8.self) } ?? "")
            .replacingOccurrences(of: "\r\n", with: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func exitCode(_ id: String) -> Int32? {
        lock.lock(); defer { lock.unlock() }
        return exitCodes[id]
    }

    var finishedCount: Int {
        lock.lock(); defer { lock.unlock() }
        return finished.count
    }
}

let session = ShellSession(configuration: .init(cwd: NSHomeDirectory()))
let collector = Collector(total: blocks.count)

Task.detached {
    for await event in session.events {
        switch event {
        case let .queued(id):
            if verbose { FileHandle.standardError.write(Data("[queued \(id)]\n".utf8)) }
        case let .started(id):
            if verbose { FileHandle.standardError.write(Data("[started \(id)]\n".utf8)) }
        case let .output(id, data):
            collector.append(id, data)
        case let .finished(id, code):
            collector.finish(id, code)
        case .sessionEnded:
            collector.sessionEnded()
        }
    }
}

do {
    try session.start()
} catch {
    FileHandle.standardError.write(Data("failed to start shell: \(error)\n".utf8))
    exit(1)
}

for block in blocks {
    session.run(RunRequest(blockId: block.id, code: block.code, language: block.language))
}

if collector.done.wait(timeout: .now() + 30) == .timedOut {
    print("TIMED OUT waiting for blocks to finish")
    print("finished: \(collector.finishedCount) of \(blocks.count)")
}

print("")
print("shell: \(ProcessInfo.processInfo.environment["SHELL"] ?? "?")")
print(String(repeating: "=", count: 72))

var failures = 0
for block in blocks {
    let output = collector.text(block.id)
    let code = collector.exitCode(block.id)

    print("")
    print("block \(block.id)  [\(block.language ?? "sh")]  \(block.code)")
    print("  expect: \(block.expect)")
    print("  exit:   \(code.map(String.init) ?? "NEVER FINISHED")")
    if code == nil { failures += 1 }

    if output.isEmpty {
        print("  output: (none)")
    } else {
        for line in output.split(separator: "\n", omittingEmptySubsequences: false) {
            print("  output: \(line)")
        }
    }
}

print("")
print(String(repeating: "=", count: 72))

final class Counter: @unchecked Sendable { var value = 0 }
nonisolated(unsafe) let checkFailures = Counter()
func check(_ label: String, _ passed: Bool) {
    print("\(passed ? "PASS" : "FAIL")  \(label)")
    if !passed { checkFailures.value += 1 }
}

check("output is attributed to the right block", collector.text("1") == "hello from ledge")
check("a silent block produces no output", collector.text("2").isEmpty)
check("cwd persists across blocks", collector.text("3") == "/tmp")
check("environment persists across blocks", collector.text("5") == "42")
check("exit codes are captured", collector.exitCode("6") == 3)
check("zero exit is captured", collector.exitCode("1") == 0)
check("multi-line output stays intact", collector.text("8") == "a\nb\nc")
check("prompt noise does not leak into output", !collector.text("1").contains("$"))
check("a non-shell language runs", collector.text("9") == "hi from python")

session.close()

print("")
let total = failures + checkFailures.value
if total == 0 {
    print("all checks passed")
    exit(0)
} else {
    print("\(total) check(s) failed")
    exit(1)
}
