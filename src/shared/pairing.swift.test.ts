// The phone's pairing code reader (ios/Sources/PairingCode.swift) against the
// vectors shared/pairing.ts answers to (remote.md §4b), and the reader's pin rule
// against the stored servers. Android's reader answers the same file in a Gradle
// unit test (android/app/src/test/.../PairingCodeTest.kt). The iOS package has no test target, so this
// compiles the one file with a small driver for the Mac running the suite and
// compares what it prints. That takes about two seconds.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PairingCode } from "./pairing";
import vectorFile from "./pairing.vectors.json";

type Vector = { name: string; link: string; code?: PairingCode; problem?: string };
const vectors: Vector[] = vectorFile.vectors;

type Known = { id: string; destination: string; port: number; fingerprint: string };
type Match = { new: true } | { pinned: string } | { unpinned: string } | { conflict: string };

const SOURCE = join(import.meta.dir, "..", "..", "ios", "Sources", "PairingCode.swift");

const DRIVER = `
import Foundation
let input = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
let reads: [[String: Any]] = (input["links"] as! [String]).map { link in
    switch PairingCode.read(link) {
    case .code(let code):
        return ["code": ["user": code.user, "host": code.host, "port": code.port, "fingerprints": code.fingerprints]]
    case .problem(let problem):
        return ["problem": problem]
    }
}
let matches: [[String: Any]] = (input["matches"] as! [[String: Any]]).map { item in
    guard case .code(let code) = PairingCode.read(item["link"] as! String) else { return ["unread": true] }
    let known = (item["known"] as! [[String: Any]]).map {
        PairingCode.Known(id: $0["id"] as! String, destination: $0["destination"] as! String, port: $0["port"] as! Int, fingerprint: $0["fingerprint"] as! String)
    }
    switch code.match(known) {
    case .new: return ["new": true]
    case .pinned(let id): return ["pinned": id]
    case .unpinned(let id): return ["unpinned": id]
    case .conflict(let pinned): return ["conflict": pinned]
    }
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: ["reads": reads, "matches": matches]))
`;

// The pin rule's cases, in the vector file so PairingCode.kt answers the same
// ones (PairingCodeTest).
const LINK: string = vectorFile.matches.link;
const matchCases = vectorFile.matches.cases as { name: string; known: Known[]; expected: Match }[];

function runSwift(): { reads: unknown[]; matches: unknown[] } {
  const dir = mkdtempSync(join(tmpdir(), "ledge-pairing-swift-"));
  try {
    writeFileSync(join(dir, "main.swift"), DRIVER);
    const input = { links: vectors.map((v) => v.link), matches: matchCases.map((c) => ({ link: LINK, known: c.known })) };
    writeFileSync(join(dir, "input.json"), JSON.stringify(input));
    const binary = join(dir, "read");
    const compile = Bun.spawnSync(["swiftc", "-o", binary, SOURCE, join(dir, "main.swift")], { stderr: "pipe" });
    if (compile.exitCode !== 0) throw new Error(`swiftc failed:\n${compile.stderr.toString()}`);
    const run = Bun.spawnSync([binary, join(dir, "input.json")], { stdout: "pipe", stderr: "pipe" });
    if (run.exitCode !== 0) throw new Error(`the Swift reader failed:\n${run.stderr.toString()}`);
    return JSON.parse(run.stdout.toString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// At load, outside any test, so the compile is not held to a test's timeout.
// Linux has no swiftc, and the server suite also runs there (remote.md §13). A
// Mac without one fails here rather than skipping.
const onMac = process.platform === "darwin";
const results = onMac ? runSwift() : { reads: [], matches: [] };

describe.skipIf(!onMac)("the Swift reader agrees with the vectors", () => {
  test.each(vectors.map((v, i) => [v.name, v, i] as const))("%s", (_name, vector, i) => {
    expect(results.reads[i]).toEqual(vector.code ? { code: vector.code } : { problem: vector.problem! });
  });
});

describe.skipIf(!onMac)("a code never replaces a pin the phone already has", () => {
  test.each(matchCases.map((c, i) => [c.name, c, i] as const))("%s", (_name, c, i) => {
    expect(results.matches[i]).toEqual(c.expected);
  });
});
