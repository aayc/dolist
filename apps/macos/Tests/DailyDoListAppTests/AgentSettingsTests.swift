import DailyDoListModels
import Testing

@testable import DailyDoListApp

@Suite("Agent settings")
struct AgentSettingsTests {
  @Test func theHarnessChoicesAreLabeledForPeople() {
    #expect(AgentHarnessKind.allCases.map(\.settingsLabel) == ["Pi · OpenRouter model", "Cursor CLI · your Cursor account"])
  }

  @Test func theModelFieldIsTheConfiguredHarnesssModel() {
    var agent = AgentSettings.defaults
    agent.model = "vendor/model-a"
    agent.cursorModel = "gpt-5.5"
    let pi = AgentModelField(agent)
    #expect(pi.title == "OpenRouter model" && pi.value == "vendor/model-a" && pi.prompt == AgentSettings.defaultModel)
    #expect(pi.patch("vendor/model-b") == SettingsPatch.AgentPatch(model: "vendor/model-b"))

    agent.harness = .cursor
    let cursor = AgentModelField(agent)
    #expect(cursor.title == "Cursor model" && cursor.value == "gpt-5.5" && cursor.prompt == "composer-2.5")
    #expect(cursor.note.contains("agent --list-models"))
    #expect(cursor.patch("gpt-5.5[reasoning=high]") == SettingsPatch.AgentPatch(cursorModel: "gpt-5.5[reasoning=high]"))
  }

  @Test func requiredFieldsCommitTrimmedTextAndNeverBlankText() {
    #expect(CommitTextField.committed("  gpt-5.5\t", value: "composer-2.5", required: true) == "gpt-5.5")
    #expect(CommitTextField.committed("composer-2.5 ", value: "composer-2.5", required: true) == nil)
    #expect(CommitTextField.committed("   ", value: "composer-2.5", required: true) == nil)
    #expect(CommitTextField.committed("", value: "composer-2.5", required: true) == nil)
  }

  @Test func otherFieldsCommitAnyChangeAsTyped() {
    #expect(CommitTextField.committed("", value: "Daily", required: false) == "")
    #expect(CommitTextField.committed(" Journal ", value: "Daily", required: false) == " Journal ")
    #expect(CommitTextField.committed("Daily", value: "Daily", required: false) == nil)
  }

  @MainActor
  @Test func switchingTheHarnessAndItsModelIsSavedAndEachHarnessKeepsItsModel() async {
    let client = FakeDaemonClient()
    let store = SettingsStore()
    store.client = client
    await store.update(SettingsPatch(agent: .init(harness: .cursor)))
    await store.update(SettingsPatch(agent: AgentModelField(store.settings.agent).patch("gpt-5.5")))
    #expect(store.settings.agent.harness == .cursor && store.settings.agent.cursorModel == "gpt-5.5")
    #expect(client.withState { $0.settings.agent.agentModel } == "gpt-5.5")

    await store.update(SettingsPatch(agent: .init(harness: .pi)))
    #expect(AgentModelField(store.settings.agent).value == AgentSettings.defaultModel)
    #expect(store.settings.agent.cursorModel == "gpt-5.5")
  }
}
