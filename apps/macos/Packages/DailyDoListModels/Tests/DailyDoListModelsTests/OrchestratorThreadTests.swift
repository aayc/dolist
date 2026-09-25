import Foundation
import Testing

@testable import DailyDoListModels

/// The orchestrator's chat is addressed by a well-known id; it must match the contract's.
struct OrchestratorThreadTests {
  static let wireSchema: URL = Fixtures.directory
    .appendingPathComponent("../../schema/wire.schema.json")
    .standardizedFileURL

  @Test func idMatchesTheContract() throws {
    let schema = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: Self.wireSchema))
    guard case .object(let root) = schema, case .object(let defs)? = root["$defs"],
      case .object(let definition)? = defs["OrchestratorThreadId"],
      case .string(let id)? = definition["const"]
    else {
      Issue.record("OrchestratorThreadId is missing from \(Self.wireSchema.path)")
      return
    }
    #expect(id == OrchestratorThread.id)
  }

  @Test func theFixtureDecodesAsTheOrchestratorsChat() throws {
    let fixture = try #require(
      try Fixtures.cases("ThreadResponse").first { $0.name == "the orchestrator's chat" })
    let response = try Fixtures.decode(ThreadResponse.self, fixture.value)
    #expect(response.thread.isOrchestrator)
    #expect(response.thread.taskId == nil)
    #expect(response.thread.title == OrchestratorThread.title)
    let taskIds = response.thread.messages.compactMap { message -> String? in
      guard case .toolCall(let call) = message, case .object(let input) = call.input,
        case .string(let taskId)? = input["taskId"]
      else { return nil }
      return taskId
    }
    #expect(taskIds == ["tsk_a1b2c3d4e5", "tsk_b2c3d4e5f6"])
  }
}
