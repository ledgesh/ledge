// The phone's pairing code reader (ios/Sources/PairingCode.swift) against the
// vectors shared/pairing.ts answers to (remote.md §4b). The iOS package has no
// test target, so this compiles the one file with a small driver for the Mac
// running the suite and compares what it prints. That takes about two seconds.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PairingCode } from "./pairing";
import vectorFile from "./pairing.vectors.json";

type Vector = { name: string; link: string; code?: PairingCode; problem?: string };
const vectors: Vector[] = vectorFile.vectors;

const SOURCE = join(import.meta.dir, "..", "..", "ios", "Sources", "PairingCode.swift");

const DRIVER = `
import Foundation
let links = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String]
let results: [[String: Any]] = links.map { link in
    switch PairingCode.read(link) {
    case .code(let code):
        return ["code": ["user": code.user, "host": code.host, "port": code.port, "fingerprints": code.fingerprints]]
    case .problem(let problem):
        return ["problem": problem]
    }
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: results))
`;

function readInSwift(links: string[]): unknown[] {
  const dir = mkdtempSync(join(tmpdir(), "ledge-pairing-swift-"));
  try {
    writeFileSync(join(dir, "main.swift"), DRIVER);
    writeFileSync(join(dir, "links.json"), JSON.stringify(links));
    const binary = join(dir, "read");
    const compile = Bun.spawnSync(["swiftc", "-o", binary, SOURCE, join(dir, "main.swift")], { stderr: "pipe" });
    if (compile.exitCode !== 0) throw new Error(`swiftc failed:\n${compile.stderr.toString()}`);
    const run = Bun.spawnSync([binary, join(dir, "links.json")], { stdout: "pipe", stderr: "pipe" });
    if (run.exitCode !== 0) throw new Error(`the Swift reader failed:\n${run.stderr.toString()}`);
    return JSON.parse(run.stdout.toString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// At load, outside any test, so the compile is not held to a test's timeout.
const results = readInSwift(vectors.map((v) => v.link));

describe("the Swift reader agrees with the vectors", () => {
  test.each(vectors.map((v, i) => [v.name, v, i] as const))("%s", (_name, vector, i) => {
    expect(results[i]).toEqual(vector.code ? { code: vector.code } : { problem: vector.problem! });
  });
});
