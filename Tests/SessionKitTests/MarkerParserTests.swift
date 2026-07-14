import Foundation
import Testing

@testable import SessionKit

/// These drive the parser with hand-built byte streams, so they need no shell
/// and are deterministic. The probe proves it works against a real zsh; these
/// pin the byte-level behavior so it cannot regress.

private let nonce = "testnonce"

private func began(_ id: String) -> Data {
    Data("\u{1B}]133;C;ledge=\(nonce):\(id)\u{07}".utf8)
}

private func ended(_ id: String, _ code: Int32) -> Data {
    Data("\u{1B}]133;D;\(code);ledge=\(nonce):\(id)\u{07}".utf8)
}

private func text(_ events: [MarkerEvent], _ id: String) -> String {
    let data = events.reduce(into: Data()) { acc, event in
        if case let .output(blockId, chunk) = event, blockId == id { acc.append(chunk) }
    }
    return String(decoding: data, as: UTF8.self)
}

@Test func attributesOutputBetweenMarkers() {
    var parser = MarkerParser(nonce: nonce)
    var stream = began("1")
    stream.append(Data("hello\n".utf8))
    stream.append(ended("1", 0))

    let events = parser.feed(stream)
    #expect(text(events, "1") == "hello\n")
    #expect(events.contains(.began(blockId: "1")))
    #expect(events.contains(.ended(blockId: "1", exitCode: 0)))
}

@Test func dropsOutputOutsideAnyBlock() {
    var parser = MarkerParser(nonce: nonce)
    // A prompt and an echoed command, then a real block.
    var stream = Data("dan@mac ~ % some prompt noise\n".utf8)
    stream.append(began("1"))
    stream.append(Data("real output\n".utf8))
    stream.append(ended("1", 0))

    let events = parser.feed(stream)
    #expect(text(events, "1") == "real output\n")
    // The prompt noise appears in no output event at all.
    let all = events.reduce(into: Data()) { acc, e in
        if case let .output(_, d) = e { acc.append(d) }
    }
    #expect(String(decoding: all, as: UTF8.self) == "real output\n")
}

@Test func capturesNonZeroExit() {
    var parser = MarkerParser(nonce: nonce)
    var stream = began("7")
    stream.append(ended("7", 42))
    let events = parser.feed(stream)
    #expect(events.contains(.ended(blockId: "7", exitCode: 42)))
}

@Test func handlesAMarkerSplitAcrossReads() {
    // The end marker arrives in three separate PTY reads. The parser must hold
    // the partial escape sequence and not emit it as output.
    var parser = MarkerParser(nonce: nonce)
    let end = ended("1", 0)

    var events = parser.feed(began("1") + Data("out".utf8))
    events += parser.feed(end.prefix(4))
    events += parser.feed(end.dropFirst(4).prefix(6))
    events += parser.feed(end.dropFirst(10))

    #expect(text(events, "1") == "out")
    #expect(events.contains(.ended(blockId: "1", exitCode: 0)))
}

@Test func partialEscapeAtEndOfReadIsNotEmittedAsOutput() {
    var parser = MarkerParser(nonce: nonce)
    var events = parser.feed(began("1"))
    // "ab" plus the first two bytes of an OSC sequence.
    events += parser.feed(Data("ab".utf8) + Data([0x1B, 0x5D]))
    // At this point only "ab" is safe to have emitted.
    #expect(text(events, "1") == "ab")

    // The rest of the marker arrives and closes the block.
    events += parser.feed(Data("133;D;0;ledge=\(nonce):1\u{07}".utf8))
    #expect(events.contains(.ended(blockId: "1", exitCode: 0)))
}

@Test func echoedCommandLineCannotForgeAMarker() {
    // The shell echoes the literal command we typed, which contains the text
    // "\033]133;C;..." as backslash-zero-three-three, not a real escape byte.
    // That echo, while a block is open, is output, never a marker.
    var parser = MarkerParser(nonce: nonce)
    var stream = began("1")
    stream.append(Data(#"printf '\033]133;D;0;ledge=testnonce:1\a'"#.utf8))
    stream.append(Data("\n".utf8))
    let events = parser.feed(stream)

    // The block is still open: no real end marker was seen.
    #expect(events.contains(.ended(blockId: "1", exitCode: 0)) == false)
    #expect(text(events, "1").contains("133;D"))
}

@Test func aForeignNonceIsIgnored() {
    var parser = MarkerParser(nonce: nonce)
    // A marker from some other shell integration, or another Ledge session.
    let foreign = Data("\u{1B}]133;C;ledge=someoneelse:1\u{07}".utf8)
    var stream = foreign
    stream.append(began("1"))
    stream.append(Data("mine\n".utf8))
    stream.append(ended("1", 0))

    let events = parser.feed(stream)
    #expect(events.contains(.began(blockId: "1")))
    #expect(text(events, "1") == "mine\n")
}

@Test func handlesStringTerminatorInsteadOfBell() {
    // OSC sequences may end with ESC-backslash instead of BEL.
    var parser = MarkerParser(nonce: nonce)
    let begin = Data("\u{1B}]133;C;ledge=\(nonce):1\u{1B}\\".utf8)
    let end = Data("\u{1B}]133;D;5;ledge=\(nonce):1\u{1B}\\".utf8)
    let events = parser.feed(begin + Data("x".utf8) + end)
    #expect(text(events, "1") == "x")
    #expect(events.contains(.ended(blockId: "1", exitCode: 5)))
}

@Test func routesTwoBlocksIndependently() {
    var parser = MarkerParser(nonce: nonce)
    var stream = began("1")
    stream.append(Data("first\n".utf8))
    stream.append(ended("1", 0))
    stream.append(Data("dan@mac ~ % \n".utf8)) // prompt between blocks
    stream.append(began("2"))
    stream.append(Data("second\n".utf8))
    stream.append(ended("2", 1))

    let events = parser.feed(stream)
    #expect(text(events, "1") == "first\n")
    #expect(text(events, "2") == "second\n")
    #expect(events.contains(.ended(blockId: "2", exitCode: 1)))
}

@Test func binarySafeAcrossChunkBoundaries() {
    // A multi-byte UTF-8 character split across two reads must survive: the
    // parser works on bytes and never decodes mid-character.
    var parser = MarkerParser(nonce: nonce)
    let emoji = Array("🧑‍🚀".utf8)
    var events = parser.feed(began("1"))
    events += parser.feed(Data(emoji.prefix(3)))
    events += parser.feed(Data(emoji.dropFirst(3)))
    events += parser.feed(ended("1", 0))
    #expect(text(events, "1") == "🧑‍🚀")
}
