import DailyDoListClient
import DailyDoListModels
import Testing

@testable import DailyDoListApp

@Suite("Quiet status bar")
struct StatusBarVisibilityTests {
  private func visibility(
    save: SaveState? = .saved, connection: ConnectionState = .connected(serverVersion: "1.0.0"),
    demo: Bool = false,
    mode: AgentMode? = .live
  ) -> StatusBarVisibility {
    StatusBarVisibility(saveState: save, connection: connection, isDemo: demo, agentMode: mode)
  }

  @Test func theNormalStateShowsNothing() {
    let quiet = visibility()
    #expect(quiet.saveState == nil)
    #expect(quiet.connection == nil)
    #expect(quiet.agentMode == nil)
  }

  @Test(arguments: [SaveState.dirty, .saving, .conflict, .error])
  func saveStatesShowWhileTheNoteIsNotSaved(state: SaveState) {
    #expect(visibility(save: state).saveState == state)
  }

  @Test func noNoteMeansNoSaveState() {
    #expect(visibility(save: nil).saveState == nil)
  }

  @Test(arguments: [
    ConnectionState.idle, .connecting, .reconnecting(attempt: 2, reason: "timeout"),
    .incompatible(serverApiVersion: 9),
    .disconnected,
  ])
  func connectionShowsOnlyWhileNotConnected(state: ConnectionState) {
    #expect(visibility(connection: state).connection == .problem)
    #expect(
      visibility(connection: state, demo: true).connection == .problem,
      "a demo problem is still a problem")
  }

  @Test func demoModeKeepsASmallMarker() {
    #expect(visibility(demo: true).connection == .demo)
    #expect(visibility(demo: false).connection == nil)
  }

  @Test func theAgentModeShowsOnlyWhenItIsNotLive() {
    #expect(visibility(mode: .live).agentMode == nil)
    #expect(visibility(mode: .mock).agentMode == .mock)
    #expect(visibility(mode: .off).agentMode == .off)
    #expect(visibility(mode: nil).agentMode == nil, "unknown until the agent status arrives")
  }
}

@Suite("Agent status item")
struct AgentStatusPresentationTests {
  private func status(mode: AgentMode = .live, enabled: Bool = true, problem: String? = nil)
    -> AgentStatusResponse
  {
    AgentStatusResponse(
      mode: mode, enabled: enabled, model: "claude-opus-5-5", running: 0, queued: 0,
      pendingApprovals: 0,
      connectors: [],
      execution: ExecutionStatus(
        provider: "local",
        capabilities: ExecutionCapabilities(shell: true, browser: true, computer: true)),
      problem: problem)
  }

  @Test func nothingShowsUntilTheStatusArrives() {
    #expect(AgentStatusPresentation(status: nil) == nil)
  }

  @Test func aWorkingAgentIsOnAndToggles() throws {
    let item = try #require(AgentStatusPresentation(status: status()))
    #expect(item.state == .on)
    #expect(item.label == "Agent on")
    #expect(item.toggles)
  }

  @Test func aPausedAgentSaysSoAndToggles() throws {
    let item = try #require(AgentStatusPresentation(status: status(enabled: false)))
    #expect(item.state == .paused)
    #expect(item.label == "Agent paused")
    #expect(item.toggles)
  }

  @Test func aProblemIsNeverShownAsOn() throws {
    let problem = "OpenRouter rejected OPENROUTER_API_KEY (401: User not found.)."
    let item = try #require(AgentStatusPresentation(status: status(problem: problem)))
    #expect(item.state == .unavailable)
    #expect(item.label == "Agent unavailable")
    #expect(item.detail == problem, "the daemon's text says what to fix")
    #expect(!item.toggles, "pausing wouldn't fix it: clicking explains instead")
  }

  @Test func aBlankProblemIsNoProblem() throws {
    #expect(try #require(AgentStatusPresentation(status: status(problem: "  "))).state == .on)
  }

  @Test func theOffModeIsOffNotUnavailable() throws {
    let item = try #require(
      AgentStatusPresentation(
        status: status(mode: .off, enabled: false, problem: "The agent is off.")))
    #expect(item.state == .off)
    #expect(item.label == "Agent off")
    #expect(item.detail == "The agent is off.")
    #expect(!item.toggles)
  }
}
