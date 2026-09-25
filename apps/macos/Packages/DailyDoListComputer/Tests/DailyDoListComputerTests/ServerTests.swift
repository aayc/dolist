import Foundation
import Testing

@testable import DailyDoListComputer

private final class Output: ResponseWriting, @unchecked Sendable {
  private let lock = NSLock()
  private var written: [String] = []

  var lines: [String] { lock.withLock { written } }

  func write(line: String) { lock.withLock { written.append(line) } }
}

private final class RecordingLog: HelperLogging, @unchecked Sendable {
  private let lock = NSLock()
  private var written: [String] = []

  var lines: [String] { lock.withLock { written } }

  func started(version: Int, pid: Int32) { append("started \(version)") }

  func handled(method: ComputerService.Method?, duration: Duration, error: ComputerError.Code?) {
    append(StandardErrorLog.line(method: method, duration: duration, error: error))
  }

  func inputClosed() { append("input closed") }
  func outputClosed() { append("output closed") }

  private func append(_ line: String) { lock.withLock { written.append(line) } }
}

@Suite("JSON-lines server")
struct RPCServerTests {
  @Test func answersRequestsInOrderWithTheirIds() async throws {
    let harness = Harness()
    let output = Output()
    let server = RPCServer(
      service: harness.makeService(), output: output, log: RecordingLog(), clock: harness.clock)
    let (lines, input) = AsyncStream.makeStream(of: InputLine.self)
    input.yield(.line(#"{"id":1,"method":"hello"}"#))
    input.yield(.line("   "))
    input.yield(.line(#"{"id":2,"method":"permissions"}"#))
    input.yield(.tooLong)
    input.yield(.line("{oops"))
    input.yield(.line(#"{"id":3,"method":"snapshot","params":{"pid":1}}"#))
    input.finish()

    await server.serve(lines)

    let responses = try output.lines.map { try #require(JSONValue.parse($0).objectValue) }
    #expect(responses.map { $0["id"] } == [1, 2, .null, .null, 3])
    #expect(responses[0].object("result") == ["version": 1, "pid": 900])
    #expect(responses[1].object("result") == ["accessibility": true, "screenRecording": true])
    #expect(responses[2].object("error")?.string("code") == "invalid")
    #expect(responses[4].object("error")?.string("code") == "not_found")
  }

  @Test func logsMethodsDurationsAndCodesButNeverContent() async throws {
    let harness = Harness()
    harness.runChat()
    let log = RecordingLog()
    let server = RPCServer(
      service: harness.makeService(), output: Output(), log: log, clock: harness.clock)
    let secret = "hunter2-correct-horse"
    _ = await server.respond(
      to: .line(#"{"id":1,"method":"typeText","params":{"pid":42,"text":"\#(secret)"}}"#))
    _ = await server.respond(
      to: .line(#"{"id":2,"method":"typeText","params":{"pid":42,"\#(secret)":"x"}}"#))
    _ = await server.respond(to: .line(#"{"id":3,"method":"\#(secret)"}"#))
    _ = await server.respond(to: .line(#"{"id":4,"method":"snapshot","params":{"pid":42}}"#))

    let withoutDurations = log.lines.map {
      $0.replacingOccurrences(of: #"\d+ms"#, with: "Nms", options: .regularExpression)
    }
    #expect(
      withoutDurations == [
        "typeText Nms ok", "typeText Nms error=invalid", "(invalid request) Nms error=invalid",
        "snapshot Nms ok",
      ])
    #expect(!log.lines.joined().contains("hunter2"))
    #expect(!log.lines.joined().contains("Chat"))
  }

  @Test func formatsLogLines() {
    #expect(
      StandardErrorLog.line(method: .snapshot, duration: .milliseconds(42), error: nil)
        == "snapshot 42ms ok")
    #expect(
      StandardErrorLog.line(method: .press, duration: .seconds(1.5), error: .stale)
        == "press 1500ms error=stale")
    #expect(
      StandardErrorLog.line(method: nil, duration: .zero, error: .invalid)
        == "(invalid request) 0ms error=invalid")
  }
}

@Suite("Line reader")
struct LineReaderTests {
  @Test func splitsLinesAcrossReads() {
    var reader = LineReader(maxLineBytes: 10)
    #expect(reader.append(Array("ab\ncd".utf8)) == [.line("ab")])
    #expect(reader.append(Array("e\r\n\n".utf8)) == [.line("cde"), .line("")])
    #expect(reader.append([0xC3]) == [], "the first byte of é")
    #expect(reader.append([0xA9, 0x0A]) == [.line("é")])
    #expect(reader.append(Array("tail".utf8)) == [])
    #expect(reader.finish() == [.line("tail")])
    #expect(reader.finish() == [])
  }

  @Test func reportsLongLinesAndSkipsThem() {
    var reader = LineReader(maxLineBytes: 10)
    #expect(reader.append(Array("0123456789ABC".utf8)) == [.tooLong])
    #expect(reader.append(Array("DEF\nok\n".utf8)) == [.line("ok")])
    #expect(reader.append(Array("0123456789ABC".utf8)) == [.tooLong])
    #expect(reader.finish() == [], "the rest of a long line is dropped")
  }
}
