import DailyDoListClient
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListApp

@MainActor
@Suite("Event routing")
struct EventRoutingTests {
  let client = FakeDaemonClient(notes: ["Ideas.md": "ideas"])
  let scheduler = ManualScheduler()
  let model: AppModel
  let daily = "Daily/2026-09-23.md"

  init() async throws {
    model = AppModel(environment: makeEnvironment(client: client, scheduler: scheduler))
    await model.boot()
    try await eventually("event loop connected") { model.connection.isOnline }
  }

  private var workspace: Workspace { model.workspace! }

  private func changed(
    _ path: String, _ kind: VaultChangeKind = .modified, version: String? = nil,
    clientId: String? = nil
  ) -> ServerEvent {
    .vaultChanged(
      VaultChangedEvent(
        changes: [VaultChange(path: path, kind: kind, version: version)],
        origin: clientId == nil ? .external : .client, clientId: clientId))
  }

  @Test func ownEchoesAreIgnored() async throws {
    client.resetLog()
    let version = client.setNote(daily, "- [ ] written by us")
    client.emit(changed(daily, version: version, clientId: client.clientId))
    await settle()
    scheduler.advance(by: 1)
    await settle()
    #expect(client.calls("readNote").isEmpty)
    #expect(client.calls("tree").isEmpty, "no tree refresh for our own change")
    #expect(workspace.editor.controller.text == "- [ ] ")
  }

  @Test func externalChangeToTheOpenNoteIsApplied() async throws {
    let version = client.setNote(daily, "- [ ] edited in Obsidian")
    client.emit(changed(daily, version: version))
    try await eventually("editor updated") {
      workspace.editor.controller.text == "- [ ] edited in Obsidian"
    }
    #expect(workspace.notes.saveStates[daily] == .saved)
  }

  @Test func externalChangeNeverClobbersLocalEdits() async throws {
    type("- [ ] my local edit", in: workspace)
    let version = client.setNote(daily, "- [ ] their edit")
    client.emit(changed(daily, version: version))
    try await eventually("conflict detected") { workspace.notes.saveStates[daily] == .conflict }
    #expect(workspace.editor.controller.text == "- [ ] my local edit")
    scheduler.advance(by: 0.3)
    try await eventually("resolved") { workspace.notes.saveStates[daily] == .saved }
    #expect(client.note(daily)?.content == "- [ ] my local edit")
    #expect(client.note("Daily/2026-09-23 (conflict).md")?.content == "- [ ] their edit")
    #expect(workspace.vault.isFile("Daily/2026-09-23 (conflict).md"))
    #expect(model.toasts.toasts.contains { $0.title.contains("changed elsewhere") })
  }

  @Test func newFilesAppearAtOnceAndTheTreeIsRefreshedDebounced() async throws {
    client.resetLog()
    client.setNote("Inbox/New.md", "new")
    client.emit(changed("Inbox/New.md", .created, version: "v1"))
    try await eventually("added to the tree") { workspace.vault.isFile("Inbox/New.md") }
    #expect(client.calls("tree").isEmpty)
    scheduler.advance(by: 0.3)
    try await eventually("tree refreshed") { client.calls("tree").count == 1 }
  }

  @Test func deletedOpenNoteClosesItsTab() async throws {
    await workspace.openNote("Ideas.md", OpenOptions(newTab: true))
    client.removeNote("Ideas.md")
    client.emit(changed("Ideas.md", .deleted))
    try await eventually("tab closed") { !workspace.tabs.tabs.contains("Ideas.md") }
    #expect(!workspace.vault.has("Ideas.md"))
  }

  @Test func settingsChangesApplyToTheEditor() async throws {
    var settings = AppSettings.defaults
    settings.editor.fontSize = 22
    client.emit(.settingsChanged(settings))
    try await eventually("settings applied") { model.settings.settings.editor.fontSize == 22 }
    #expect(workspace.editor.controller.configuration.fontSize == 22)
  }

  @Test func taskRecordsReachTheAgentStoreAndTheBadges() async throws {
    client.setNote(daily, "- [ ] Book a table")
    let version = client.note(daily)?.version
    client.emit(changed(daily, version: version))
    try await eventually { workspace.editor.controller.text == "- [ ] Book a table" }
    client.emit(
      .taskRecords(
        TaskRecordsEvent(
          notePath: daily,
          records: [
            .sample(
              "t1", note: daily, text: "Book a table", line: 0, status: .waitingApproval,
              threadId: "th1")
          ])))
    try await eventually("records applied") { model.agent?.records(for: daily).count == 1 }
    scheduler.advance(by: 0)
    #expect(workspace.editor.controller.badges.map(\.label) == ["Needs approval"])
  }

  @Test func agentStatusEventsUpdateTheStatusBarState() async throws {
    var status = try await client.agentStatus()
    status.enabled = false
    status.running = 2
    client.emit(.agentStatus(status))
    try await eventually { model.agent?.status?.enabled == false }
    #expect(model.agent?.status?.running == 2)
  }

  @Test func resyncRefetchesEverything() async throws {
    client.resetLog()
    client.emit(.resync)
    try await eventually("refetched") {
      let calls = client.calls
      return calls.contains("settings") && calls.contains("tree")
        && calls.contains("readNote:\(daily)")
        && calls.contains("agentStatus")
    }
  }

  @Test func connectionStatesDriveTheOfflineBanner() async throws {
    client.setConnection(.reconnecting(attempt: 1, reason: "socket closed"))
    try await eventually { model.connection.showsOfflineBanner }
    #expect(model.connection.label == "Reconnecting…")
    client.setConnection(.connected(serverVersion: "0.1.0-test"))
    try await eventually { !model.connection.showsOfflineBanner }
  }

  @Test func retryFromTheBannerKeepsRoutingEvents() async throws {
    await model.retry()
    #expect(client.calls.filter { $0 == "disconnect" }.count == 1)
    try await eventually("reconnected") { model.connection.isOnline }
    var settings = AppSettings.defaults
    settings.editor.fontSize = 19
    client.emit(.settingsChanged(settings))
    try await eventually("events still routed after retry") {
      model.settings.settings.editor.fontSize == 19
    }
  }

  @Test func incompatibleDaemonAfterReconnectShowsTheErrorScreen() async throws {
    client.setConnection(.incompatible(serverApiVersion: 9))
    try await eventually { model.phase == .failed(.incompatibleApiVersion(server: 9)) }
  }

  @Test func routineEventsReachTheAgentStore() async throws {
    let routine = Routine(
      id: "rtn_1", path: "Routines/Morning briefing.md", name: "Morning briefing",
      schedule: "every weekday at 7:30", instructions: "Brief me.")
    client.emit(.routinesChanged([routine]))
    try await eventually("routines routed") { model.agent?.routines == [routine] }
    client.emit(
      .routineNotification(
        RoutineNotification(
          routineId: "rtn_1", title: "Morning briefing", body: "3 meetings", threadId: "thr_r1",
          status: .done, at: 1)))
    try await eventually("notification routed") {
      model.agent?.routineNotifications.map(\.threadId) == ["thr_r1"]
    }
  }

  @Test func unknownEventsAreIgnored() async throws {
    client.emit(.unknown(type: "future.event", raw: ["type": "future.event"]))
    client.emit(.error(ServerErrorEvent(message: "bad frame", code: .invalidMessage)))
    await settle()
    #expect(model.phase == .ready)
  }
}
