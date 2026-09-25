import Foundation
import Testing

@testable import DailyDoListModels

/// The approval policy setting (`agent.approvalPolicy`): its wire values, what older and newer
/// daemons may send, and the patches that change it.
struct ApprovalPolicySettingsTests {
  @Test func theWireValuesAreTheDaemonsFromStrictestToLoosest() {
    #expect(
      ApprovalPolicy.allCases.map(\.rawValue) == [
        "ask_every_action", "ask_risky", "ask_high_risk", "run_everything",
      ])
    #expect(ApprovalPolicy.default == .askRisky)
    #expect(AgentSettings.defaults.approvalPolicy == .askRisky)
  }

  @Test func settingsFromADaemonOlderThanTheApprovalPolicyAskForRiskyActions() throws {
    let agent = try AgentHarnessSettingsTests.decodeAgent(["approvalPolicy": nil])
    #expect(agent.approvalPolicy == .askRisky)
  }

  @Test func aPolicyFromANewerDaemonDecodesAsTheDefault() throws {
    let agent = try AgentHarnessSettingsTests.decodeAgent(["approvalPolicy": "ask_payments"])
    #expect(agent.approvalPolicy == .askRisky)
  }

  @Test func aPolicyOfTheWrongTypeIsRejected() {
    #expect(throws: DecodingError.self) {
      try AgentHarnessSettingsTests.decodeAgent(["approvalPolicy": true])
    }
  }

  @Test(arguments: ApprovalPolicy.allCases)
  func everyPolicyRoundTrips(policy: ApprovalPolicy) throws {
    let agent = try AgentHarnessSettingsTests.decodeAgent([
      "approvalPolicy": .string(policy.rawValue)
    ])
    #expect(agent.approvalPolicy == policy)
    #expect(
      try JSONDecoder.daemon.decode(AgentSettings.self, from: JSONEncoder.daemon.encode(agent))
        == agent)
  }

  @Test func patchesCarryOnlyThePolicyAndRejectUnknownValues() throws {
    let patch = SettingsPatch(agent: .init(approvalPolicy: .runEverything))
    let json = try JSONDecoder.daemon.decode(JSONValue.self, from: JSONEncoder.daemon.encode(patch))
    #expect(json == ["agent": ["approvalPolicy": "run_everything"]])
    let applied = AppSettings.defaults.applying(patch)
    #expect(applied.agent.approvalPolicy == .runEverything)
    #expect(applied.agent.harness == .pi, "other agent settings are kept")
    #expect(AppSettings.defaults.applying(SettingsPatch()).agent.approvalPolicy == .askRisky)

    let unknown = Data(#"{"agent":{"approvalPolicy":"never_ask"}}"#.utf8)
    #expect(throws: DecodingError.self) {
      try JSONDecoder.daemon.decode(SettingsPatch.self, from: unknown)
    }
  }
}
