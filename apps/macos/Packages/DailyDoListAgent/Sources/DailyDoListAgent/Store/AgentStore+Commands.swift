import DailyDoListClient
import DailyDoListModels
import Foundation

// User actions. Each reports failures through `lastError` and never throws.

extension AgentStore {
  // MARK: Threads

  /// Fetches a thread once (`force` refetches) and keeps it live from then on. Concurrent calls
  /// share one request.
  public func loadThread(_ id: String, force: Bool = false) async {
    if !force, state.loadedThreads[id] != nil { return }
    if let inFlight = threadLoads[id] {
      await inFlight.value
      return
    }
    let task = Task { await self.performLoad(id) }
    threadLoads[id] = task
    await task.value
  }

  private func performLoad(_ id: String) async {
    loadBuffers[id] = []
    loadingThreadIds.insert(id)
    defer {
      loadBuffers[id] = nil
      threadLoads[id] = nil
      loadingThreadIds.remove(id)
    }
    do {
      let response = try await client.thread(id)
      failedThreadIds.remove(id)
      let buffered = loadBuffers[id] ?? []
      let inFlight = sendingMessageIds
      mutate { state in
        var changes = state.applyThreadResponse(response, inFlight: inFlight)
        for event in buffered {
          changes.formUnion(state.upsertMessage(event.message, threadId: event.threadId))
        }
        return changes
      }
    } catch {
      failedThreadIds.insert(id)
      report(error, title: "Couldn't load the thread")
    }
  }

  /// Artifact metadata only comes with the full thread: refetch (debounced) when an artifact
  /// message names one we don't have.
  func refetchIfArtifactMissing(threadId: String, artifactId: String) {
    guard let thread = state.loadedThreads[threadId],
      !thread.artifacts.contains(where: { $0.id == artifactId }),
      artifactRefetches[threadId] == nil
    else { return }
    let delay = artifactRefetchDelay
    artifactRefetches[threadId] = Task { [weak self] in
      try? await Task.sleep(for: delay)
      guard let self else { return }
      self.artifactRefetches[threadId] = nil
      await self.loadThread(threadId, force: true)
    }
  }

  /// Tells the daemon the user saw the thread and clears its unread count locally.
  public func markRead(_ threadId: String) {
    outbox.send(.threadRead(threadId: threadId))
    mutate { $0.markRead(threadId: threadId) }
  }

  /// Stops the agent's work on a thread.
  @discardableResult
  public func cancelThread(_ id: String) async -> Bool {
    do {
      _ = try await client.cancelThread(id)
      return true
    } catch {
      report(error, title: "Couldn't stop the task")
      return false
    }
  }

  /// Starts the task over.
  @discardableResult
  public func retryThread(_ id: String) async -> Bool {
    do {
      _ = try await client.retryThread(id)
      return true
    } catch {
      report(error, title: "Couldn't retry the task")
      return false
    }
  }

  // MARK: Messages

  /// Sends a reply. The message shows immediately (author "you") and is replaced by the
  /// daemon's copy when it arrives; it's removed again if the request fails.
  /// - Returns: whether the daemon accepted it (keep the composer text when it didn't).
  @discardableResult
  public func postMessage(threadId: String, text: String) async -> Bool {
    let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !body.isEmpty else { return false }
    let localId = "local-\(UUID().uuidString.lowercased())"
    let message = TextMessage(
      id: localId, author: "you", createdAt: now().epochMillis, role: .user, text: body)
    mutate { $0.insertOptimisticMessage(message, threadId: threadId) }
    sendingMessageIds.insert(localId)
    defer { sendingMessageIds.remove(localId) }
    do {
      _ = try await client.postMessage(threadId: threadId, text: body)
      return true
    } catch {
      mutate { $0.removeOptimisticMessage(id: localId, threadId: threadId) }
      report(error, title: "Couldn't send your message")
      return false
    }
  }

  // MARK: Approvals

