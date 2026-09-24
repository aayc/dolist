import Foundation
import Testing

@testable import DailyDoListModels

/// Decodes every valid golden fixture of `@ddl/contract` into the matching Swift model and
/// round-trips it, so the Swift client can't drift from the protocol.
struct ContractFixtureTests {
  /// Decode → encode → decode must be stable, and every fixture must decode.
  static func check<T: Codable & Equatable>(_ type: T.Type, schema: String) throws {
    let cases = try Fixtures.cases(schema)
    #expect(!cases.isEmpty, "no fixtures for \(schema)")
    for fixture in cases {
      let decoded: T
      do {
        decoded = try Fixtures.decode(T.self, fixture.value)
      } catch {
        Issue.record("\(schema) — \(fixture.name): \(error)")
        continue
      }
      let reencoded = try JSONEncoder.daemon.encode(decoded)
      let again = try JSONDecoder.daemon.decode(T.self, from: reencoded)
      #expect(again == decoded, "\(schema) — \(fixture.name) did not round-trip")
    }
  }

  static let validSchemas = ((try? Fixtures.schemas(.valid)) ?? []).sorted()

  @Test(arguments: validSchemas)
  func validFixturesDecodeAndRoundTrip(schema: String) throws {
    let model = try #require(Fixtures.models[schema], "no Swift model for \(schema)")
    try Self.check(model, schema: schema)
  }

  @Test func everyFixtureFileHasASwiftModel() throws {
    let valid = try Fixtures.schemas(.valid)
    let invalid = try Fixtures.schemas(.invalid)
    #expect(valid.count >= 16, "fixtures not found at \(Fixtures.directory.path)")
    let unmapped = valid.union(invalid).subtracting(Fixtures.models.keys)
    #expect(unmapped.isEmpty, "fixture files without a Swift model: \(unmapped.sorted())")
    let stale = Set(Fixtures.models.keys).subtracting(valid.union(invalid))
    #expect(stale.isEmpty, "models mapped to missing fixture files: \(stale.sorted())")
  }

  /// Fixtures whose Swift re-encoding intentionally differs from the fixture JSON.
  static let reencodingExceptions: [String: String] = [
    "ClientEvent/hello (legacy, no version)": "Swift clients always send the apiVersion they speak"
  ]

  /// Fixtures are canonical: re-encoding a decoded value gives back the same JSON (no key is
  /// dropped, renamed or null-encoded differently).
  @Test(arguments: validSchemas)
  func validFixturesReencodeToTheSameJSON(schema: String) throws {
    let model = try #require(Fixtures.models[schema])
    for fixture in try Fixtures.cases(schema) {
      let reencoded = try Self.reencode(model, fixture.value)
      if Self.reencodingExceptions["\(schema)/\(fixture.name)"] != nil {
        #expect(reencoded != fixture.value, "\(schema) — \(fixture.name) is no longer an exception")
      } else {
        #expect(reencoded == fixture.value, "\(schema) — \(fixture.name) re-encodes differently")
      }
    }
  }

  static func reencode<T: Codable>(_ type: T.Type, _ value: JSONValue) throws -> JSONValue {
    let decoded = try Fixtures.decode(T.self, value)
    return try JSONDecoder.daemon.decode(JSONValue.self, from: JSONEncoder.daemon.encode(decoded))
  }

  @Test func unknownServerEventsAreTolerated() throws {
    let json = #"{"type":"task.deleted","taskId":"tsk_1"}"#
    let event = try JSONDecoder.daemon.decode(ServerEvent.self, from: Data(json.utf8))
    #expect(event.type == "task.deleted")
    guard case .unknown = event else {
      Issue.record("expected .unknown")
      return
    }
  }

  @Test func writeNoteBaseVersionEncodings() throws {
    func encoded(_ base: BaseVersion) throws -> String {
      String(
        decoding: try JSONEncoder.daemon.encode(WriteNoteRequest(content: "x", baseVersion: base)),
        as: UTF8.self)
    }
    #expect(try encoded(.unconditional) == #"{"content":"x"}"#)
    #expect(try encoded(.createOnly) == #"{"baseVersion":null,"content":"x"}"#)
    #expect(try encoded(.match("v1")) == #"{"baseVersion":"v1","content":"x"}"#)
  }

  @Test func writeNoteBaseVersionDecodings() throws {
    func decoded(_ json: String) throws -> BaseVersion {
      try JSONDecoder.daemon.decode(WriteNoteRequest.self, from: Data(json.utf8)).baseVersion
    }
    #expect(try decoded(#"{"content":"x"}"#) == .unconditional)
    #expect(try decoded(#"{"content":"x","baseVersion":null}"#) == .createOnly)
    #expect(try decoded(#"{"content":"x","baseVersion":"v1"}"#) == .match("v1"))
  }

  @Test func vaultPathEncodingMatchesEncodeURIComponent() {
    #expect(APIRoute.note("Daily/2026-09-23.md") == "/api/notes/Daily/2026-09-23.md")
    #expect(
      APIRoute.note("C# & notes/50% off?.md") == "/api/notes/C%23%20%26%20notes/50%25%20off%3F.md")
    #expect(
      APIRoute.encodeURIComponent("Café 日記 (1)!~*'") == "Caf%C3%A9%20%E6%97%A5%E8%A8%98%20(1)!~*'")
  }
}
