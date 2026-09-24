import DailyDoListModels
import Foundation

// Live server events (the WebSocket push).

extension AgentState {
  /// Applies one server event and reports what changed (empty when it was a no-op).
  /// Events the agent state doesn't use (`hello`, `vault.changed`, frames, settings, errors,
  /// unknown types) are ignored.
  mutating func apply(_ event: ServerEvent, now: EpochMillis) -> Changes {
    switch event {
    case .taskRecords(let event):
      return applyRecordsSnapshot(notePath: event.notePath, records: event.records)
    case .taskRecord(let record):
      return upsertRecord(record)
    case .threadUpsert(let summary):
      return upsertSummary(summary)
    case .threadMessage(let event):
      return upsertMessage(event.message, threadId: event.threadId)
    case .threadDelta(let event):
      return appendDelta(event.delta, messageId: event.messageId, threadId: event.threadId, now: now)
    case .approvalUpsert(let approval):
      return upsertApproval(approval)
    case .agentStatus(let status):
      return setStatus(status)
    case .hello, .vaultChanged, .surfaceFrame, .settingsChanged, .error, .unknown:
      return []
    }
  }

  mutating func setStatus(_ status: AgentStatusResponse?) -> Changes {
    guard self.status != status else { return [] }
    self.status = status
    return .status
  }

  // MARK: Records

  /// Upserts a record (`task.record`): newer wins, and a task moves between notes when its
  /// `notePath` changed (a rename), so it's only ever listed under one note.
  mutating func upsertRecord(_ record: TaskAgentRecord) -> Changes {
    if let previous = self.record(forTaskId: record.taskId),
      previous.updatedAt > record.updatedAt || previous == record
    {
      return []
    }
    removeRecord(taskId: record.taskId, exceptIn: record.notePath)
    var bucket = recordsByNote[record.notePath] ?? []
    if let index = bucket.firstIndex(where: { $0.taskId == record.taskId }) {
      bucket[index] = record
    } else {
      bucket.append(record)
    }
    recordsByNote[record.notePath] = bucket
    return .records
  }

  /// Replaces a note's records with a snapshot (`task.records`, or a REST fetch), keeping any
  /// record known to be newer. A newer copy of a task in another note wins over the snapshot; an
  /// older one is dropped. `preserving`: task ids changed by live events after a REST snapshot
  /// was requested — they stay even if the (older) snapshot doesn't list them.
  mutating func applyRecordsSnapshot(
    notePath: String, records: [TaskAgentRecord], preserving: Set<String> = []
  ) -> Changes {
    let before = recordsByNote
    let previous = recordsByNote[notePath] ?? []
    var bucket: [TaskAgentRecord] = []
    var listed = Set<String>()
    for var record in records {
      // The snapshot says which note the task is in.
      record.notePath = notePath
      guard listed.insert(record.taskId).inserted else { continue }
      if let known = previous.first(where: { $0.taskId == record.taskId }),
        known.updatedAt > record.updatedAt
      {
        bucket.append(known)
        continue
      }
      if let other = self.record(forTaskId: record.taskId), other.notePath != notePath {
        if other.updatedAt > record.updatedAt { continue }
        removeRecord(taskId: record.taskId, exceptIn: notePath)
      }
      bucket.append(record)
    }
    for record in previous where preserving.contains(record.taskId) && !listed.contains(record.taskId) {
      bucket.append(record)
    }
    recordsByNote[notePath] = bucket
    return recordsByNote == before ? [] : .records
  }

  private mutating func removeRecord(taskId: String, exceptIn notePath: String) {
    for (path, records) in recordsByNote where path != notePath {
      if records.contains(where: { $0.taskId == taskId }) {
        recordsByNote[path] = records.filter { $0.taskId != taskId }
      }
    }
  }

  /// Clears the unread count of a thread's task (the daemon does the same on `thread.read`).
  mutating func markRead(threadId: String) -> Changes {
    guard var record = self.record(forThread: threadId), record.unread > 0,
      var bucket = recordsByNote[record.notePath],
      let index = bucket.firstIndex(where: { $0.taskId == record.taskId })
    else { return [] }
    record.unread = 0
    bucket[index] = record
    recordsByNote[record.notePath] = bucket
    return .records
  }

  // MARK: Threads

  /// Upserts a summary (`thread.upsert`) unless ours is newer, and keeps the loaded thread's
  /// header (title, status, surfaces, note) in sync.
  mutating func upsertSummary(_ summary: ThreadSummary) -> Changes {
    if let known = threads[summary.id], known.updatedAt > summary.updatedAt { return [] }
    var changes: Changes = []
    if threads[summary.id] != summary {
      threads[summary.id] = summary
      changes.insert(.threads)
    }
    if syncHeader(ofThread: summary.id, from: summary) { changes.insert(.loadedThreads) }
    return changes
  }

  /// Copies a summary's header fields into the loaded thread; returns whether anything changed.
  mutating func syncHeader(ofThread id: String, from summary: ThreadSummary) -> Bool {
    guard var thread = loadedThreads[id] else { return false }
    let before = (thread.title, thread.status, thread.updatedAt, thread.surfaces, thread.notePath)
    thread.title = summary.title
    thread.status = summary.status
    thread.updatedAt = summary.updatedAt
    thread.surfaces = summary.surfaces
    thread.notePath = summary.notePath
    guard before != (thread.title, thread.status, thread.updatedAt, thread.surfaces, thread.notePath)
    else { return false }
    loadedThreads[id] = thread
    return true
  }

