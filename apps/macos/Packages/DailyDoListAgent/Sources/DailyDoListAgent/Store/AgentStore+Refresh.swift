import DailyDoListClient
import DailyDoListModels
import Foundation

extension AgentStore {
  /// Refetches everything events would have kept current: the status, pending approvals, the
  /// thread list (`todayNotePath`'s threads, or every thread when it's nil), the records of every
  /// note loaded with `loadRecords(for:)` (and today's), every loaded thread, and the
  /// orchestrator's chat. (Surface subscriptions survive reconnects: the client re-sends them.)
  ///
  /// Call it at launch and after every reconnect. Events that arrive while it runs are newer than
  /// its snapshots and are never overwritten; overlapping refreshes only apply the latest.
  public func refresh(todayNotePath: String? = nil) async {
    if let todayNotePath { self.todayNotePath = todayNotePath }
    if let path = self.todayNotePath { trackedNotes.insert(path) }
    refreshGeneration += 1
    let generation = refreshGeneration
    let mark = eventSeq

    let client = self.client
    let listFilter = self.todayNotePath
    let notes = trackedNotes.sorted()
    async let status = Self.capture { try await client.agentStatus() }
    async let pending = Self.capture { try await client.approvals(status: .pending) }
    async let list = Self.capture { try await client.threads(notePath: listFilter, taskId: nil) }
    async let records = Self.fetchRecords(client: client, notes: notes)
    let (statusResult, pendingResult, listResult, recordResults) = await (
      status, pending, list, records
    )
    guard generation == refreshGeneration else { return }

    var failure: Error?
    switch statusResult {
    case .success(let value): applyFetchedStatus(value, since: mark)
    case .failure(let error): failure = failure ?? error
    }
    switch pendingResult {
    case .success(let value):
      let preserving = touchedIds(approvalTouches, since: mark)
      mutate { $0.applyPendingApprovals(value, preserving: preserving) }
    case .failure(let error): failure = failure ?? error
    }
    switch listResult {
    case .success(let value):
      let preserving = touchedIds(threadTouches, since: mark)
      mutate { $0.applyThreadList(value, notePath: listFilter, preserving: preserving) }
    case .failure(let error): failure = failure ?? error
    }
    for (notePath, result) in recordResults {
      switch result {
      case .success(let value): applyFetchedRecords(value, notePath: notePath, since: mark)
      case .failure(let error): failure = failure ?? error
      }
    }
    if let failure { report(failure, title: "Couldn't refresh the agent's state") }

    // The orchestrator's chat is pinned in the inbox whatever the list's filter, so it's always
    // loaded; a daemon whose agent is off has none, which isn't worth a toast.
    let loaded = Set(state.loadedThreads.keys).union([OrchestratorThread.id]).sorted()
    await withTaskGroup(of: Void.self) { group in
      for id in loaded {
        let quiet = OrchestratorThread.isOrchestrator(id)
        group.addTask { await self.loadThread(id, force: true, quiet: quiet) }
      }
    }
  }

  /// A fetched status, unless an `agent.status` push arrived after `mark`: that one is newer.
  func applyFetchedStatus(_ status: AgentStatusResponse, since mark: UInt64) {
    guard statusTouch <= mark else { return }
    mutate { $0.setStatus(status) }
  }

  nonisolated static func capture<T: Sendable>(
    _ operation: @Sendable () async throws -> T
  ) async -> Result<T, Error> {
    do {
      return .success(try await operation())
    } catch {
      return .failure(error)
    }
  }

  nonisolated static func fetchRecords(
    client: DaemonClient, notes: [String]
  ) async -> [(String, Result<[TaskAgentRecord], Error>)] {
    await withTaskGroup(of: (String, Result<[TaskAgentRecord], Error>).self) { group in
      for note in notes {
        group.addTask { (note, await capture { try await client.taskRecords(notePath: note) }) }
      }
      var results: [(String, Result<[TaskAgentRecord], Error>)] = []
      for await result in group { results.append(result) }
      return results.sorted { $0.0 < $1.0 }
    }
  }
}
