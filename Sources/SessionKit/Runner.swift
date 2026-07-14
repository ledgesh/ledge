import Foundation

/// How a fenced block's language becomes a command.
///
/// Shell blocks are *sourced*, not piped or executed as a subprocess. That is
/// what makes the session real: a `cd` or an `export` or a function definition
/// in one block is still there in the next one, because it happened in the same
/// shell. No environment capture, no replay, no drift.
///
/// Everything else is handed to an interpreter, which the shell launches. It
/// inherits cwd and environment from the shell for free, which is exactly how
/// these commands behave when you run them by hand.
public struct RunnerTable: Sendable {
    /// Languages that are the shell itself, and so get sourced.
    public var shellLanguages: Set<String>
    /// Everything else: language to interpreter argv.
    public var interpreters: [String: [String]]
    /// File extension per language, so `python3 x.py` looks like it should.
    public var fileExtensions: [String: String]

    public static let `default` = RunnerTable(
        shellLanguages: ["sh", "bash", "zsh", "shell", "console", "terminal"],
        interpreters: [
            "python": ["python3"],
            "python3": ["python3"],
            "ts": ["bun", "run"],
            "typescript": ["bun", "run"],
            "js": ["node"],
            "javascript": ["node"],
            "ruby": ["ruby"],
        ],
        fileExtensions: [
            "python": "py",
            "python3": "py",
            "ts": "ts",
            "typescript": "ts",
            "js": "js",
            "javascript": "js",
            "ruby": "rb",
        ]
    )

    public init(
        shellLanguages: Set<String>,
        interpreters: [String: [String]],
        fileExtensions: [String: String]
    ) {
        self.shellLanguages = shellLanguages
        self.interpreters = interpreters
        self.fileExtensions = fileExtensions
    }

    /// A block with no language is treated as shell, which is what a note that
    /// says ``` around a curl command means in practice.
    public func isShell(_ language: String?) -> Bool {
        guard let language, !language.isEmpty else { return true }
        return shellLanguages.contains(language)
    }

    public func canRun(_ language: String?) -> Bool {
        isShell(language) || interpreters[language ?? ""] != nil
    }

    public func fileExtension(for language: String?) -> String {
        guard let language else { return "sh" }
        return fileExtensions[language] ?? "sh"
    }

    /// The shell command that runs a block whose body is at `path`.
    public func command(for language: String?, path: String) -> String? {
        let quoted = "'" + path.replacingOccurrences(of: "'", with: #"'\''"#) + "'"
        if isShell(language) {
            return "source \(quoted)"
        }
        guard let language, let argv = interpreters[language] else { return nil }
        return (argv + [quoted]).joined(separator: " ")
    }
}
