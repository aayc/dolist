import DailyDoListClient
import DailyDoListModels
import Foundation
import Testing

/// The `DaemonClientError` thrown by `body`, or nil (recording an issue) when it succeeds or
/// throws something else.
@MainActor
func captureError<T>(
  _ body: () async throws -> T, sourceLocation: SourceLocation = #_sourceLocation
) async -> DaemonClientError? {
  do {
    _ = try await body()
    Issue.record(
      "expected a DaemonClientError, but the call succeeded", sourceLocation: sourceLocation)
    return nil
  } catch let error as DaemonClientError {
    return error
  } catch {
    Issue.record("expected a DaemonClientError, got \(error)", sourceLocation: sourceLocation)
    return nil
  }
}

/// A connected client and the log of its events.
@MainActor
func connectedClient(_ fixture: DaemonFixture) async throws -> (HTTPDaemonClient, EventLog) {
  let client = try fixture.makeClient()
  let log = EventLog(client)
  await client.connect()
  try await log.connected()
  return (client, log)
}

/// A unique suffix so notes of different runs and tests never collide.
func unique() -> String { String(UUID().uuidString.prefix(8)) }

/// Appends `- [ ] task` to today's daily note (created if needed), the only note the agent watches
/// by default; returns the note's path.
@MainActor
func addTask(_ task: String, with client: HTTPDaemonClient) async throws -> String {
  let note = try await client.dailyNote("today", create: true)
  for _ in 0..<5 {
    let current = try await client.readNote(note.path)
    let body =
      current.content.isEmpty || current.content.hasSuffix("\n")
      ? current.content : current.content + "\n"
    do {
      _ = try await client.writeNote(
        note.path, content: body + "- [ ] \(task)\n", baseVersion: .match(current.version))
      return note.path
    } catch DaemonClientError.conflict {
      continue
    }
  }
  throw FixtureError("couldn't append “\(task)” to \(note.path)")
}

extension EventLog {
  /// Waits for the task's pending approval.
  @MainActor
  func pendingApproval(
    for record: TaskAgentRecord, from: Int, timeout: Duration = .seconds(60)
  ) async throws -> ApprovalRequest {
    try await event(from: from, timeout: timeout, "a pending approval for “\(record.text)”") {
      event -> ApprovalRequest? in
      guard case .approvalUpsert(let approval) = event, approval.taskId == record.taskId,
        approval.status == .pending
      else { return nil }
      return approval
    }
  }

  /// The first agent record for the task with this text (from `task.record` or `task.records`),
  /// optionally in one of `statuses`.
  @MainActor
  func record(
    from: Int = 0, text: String, status statuses: Set<TaskAgentStatus> = [],
    timeout: Duration = .seconds(60)
  ) async throws -> TaskAgentRecord {
    let wanted =
      statuses.isEmpty ? "any status" : statuses.map(\.rawValue).sorted().joined(separator: "/")
    return try await event(from: from, timeout: timeout, "task “\(text)” (\(wanted))") { event in
      let records: [TaskAgentRecord]
      switch event {
      case .taskRecord(let record): records = [record]
      case .taskRecords(let snapshot): records = snapshot.records
      default: return nil
      }
      return records.first { $0.text == text && (statuses.isEmpty || statuses.contains($0.status)) }
    }
  }

  @MainActor
  func record(
    from: Int = 0, text: String, status: TaskAgentStatus, timeout: Duration = .seconds(60)
  ) async throws -> TaskAgentRecord {
    try await record(from: from, text: text, status: [status], timeout: timeout)
  }

  /// The first `vault.changed` event that includes `path`.
  @MainActor
  func vaultChange(from: Int = 0, path: String, timeout: Duration = .seconds(30)) async throws
    -> VaultChangedEvent
  {
    try await event(from: from, timeout: timeout, "vault.changed for \(path)") { event in
      guard case .vaultChanged(let change) = event,
        change.changes.contains(where: { $0.path == path })
      else { return nil }
      return change
    }
  }
}

extension ThreadResponse {
  /// Text of every text message in the thread.
  var texts: [String] {
    thread.messages.compactMap { message in
      if case .text(let text) = message { return text.text }
      return nil
    }
  }
}
