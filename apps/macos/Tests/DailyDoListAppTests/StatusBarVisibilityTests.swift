import DailyDoListClient
import DailyDoListModels
import Testing

@testable import DailyDoListApp

@Suite("Quiet status bar")
struct StatusBarVisibilityTests {
  private func visibility(
    save: SaveState? = .saved, connection: ConnectionState = .connected(serverVersion: "1.0.0"), demo: Bool = false,
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
    ConnectionState.idle, .connecting, .reconnecting(attempt: 2, reason: "timeout"), .incompatible(serverApiVersion: 9),
    .disconnected,
  ])
  func connectionShowsOnlyWhileNotConnected(state: ConnectionState) {
    #expect(visibility(connection: state).connection == .problem)
    #expect(visibility(connection: state, demo: true).connection == .problem, "a demo problem is still a problem")
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
