import DailyDoListClientTestSupport
import DailyDoListModels
import Testing

@testable import DailyDoListApp

@Suite("Agent settings")
struct AgentSettingsTests {

  @Test func theModelFieldIsTheConfiguredHarnesssModel() {
    var agent = AgentSettings.defaults
    agent.model = "vendor/model-a"
    agent.cursorModel = "gpt-5.5"
    let pi = AgentModelField(agent)
    #expect(
      pi.title == "OpenRouter model" && pi.value == "vendor/model-a"
        && pi.prompt == AgentSettings.defaultModel)
    #expect(pi.patch("vendor/model-b") == SettingsPatch.AgentPatch(model: "vendor/model-b"))

    agent.harness = .cursor
    let cursor = AgentModelField(agent)
    #expect(
      cursor.title == "Cursor model" && cursor.value == "gpt-5.5"
        && cursor.prompt == "claude-opus-5-5")
    #expect(cursor.note.contains("agent models") && cursor.note.contains("preset"))
    #expect(
      cursor.patch("gpt-5.5[reasoning=high]")
        == SettingsPatch.AgentPatch(cursorModel: "gpt-5.5[reasoning=high]"))
  }

  @Test func requiredFieldsCommitTrimmedTextAndNeverBlankText() {
    #expect(
      CommitTextField.committed("  gpt-5.5\t", value: "composer-2.5", required: true) == "gpt-5.5")
    #expect(
      CommitTextField.committed("composer-2.5 ", value: "composer-2.5", required: true) == nil)
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
    #expect(
      store.settings.agent.harness == .cursor && store.settings.agent.cursorModel == "gpt-5.5")
    #expect(client.withState { $0.settings.agent.agentModel } == "gpt-5.5")

    await store.update(SettingsPatch(agent: .init(harness: .pi)))
    #expect(AgentModelField(store.settings.agent).value == AgentSettings.defaultModel)
    #expect(store.settings.agent.cursorModel == "gpt-5.5")
  }

  @Test func theApprovalPoliciesUseTheWebAppsWords() {
    #expect(
      ApprovalPolicy.allCases.map(\.settingsLabel) == [
        "Ask before every action", "Ask for risky actions (recommended)",
        "Ask only for high-risk actions", "Run everything",
      ])
    #expect(
      ApprovalPolicy.allCases.map(\.settingsDescription) == [
        "Every action that changes something asks first. Reading, searching and research don't.",
        "The safety check decides: purchases, messages, bookings, deletions, account changes and anything it can't verify ask first.",
        "Only high-risk actions ask first (sending messages, paying, deleting, account and credential changes); everything else runs.",
        "Agents never ask. Actions that are never allowed stay blocked: deleting your home folder, reading passwords or keychains, controlling Daily Do List itself, System Settings or password managers.",
      ])
    #expect(RunEverythingConfirmation.title == "Run everything without asking?")
    #expect(RunEverythingConfirmation.confirm == "Run everything")
    #expect(RunEverythingConfirmation.message.contains(ApprovalPolicy.neverAllowed))
  }

  @Test func onlyRunEverythingAsksForConfirmation() {
    #expect(ApprovalPolicy.allCases.filter(\.needsConfirmation) == [.runEverything])
    #expect(ApprovalPolicyPicker.choice(.runEverything, current: .askRisky) == .confirm)
    #expect(ApprovalPolicyPicker.choice(.runEverything, current: .askHighRisk) == .confirm)
    #expect(ApprovalPolicyPicker.choice(.runEverything, current: .runEverything) == .unchanged)
    #expect(ApprovalPolicyPicker.choice(.askRisky, current: .askRisky) == .unchanged)
    for policy in [ApprovalPolicy.askEveryAction, .askRisky, .askHighRisk] {
      #expect(ApprovalPolicyPicker.choice(policy, current: .runEverything) == .save(policy))
    }
  }

  @Test func theStatusBarNamesEveryPolicyButTheDefault() {
    #expect(ApprovalPolicyIndicator(.askRisky) == nil)
    let everything = ApprovalPolicyIndicator(.runEverything)
    #expect(everything?.label == "Runs everything" && everything?.isWarning == true)
    #expect(everything?.tooltip == "Agents run everything without asking — click to change")
    let highRisk = ApprovalPolicyIndicator(.askHighRisk)
    #expect(highRisk?.label == "Asks only for high-risk" && highRisk?.isWarning == false)
    let every = ApprovalPolicyIndicator(.askEveryAction)
    #expect(every?.label == "Asks before every action" && every?.isWarning == false)
  }

  @MainActor
  @Test func theApprovalPolicyIsSavedThroughTheDaemon() async {
    let client = FakeDaemonClient()
    let store = SettingsStore()
    store.client = client
    #expect(store.settings.agent.approvalPolicy == .askRisky)
    for policy in [ApprovalPolicy.runEverything, .askEveryAction, .askHighRisk, .askRisky] {
      await store.update(SettingsPatch(agent: .init(approvalPolicy: policy)))
      #expect(store.settings.agent.approvalPolicy == policy)
      #expect(client.withState { $0.settings.agent.approvalPolicy } == policy)
    }
  }

  @MainActor
  @Test func theApprovalPolicyCommandOpensSettingsOnTheAgentPane() async {
    let model = AppModel(environment: makeEnvironment(client: FakeDaemonClient()))
    await model.boot()
    model.ui.settingsPane = .general
    #expect(CommandCatalog(model: model).run(.approvalPolicy))
    #expect(model.ui.settingsPane == .agent)
    #expect(CommandID(vimCommandID: "settings:approvals") == .approvalPolicy)
    await model.teardown()
  }
}
