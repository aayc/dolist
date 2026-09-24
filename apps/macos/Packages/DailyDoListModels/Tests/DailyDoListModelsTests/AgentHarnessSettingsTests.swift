import Foundation
import Testing

@testable import DailyDoListModels

/// The agent harness setting (`agent.harness`, `agent.cursorModel`): what older and newer daemons
/// may send, and the patches that change it.
struct AgentHarnessSettingsTests {
  /// The daemon's default agent settings as JSON, with `changes` applied (`nil` drops a key).
  static func agentJSON(_ changes: [String: JSONValue?]) throws -> JSONValue {
    guard
      case .object(var agent) = try JSONDecoder.daemon.decode(
        JSONValue.self, from: JSONEncoder.daemon.encode(AgentSettings.defaults))
    else { throw CocoaError(.coderInvalidValue) }
    for (key, value) in changes { agent[key] = value }
    return .object(agent)
  }

  static func decodeAgent(_ changes: [String: JSONValue?]) throws -> AgentSettings {
    try JSONDecoder.daemon.decode(
      AgentSettings.self, from: JSONEncoder.daemon.encode(agentJSON(changes)))
  }

  @Test func defaultsToPiWithTheDefaultCursorModel() {
    #expect(AgentSettings.defaults.harness == .pi)
    #expect(AgentSettings.defaults.cursorModel == "claude-opus-5-5")
    #expect(AgentSettings.defaults.agentModel == AgentSettings.defaultModel)
  }

  @Test func settingsFromADaemonOlderThanTheHarnessSettingDecodeAsPi() throws {
    let agent = try Self.decodeAgent([
      "harness": nil, "cursorModel": nil, "model": "vendor/model-a",
    ])
    #expect(agent.harness == .pi)
    #expect(agent.cursorModel == AgentSettings.defaultCursorModel)
    #expect(agent.agentModel == "vendor/model-a")
  }

  @Test func aHarnessFromANewerDaemonDecodesAsPi() throws {
    let agent = try Self.decodeAgent(["harness": "claude", "cursorModel": "gpt-6"])
    #expect(agent.harness == .pi)
    #expect(agent.cursorModel == "gpt-6")
  }

  @Test func aHarnessOfTheWrongTypeIsRejected() {
    #expect(throws: DecodingError.self) { try Self.decodeAgent(["harness": 1]) }
    #expect(throws: DecodingError.self) { try Self.decodeAgent(["cursorModel": false]) }
  }

  @Test func theCursorHarnessRunsOnTheCursorModel() throws {
    let agent = try Self.decodeAgent([
      "harness": "cursor", "cursorModel": "gpt-5.5[reasoning=high]",
    ])
    #expect(agent.harness == .cursor)
    #expect(agent.agentModel == "gpt-5.5[reasoning=high]")
    #expect(
      try JSONDecoder.daemon.decode(AgentSettings.self, from: JSONEncoder.daemon.encode(agent))
        == agent)
  }

  @Test func patchesCarryOnlyTheHarnessFieldsTheyChange() throws {
    let patch = SettingsPatch(agent: .init(harness: .cursor, cursorModel: "gpt-5.5"))
    let json = try JSONDecoder.daemon.decode(JSONValue.self, from: JSONEncoder.daemon.encode(patch))
    #expect(json == ["agent": ["harness": "cursor", "cursorModel": "gpt-5.5"]])

    let applied = AppSettings.defaults.applying(patch)
    #expect(applied.agent.harness == .cursor && applied.agent.cursorModel == "gpt-5.5")
    #expect(applied.agent.model == AgentSettings.defaultModel, "the OpenRouter model is kept")
    let back = applied.applying(SettingsPatch(agent: .init(harness: .pi, model: "vendor/model-a")))
    #expect(back.agent.agentModel == "vendor/model-a" && back.agent.cursorModel == "gpt-5.5")
  }
}