  /// Approves or denies. The card flips immediately; it rolls back if the request fails, and
  /// adopts the daemon's state when the approval was already decided elsewhere (409).
  /// - Parameters:
  ///   - scope: approvals only (`once` when nil).
  ///   - note: optional explanation for the agent (whitespace-only notes are dropped).
  /// - Returns: whether this decision was recorded.
  @discardableResult
  public func decide(
    _ approvalId: String, _ decision: ApprovalDecision, scope: ApprovalScope? = nil,
    note: String? = nil
  ) async -> Bool {
    guard !decidingApprovalIds.contains(approvalId) else { return false }
    let original = state.approvals[approvalId]
    if let original, !original.isPending { return false }
    let trimmedNote = note?.trimmingCharacters(in: .whitespacesAndNewlines)
    let request = ApprovalDecisionRequest(
      decision: decision, scope: decision == .approve ? (scope ?? .once) : nil,
      note: trimmedNote?.isEmpty == false ? trimmedNote : nil)

    var optimistic: ApprovalRequest?
    if var next = original {
      next.status = decision == .approve ? .approved : .denied
      next.scope = request.scope
      next.decisionNote = request.note
      next.decidedAt = now().epochMillis
      let flipped = next
      optimistic = flipped
      mutate { $0.upsertApproval(flipped, force: true) }
    }
    decidingApprovalIds.insert(approvalId)
    defer { decidingApprovalIds.remove(approvalId) }

    do {
      let updated = try await client.decideApproval(approvalId, request)
      mutate { $0.upsertApproval(updated, force: true) }
      return true
    } catch DaemonClientError.approvalConflict(let conflict) {
      mutate { $0.upsertApproval(conflict.approval, force: true) }
      lastError = AgentAlert(
        title: "Already decided", message: AgentFormat.conflictMessage(for: conflict.approval))
      return false
    } catch {
      // Roll back unless an event already replaced our optimistic copy with the daemon's.
      if let original, let optimistic, state.approvals[approvalId] == optimistic {
        mutate { $0.upsertApproval(original, force: true) }
      }
      report(error, title: "Couldn't send your decision")
      return false
    }
  }

  // MARK: Agent

  /// Pauses or resumes the agent (optimistic; rolls back on failure).
  public func setEnabled(_ enabled: Bool) async {
    let previous = state.status
    var optimistic: AgentStatusResponse?
    if var next = previous {
      next.enabled = enabled
      let flipped = next
      optimistic = flipped
      mutate { $0.setStatus(flipped) }
    }
    do {
      let status = try await client.setAgentEnabled(enabled)
      mutate { $0.setStatus(status) }
    } catch {
      if let previous, let optimistic, state.status == optimistic {
        mutate { $0.setStatus(previous) }
      }
      report(error, title: enabled ? "Couldn't resume the agent" : "Couldn't pause the agent")
    }
  }

  // MARK: Records

  /// Fetches a note's task records once (`force` refetches); events keep them current after.
  /// `refresh()` refetches every note loaded this way.
  public func loadRecords(for notePath: String, force: Bool = false) async {
    if !force, trackedNotes.contains(notePath) { return }
    trackedNotes.insert(notePath)
    let mark = eventSeq
    do {
      let records = try await client.taskRecords(notePath: notePath)
      applyFetchedRecords(records, notePath: notePath, since: mark)
    } catch {
      if !force { trackedNotes.remove(notePath) }
      report(error, title: "Couldn't load the agent's status for this note")
    }
  }

  /// Stops refetching a note's records on `refresh()` (the note was closed).
  public func forgetRecords(for notePath: String) {
    trackedNotes.remove(notePath)
  }

  func applyFetchedRecords(_ records: [TaskAgentRecord], notePath: String, since mark: UInt64) {
    // A `task.records` push for this note arrived while we waited: it's newer.
    if let touched = noteTouches[notePath], touched > mark { return }
    let preserving = touchedIds(recordTouches, since: mark)
    mutate { $0.applyRecordsSnapshot(notePath: notePath, records: records, preserving: preserving) }
  }

  func touchedIds(_ touches: [String: UInt64], since mark: UInt64) -> Set<String> {
    Set(touches.lazy.filter { $0.value > mark }.map(\.key))
  }

  // MARK: Artifacts

  /// Fetches an artifact's bytes.
  public func fetchArtifact(threadId: String, artifactId: String) async throws -> ArtifactPayload {
    try await client.artifact(threadId: threadId, artifactId: artifactId)
  }
}
