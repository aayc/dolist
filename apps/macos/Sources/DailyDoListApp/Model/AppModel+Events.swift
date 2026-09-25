import DailyDoListAgent
import DailyDoListClient
import DailyDoListModels
import Foundation
import os

extension AppModel {
  static let log = Logger(subsystem: "app.dailydolist.mac", category: "events")

  /// Consumes the client's stream on the main actor until the connection is torn down.
  func startEventLoop(_ client: DaemonClient) {
    eventTask?.cancel()
    let stream = client.events()
    eventTask = Task { [weak self] in
      for await item in stream {
        guard let self, !Task.isCancelled else { return }
        self.handle(item)
      }
    }
  }

  /// Routes one stream item: connection states → ``ConnectionStore``, events → stores, `.resync`
  /// → refetch everything.
  func handle(_ item: DaemonStreamItem) {
    switch item {
    case .state(let state):
      connection.update(state)
      if case .incompatible(let server) = state {
        phase = .failed(.incompatibleApiVersion(server: server))
      }
    case .event(let event):
      route(event)
    case .resync:
      Task { await resync() }
    }
  }

  func route(_ event: ServerEvent) {
    switch event {
    case .hello, .importProgress:
      break
    case .vaultChanged(let change):
      // Our own writes come back tagged with our client id: already applied locally.
      if let origin = change.clientId, origin == client?.clientId { return }
      workspace?.handleVaultChanged(change)
    case .settingsChanged(let next):
      settings.apply(next)
    case .taskRecords(let records):
      agent?.apply(event)
      workspace?.editor.recordsDidChange(for: records.notePath)
    case .taskRecord:
      // A record can move between notes: refresh whatever is shown.
      agent?.apply(event)
      workspace?.editor.recordsDidChange(for: nil)
    case .threadUpsert, .threadMessage, .threadDelta, .approvalUpsert, .agentStatus, .surfaceFrame,
      .routinesChanged, .routineNotification:
      agent?.apply(event)
    case .error(let error):
      Self.log.warning("daemon error event: \(error.message, privacy: .public)")
    case .unknown(let type, _):
      Self.log.debug("ignoring unknown event \(type, privacy: .public)")
    }
  }

  /// After a reconnect events may have been missed: settings, tree, open notes, agent state.
  func resync() async {
    await settings.reload()
    await workspace?.resync()
    if let agent {
      await agent.refresh(todayNotePath: todayNotePath)
      workspace?.editor.recordsDidChange(for: nil)
    }
  }
}