  // MARK: Messages

  /// Upserts a message into a loaded thread (`thread.message`): replaces the message with the
  /// same id in place (see `MessageMerge`), replaces the matching optimistic user message, or
  /// appends. Messages for threads that aren't loaded are ignored (a load fetches them).
  mutating func upsertMessage(_ message: ThreadMessage, threadId: String) -> Changes {
    guard let thread = loadedThreads[threadId] else { return [] }
    let key = MessageKey(threadId: threadId, messageId: message.id)
    if let index = thread.messages.lastIndex(where: { $0.id == message.id }) {
      let existing = thread.messages[index]
      let wasPlaceholder = deltaPlaceholders.remove(key) != nil
      let merged = MessageMerge.merge(
        existing: existing, incoming: message, existingIsPlaceholder: wasPlaceholder)
      guard merged != existing else { return [] }
      loadedThreads[threadId]?.messages[index] = merged
      return .loadedThreads
    }
    if case .text(let text) = message, text.role == .user,
      let index = takeOptimisticMessage(matching: text.text, in: threadId)
    {
      loadedThreads[threadId]?.messages[index] = message
      return .loadedThreads
    }
    loadedThreads[threadId]?.messages.append(message)
    return .loadedThreads
  }

  /// Appends streamed text (`thread.delta`) to a message that is still streaming. A delta for a
  /// message we don't have yet starts a streaming placeholder so the text isn't lost; deltas for
  /// finished (or non-text) messages are ignored, since the final text already contains them.
  mutating func appendDelta(
    _ delta: String, messageId: String, threadId: String, now: EpochMillis
  ) -> Changes {
    guard !delta.isEmpty, let thread = loadedThreads[threadId] else { return [] }
    if let index = thread.messages.lastIndex(where: { $0.id == messageId }) {
      guard case .text(var text) = thread.messages[index], text.streaming == true else { return [] }
      text.text += delta
      loadedThreads[threadId]?.messages[index] = .text(text)
      return .loadedThreads
    }
    let placeholder = TextMessage(
      id: messageId, author: Self.likelyStreamingAuthor(in: thread), createdAt: now, role: .agent,
      text: delta, streaming: true)
    loadedThreads[threadId]?.messages.append(.text(placeholder))
    deltaPlaceholders.insert(MessageKey(threadId: threadId, messageId: messageId))
    return .loadedThreads
  }

  /// Subagents stream their text, so the latest subagent in the thread is the best guess.
  static func likelyStreamingAuthor(in thread: AgentThread) -> MessageAuthor {
    for message in thread.messages.reversed() {
      if let author = message.author, author.subagentName != nil { return author }
    }
    return "orchestrator"
  }

  // MARK: Optimistic messages

  /// Adds a local user message shown until the daemon's copy arrives.
  mutating func insertOptimisticMessage(_ message: TextMessage, threadId: String) -> Changes {
    guard loadedThreads[threadId] != nil else { return [] }
    loadedThreads[threadId]?.messages.append(.text(message))
    optimisticMessages[threadId, default: []].append(message.id)
    return .loadedThreads
  }

  /// Removes an optimistic message (its request failed).
  mutating func removeOptimisticMessage(id: String, threadId: String) -> Changes {
    optimisticMessages[threadId]?.removeAll { $0 == id }
    if optimisticMessages[threadId]?.isEmpty == true { optimisticMessages[threadId] = nil }
    guard let index = loadedThreads[threadId]?.messages.firstIndex(where: { $0.id == id }) else {
      return []
    }
    loadedThreads[threadId]?.messages.remove(at: index)
    return .loadedThreads
  }

  /// Finds (and forgets) the oldest optimistic message with this text; returns its index.
  private mutating func takeOptimisticMessage(matching text: String, in threadId: String) -> Int? {
    guard let ids = optimisticMessages[threadId], let messages = loadedThreads[threadId]?.messages
    else { return nil }
    let wanted = text.trimmingCharacters(in: .whitespacesAndNewlines)
    for id in ids {
      guard let index = messages.firstIndex(where: { $0.id == id }),
        case .text(let local) = messages[index], local.text == wanted
      else { continue }
      optimisticMessages[threadId]?.removeAll { $0 == id }
      if optimisticMessages[threadId]?.isEmpty == true { optimisticMessages[threadId] = nil }
      return index
    }
    return nil
  }

  // MARK: Approvals

  /// Upserts an approval (`approval.upsert`). A decided approval never turns pending again
  /// (a late or replayed copy); `force` adopts the given state regardless (rollbacks, conflicts).
  mutating func upsertApproval(_ approval: ApprovalRequest, force: Bool = false) -> Changes {
    if let existing = approvals[approval.id] {
      if existing == approval { return [] }
      if !force && !existing.isPending && approval.isPending { return [] }
    }
    approvals[approval.id] = approval
    return .approvals
  }
}

extension ThreadMessage {
  /// The message's author (nil for unknown kinds without one).
  var author: MessageAuthor? {
    switch self {
    case .text(let m): m.author
    case .toolCall(let m): m.author
    case .approval(let m): m.author
    case .artifact(let m): m.author
    case .status(let m): m.author
    case .unknown(_, _, let raw): raw["author"]?.stringValue
    }
  }
}
