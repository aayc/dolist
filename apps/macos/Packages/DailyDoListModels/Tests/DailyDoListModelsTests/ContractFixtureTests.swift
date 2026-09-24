import Foundation
import Testing

@testable import DailyDoListModels

/// Decodes every valid golden fixture of `@ddl/contract` (packages/contract/fixtures/wire) into the
/// matching Swift model and round-trips it, so the Swift client can't drift from the protocol.
struct ContractFixtureTests {
  static let fixturesDirectory: URL = {
    // .../apps/macos/Packages/DailyDoListModels/Tests/DailyDoListModelsTests/<this file>
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appendingPathComponent("../../../../../../packages/contract/fixtures/wire")
      .standardizedFileURL
  }()

  struct Case: Decodable {
    let name: String
    let value: JSONValue
  }

  static func cases(_ schema: String, _ suffix: String = "valid") throws -> [Case] {
    let url = fixturesDirectory.appendingPathComponent("\(schema).\(suffix).json")
    return try JSONDecoder().decode([Case].self, from: Data(contentsOf: url))
  }

  /// Decode → encode → decode must be stable, and every fixture must decode.
  static func check<T: Codable & Equatable>(_ type: T.Type, schema: String) throws {
    let cases = try cases(schema)
    #expect(!cases.isEmpty, "no fixtures for \(schema)")
    for fixture in cases {
      let data = try JSONEncoder.daemon.encode(fixture.value)
      let decoded: T
      do {
        decoded = try JSONDecoder.daemon.decode(T.self, from: data)
      } catch {
        Issue.record("\(schema) — \(fixture.name): \(error)")
        continue
      }
      let reencoded = try JSONEncoder.daemon.encode(decoded)
      let again = try JSONDecoder.daemon.decode(T.self, from: reencoded)
      #expect(again == decoded, "\(schema) — \(fixture.name) did not round-trip")
    }
  }

  @Test func serverEvents() throws { try Self.check(ServerEvent.self, schema: "ServerEvent") }
  @Test func clientEvents() throws { try Self.check(ClientEvent.self, schema: "ClientEvent") }
  @Test func threadResponses() throws { try Self.check(ThreadResponse.self, schema: "ThreadResponse") }
  @Test func taskRecords() throws { try Self.check(TaskAgentRecord.self, schema: "TaskAgentRecord") }
  @Test func settings() throws { try Self.check(AppSettings.self, schema: "AppSettings") }
  @Test func settingsPatches() throws { try Self.check(SettingsPatch.self, schema: "UpdateSettingsRequest") }
  @Test func health() throws { try Self.check(HealthResponse.self, schema: "HealthResponse") }
  @Test func conflicts() throws { try Self.check(ConflictResponse.self, schema: "ConflictResponse") }
  @Test func errors() throws { try Self.check(ApiErrorBody.self, schema: "ApiErrorBody") }
  @Test func threadActions() throws { try Self.check(ThreadActionResponse.self, schema: "ThreadActionResponse") }
  @Test func renames() throws { try Self.check(RenameRequest.self, schema: "RenameRequest") }
  @Test func folders() throws { try Self.check(CreateFolderRequest.self, schema: "CreateFolderRequest") }
  @Test func messages() throws { try Self.check(PostMessageRequest.self, schema: "PostMessageRequest") }
  @Test func decisions() throws { try Self.check(ApprovalDecisionRequest.self, schema: "ApprovalDecisionRequest") }
  @Test func agentEnabled() throws { try Self.check(SetAgentEnabledRequest.self, schema: "SetAgentEnabledRequest") }

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
      String(decoding: try JSONEncoder.daemon.encode(WriteNoteRequest(content: "x", baseVersion: base)), as: UTF8.self)
    }
    #expect(try encoded(.unconditional) == #"{"content":"x"}"#)
    #expect(try encoded(.createOnly) == #"{"baseVersion":null,"content":"x"}"#)
    #expect(try encoded(.match("v1")) == #"{"baseVersion":"v1","content":"x"}"#)
  }

  @Test func vaultPathEncodingMatchesEncodeURIComponent() {
    #expect(APIRoute.note("Daily/2026-09-23.md") == "/api/notes/Daily/2026-09-23.md")
    #expect(APIRoute.note("C# & notes/50% off?.md") == "/api/notes/C%23%20%26%20notes/50%25%20off%3F.md")
    #expect(APIRoute.encodeURIComponent("Café 日記 (1)!~*'") == "Caf%C3%A9%20%E6%97%A5%E8%A8%98%20(1)!~*'")
  }
}
