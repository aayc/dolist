import DailyDoListModels
import Foundation

/// One `- [ ] text` line of a note, with a stable id across edits.
struct TrackedTask: Hashable, Sendable {
  var id: String
  var text: String
  var line: Int
  var isOpen: Bool
}

struct QueuedJob: Sendable {
  let notePath: String
  let taskId: String
  let threadId: String?
}

/// An agent run: a task's subagent, or the orchestrator's reply to a user message. Its script is
/// a list of beats, each run `delay` ms after the previous one.
struct Job: Sendable {
  enum Step: Sendable {
    case begin
    case textStart(author: MessageAuthor)
    case textDelta(String)
    case textFinish(String)
    case toolStart(AgentScript.ToolStep)
    case frame(AgentScript.BrowserPage)
    case toolFinish(ToolCallStatus, preview: String)
    case artifact(AgentScript.Artifact)
    /// Suspends the job until `decideApproval`.
    case requestApproval(AgentScript.RiskyAction)
    case resume(approved: Bool)
    case finish(TaskAgentStatus, summary: String)
    /// Ends a job that doesn't own a task (replies).
    case end
  }

  struct Beat: Sendable {
    var delay: Double
    var step: Step
  }

  struct StreamingText: Sendable {
    let id: String
    let author: MessageAuthor
    let createdAt: EpochMillis
    var streamed: String
  }

  let id: String
  let taskId: String?
  var threadId: String?
  let script: AgentScript?
  var beats: [Beat]
  var index = 0
  let generation: Int
  var text: StreamingText?
  var tool: ToolCallMessage?
  var waitingApproval: String?
}

/// Parses checkbox tasks (`- [ ] text`, `* [x] text`, `1. [ ] text`) line by line.
enum FakeTaskParser {
  struct ParsedTask: Equatable {
    let line: Int
    let text: String
    let isOpen: Bool
  }

  static func tasks(in content: String) -> [ParsedTask] {
    content.textLines.enumerated().compactMap { index, line in parse(line, line: index) }
  }

  private static func parse(_ line: Substring, line index: Int) -> ParsedTask? {
    var rest = line.drop { $0 == " " || $0 == "\t" }
    if let marker = rest.first, "-*+".contains(marker) {
      rest = rest.dropFirst()
    } else {
      let digits = rest.prefix { $0.isASCII && $0.isNumber }
      guard (1...9).contains(digits.count), let end = rest.dropFirst(digits.count).first, end == "." || end == ")" else {
        return nil
      }
      rest = rest.dropFirst(digits.count + 1)
    }
    let spaced = rest.drop { $0 == " " || $0 == "\t" }
    guard spaced.count < rest.count, spaced.count >= 3, spaced.first == "[" else { return nil }
    let status = spaced[spaced.index(after: spaced.startIndex)]
    let afterStatus = spaced.dropFirst(2)
    guard afterStatus.first == "]" else { return nil }
    let tail = afterStatus.dropFirst()
    if let first = tail.first, first != " " && first != "\t" { return nil }
    return ParsedTask(line: index, text: tail.trimmingCharacters(in: .whitespaces), isOpen: status == " ")
  }

  /// `isBlankTaskText`: fewer than two characters besides whitespace, `.`, `…` and `-`.
  static func isBlank(_ text: String) -> Bool {
    text.filter { !$0.isWhitespace && $0 != "." && $0 != "…" && $0 != "-" }.count < 2
  }

  /// One text extends the other (the user is still typing), or they are similar enough.
  static func isSameTaskEdited(_ a: String, _ b: String, threshold: Double) -> Bool {
    let x = normalize(a)
    let y = normalize(b)
    if x.count >= 3, y.count >= 3, x.hasPrefix(y) || y.hasPrefix(x) { return true }
    return diceSimilarity(a, b) >= threshold
  }

  /// Sørensen–Dice coefficient over character bigrams of the normalized texts (`@ddl/core`).
  static func diceSimilarity(_ a: String, _ b: String) -> Double {
    let x = Array(normalize(a))
    let y = Array(normalize(b))
    if x == y { return 1 }
    guard x.count >= 2, y.count >= 2 else { return 0 }
    var bigrams: [String: Int] = [:]
    for index in 0..<(x.count - 1) { bigrams[String(x[index...index + 1]), default: 0] += 1 }
    var overlap = 0
    for index in 0..<(y.count - 1) {
      let bigram = String(y[index...index + 1])
      if let count = bigrams[bigram], count > 0 {
        bigrams[bigram] = count - 1
        overlap += 1
      }
    }
    return 2 * Double(overlap) / Double(x.count - 1 + y.count - 1)
  }

  private static func normalize(_ text: String) -> String {
    text.split(whereSeparator: \.isWhitespace).joined(separator: " ").lowercased()
  }
}

extension FakeDaemon {
  static let connectors = [
    ConnectorStatus(name: "notes", transport: .stdio, state: .connected, toolCount: 4),
    ConnectorStatus(name: "mail", transport: .http, state: .connected, toolCount: 3),
    ConnectorStatus(name: "calendar", transport: .sse, state: .idle, toolCount: 5),
  ]

  static func agentUnavailable() -> DaemonClientError {
    .http(status: 503, body: ApiErrorBody(error: .agentUnavailable, message: "The agent runtime is not running"))
  }

  // MARK: - Queries

  func status() -> AgentStatusResponse {
    let enabled = simulation == .enabled
    return AgentStatusResponse(
      mode: enabled ? .mock : .off, enabled: settings.agent.enabled, model: settings.agent.model,
      running: runningTaskJobs, queued: records.values.filter { $0.status == .queued }.count,
      pendingApprovals: approvals.values.filter(\.isPending).count,
      connectors: enabled ? Self.connectors : [],
      execution: enabled
        ? ExecutionStatus(provider: "mock", capabilities: ExecutionCapabilities(shell: false, browser: true, computer: true))
        : ExecutionStatus(provider: "none", capabilities: ExecutionCapabilities(shell: false, browser: false, computer: false)),
      problem: enabled ? nil : "The agent runtime is not running")
  }

  var runningTaskJobs: Int { jobs.values.filter { $0.taskId != nil }.count }

  func recordsFor(_ notePath: String) -> [TaskAgentRecord] {
    records.values.filter { $0.notePath == notePath }.sorted { ($0.line, $0.taskId) < ($1.line, $1.taskId) }
  }

  func taskRecords(notePath: String) throws(DaemonClientError) -> [TaskAgentRecord] {
    recordsFor(try FakeVaultPaths.resolveNotePath(notePath))
  }

  func threadList(notePath: String?, taskId: String?) throws(DaemonClientError) -> [ThreadSummary] {
    var path: String?
    if let notePath, !notePath.isEmpty { path = try FakeVaultPaths.resolveNotePath(notePath) }
    let task = taskId.flatMap { $0.isEmpty ? nil : $0 }
    return threads.values
      .filter { (path == nil || $0.notePath == path) && (task == nil || $0.taskId == task) }
      .sorted { ($0.updatedAt, $0.id) > ($1.updatedAt, $1.id) }
      .map(summary)
  }

  func thread(_ id: String) throws(DaemonClientError) -> ThreadResponse {
    let id = try RequestGuards.runtimeID(id, "id")
    guard let thread = threads[id] else { throw .notFound("Thread not found") }
    let approvals = approvals.values.filter { $0.threadId == id }.sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
    return ThreadResponse(thread: thread, approvals: approvals)
  }

  func approvalList(status: ApprovalStatus?) -> [ApprovalRequest] {
    approvals.values.filter { status == nil || $0.status == status }
      .sorted { ($0.createdAt, $0.id) > ($1.createdAt, $1.id) }
  }

  func artifact(threadId: String, artifactId: String) throws(DaemonClientError) -> ArtifactPayload {
    let threadId = try RequestGuards.runtimeID(threadId, "threadId")
    let artifactId = try RequestGuards.runtimeID(artifactId, "artifactId")
    guard let artifact = artifacts[artifactId], artifact.meta.threadId == threadId else {
      throw .notFound("Artifact not found")
    }
    return ArtifactPayload(data: artifact.data, mimeType: artifact.meta.mimeType)
  }

  func summary(_ thread: AgentThread) -> ThreadSummary {
    var preview: String?
    for message in thread.messages.reversed() {
      if case .text(let text) = message {
        preview = Self.preview(text.text, 200)
        break
      }
    }
    return ThreadSummary(
      id: thread.id, taskId: thread.taskId, notePath: thread.notePath, title: thread.title, status: thread.status,
      createdAt: thread.createdAt, updatedAt: thread.updatedAt, messageCount: thread.messages.count,
      lastMessagePreview: preview, artifactCount: thread.artifacts.count, surfaces: thread.surfaces,
      pendingApprovals: approvals.values.filter { $0.threadId == thread.id && $0.isPending }.count)
  }

  /// The first `max` UTF-16 units of `text`, never ending on half of a surrogate pair.
  static func preview(_ text: String, _ max: Int) -> String {
    let units = Array(text.utf16)
    guard units.count > max else { return text }
    var end = max
    if (0xD800...0xDBFF).contains(units[end - 1]) { end -= 1 }
    return String(decoding: units[..<end], as: UTF16.self)
  }

  // MARK: - Commands

  func postMessage(threadId: String, text: String) throws(DaemonClientError) -> ThreadActionResponse {
    let threadId = try RequestGuards.runtimeID(threadId, "id")
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty || trimmed.utf16.count > 20_000 {
      throw .invalidRequest("✖ Too small: expected string to have >=1 characters\n  → at text")
    }
    guard threads[threadId] != nil else { throw .notFound("Thread not found") }
    guard simulation == .enabled else { throw Self.agentUnavailable() }
    pushMessage(threadId, .text(TextMessage(id: nextID("msg"), author: "you", createdAt: nowMillis, role: .user, text: trimmed)))
    let working = jobs.values.contains { $0.threadId == threadId && $0.taskId != nil }
    let reply = working
      ? "Got it — I'll factor that in as I go."
      : "Thanks! I've added that to this task's notes. Hit **Retry** if you'd like me to take another pass."
    jobGeneration += 1
    let id = nextID("reply")
    jobs[id] = Job(
      id: id, taskId: nil, threadId: threadId, script: nil,
      beats: say("orchestrator", reply, after: 500) + [Job.Beat(delay: 0, step: .end)], generation: jobGeneration)
    scheduleNextBeat(id)
    return ThreadActionResponse()
  }

  func cancelThread(_ threadId: String) throws(DaemonClientError) -> ThreadActionResponse {
    let threadId = try RequestGuards.runtimeID(threadId, "id")
    guard let thread = threads[threadId] else { throw .notFound("Thread not found") }
    guard simulation == .enabled else { throw Self.agentUnavailable() }
    var stoppedTask = false
    for job in jobs.values.filter({ $0.threadId == threadId }).sorted(by: { $0.id < $1.id }) {
      abort(job)
      stoppedTask = stoppedTask || job.taskId != nil
    }
    if let taskId = thread.taskId, let index = waitingJobs.firstIndex(where: { $0.taskId == taskId }) {
      waitingJobs.remove(at: index)
      stoppedTask = true
    }
    if stoppedTask, let taskId = thread.taskId {
      patchRecord(taskId) {
        $0.status = .cancelled
        $0.summary = "Stopped by you"
      }
      setThreadStatus(threadId, .cancelled, "Stopped by you")
      emitStatus()
      drainQueue()
    }
    return ThreadActionResponse()
  }

  func retryThread(_ threadId: String) throws(DaemonClientError) -> ThreadActionResponse {
    let threadId = try RequestGuards.runtimeID(threadId, "id")
    guard let thread = threads[threadId] else { throw .notFound("Thread not found") }
    guard simulation == .enabled else { throw Self.agentUnavailable() }
    guard let taskId = thread.taskId, jobs[taskId] == nil, !waitingJobs.contains(where: { $0.taskId == taskId })
    else { return ThreadActionResponse() }
    let record = records[taskId]
    guard let notePath = record?.notePath ?? thread.notePath else { return ThreadActionResponse() }
    let task = tracked[notePath]?.first { $0.id == taskId }
    startJob(
      notePath, taskId: taskId, text: task?.text ?? record?.text ?? thread.title,
      line: task?.line ?? record?.line ?? 0, threadId: threadId)
    return ThreadActionResponse()
  }

  func decideApproval(_ id: String, _ decision: ApprovalDecisionRequest) throws(DaemonClientError) -> ApprovalRequest {
    let id = try RequestGuards.runtimeID(id, "id")
    if let note = decision.note, note.utf16.count > 2000 {
      throw .invalidRequest("✖ Too big: expected string to have <=2000 characters\n  → at note")
    }
    guard var approval = approvals[id] else { throw .notFound("Approval not found") }
    guard approval.isPending else {
      throw .approvalConflict(ApprovalConflictResponse(message: "Approval is already \(approval.status)", approval: approval))
    }
    let approved = decision.decision == .approve
    approval.status = approved ? .approved : .denied
    approval.scope = decision.scope ?? .once
    if let note = decision.note, !note.isEmpty { approval.decisionNote = note }
    approval.decidedAt = nowMillis
    approvals[id] = approval
    emit(.approvalUpsert(approval))
    if let threadId = approval.threadId { emitThread(threadId) }
    emitStatus()
    if var job = jobs.values.first(where: { $0.waitingApproval == id }), let risky = job.script?.risky {
      job.waitingApproval = nil
      let author = job.script?.author ?? "orchestrator"
      job.beats = Array(job.beats[..<job.index])
        + decisionBeats(approved: approved, note: approval.decisionNote, risky, author: author)
      jobs[job.id] = job
      scheduleNextBeat(job.id)
    }
    return approval
  }

  // MARK: - Watching notes

  /// Tracks a note's tasks (ids survive moves and in-place edits) and schedules new open tasks of
  /// watched daily notes after the settle delay.
  func observeNote(_ path: String, content: String, initial: Bool = false) {
    guard simulation == .enabled else { return }
    let parsed = FakeTaskParser.tasks(in: content)
    let previous = tracked[path] ?? []
    var assigned: [Int: TrackedTask] = [:]
    var used: Set<String> = []
    // Like `trackTasks`: exact, then fuzzy (still typing, or similar), then an in-place rewrite.
    let passes: [(TrackedTask, FakeTaskParser.ParsedTask) -> Bool] = [
      { $0.text == $1.text && $0.line == $1.line },
      { $0.text == $1.text },
      { $0.line == $1.line && FakeTaskParser.isSameTaskEdited($0.text, $1.text, threshold: 0.5) },
      { FakeTaskParser.isSameTaskEdited($0.text, $1.text, threshold: 0.5) },
      { $0.line == $1.line && FakeTaskParser.diceSimilarity($0.text, $1.text) >= 0.3 },
    ]
    for matches in passes {
      for (index, task) in parsed.enumerated() where assigned[index] == nil {
        if let old = previous.first(where: { !used.contains($0.id) && matches($0, task) }) {
          assigned[index] = old
          used.insert(old.id)
        }
      }
    }
    var next: [TrackedTask] = []
    var candidates: [TrackedTask] = []
    var closed: [TrackedTask] = []
    for (index, task) in parsed.enumerated() {
      if let old = assigned[index] {
        let updated = TrackedTask(id: old.id, text: task.text, line: task.line, isOpen: task.isOpen)
        next.append(updated)
        if old.text != task.text || (!old.isOpen && task.isOpen) { candidates.append(updated) }
        if old.isOpen && !task.isOpen { closed.append(updated) }
      } else {
        let added = TrackedTask(id: nextID("tsk"), text: task.text, line: task.line, isOpen: task.isOpen)
        next.append(added)
        candidates.append(added)
      }
    }
    tracked[path] = next

    var changed = false
    for task in next {
      guard var record = records[task.id], record.line != task.line || record.text != task.text else { continue }
      let retitled = record.text != task.text
      record.line = task.line
      record.text = task.text
      records[task.id] = record
      if retitled, let threadId = record.threadId, threads[threadId] != nil {
        threads[threadId]?.title = task.text
        emitThread(threadId)
      }
      changed = true
    }
    for task in previous where !used.contains(task.id) {
      cancelSettle(task.id)
      if records[task.id] != nil {
        stopJob(task.id)
        records[task.id] = nil
        changed = true
      }
    }
    if changed { emitRecords(path) }

    guard !initial, settings.agent.enabled, watchedDate(of: path) != nil else { return }
    for task in candidates {
      if task.isOpen && !FakeTaskParser.isBlank(task.text) && records[task.id] == nil {
        scheduleSettle(task.id)
      } else {
        cancelSettle(task.id)
      }
    }
    for task in closed { cancelSettle(task.id) }
  }

  func forgetNote(_ path: String) {
    let tasks = tracked.removeValue(forKey: path) ?? []
    for task in tasks { cancelSettle(task.id) }
    var changed = false
    for record in recordsFor(path) {
      stopJob(record.taskId)
      records[record.taskId] = nil
      changed = true
    }
    if changed { emitRecords(path) }
  }

  func renameNote(from: String, to: String) {
    if let tasks = tracked.removeValue(forKey: from) { tracked[to] = tasks }
    let date = watchedDate(of: to)?.iso
    for var record in records.values where record.notePath == from {
      record.notePath = to
      record.date = date ?? record.date
      records[record.taskId] = record
    }
    for id in threads.keys where threads[id]?.notePath == from { threads[id]?.notePath = to }
    emitRecords(from)
    emitRecords(to)
  }

  /// The date of `path` when it is a daily note inside the agent's watch window.
  func watchedDate(of path: String) -> LocalDate? {
    let today = today
    let watch = settings.agent.watch
    for offset in (-watch.pastDays)...max(-watch.pastDays, watch.futureDays) {
      let date = today.adding(days: offset)
      if (try? calendar.dailyNotePath(date, settings.dailyNotes)) == path { return date }
    }
    return nil
  }

  func markRead(_ threadId: String) {
    guard let taskId = threads[threadId]?.taskId, let record = records[taskId], record.unread > 0 else { return }
    patchRecord(taskId) { $0.unread = 0 }
  }

  private func scheduleSettle(_ taskId: String) {
    let token = (settleTokens[taskId] ?? 0) + 1
    settleTokens[taskId] = token
    schedule(.settle(taskId: taskId, token: token), after: Double(settings.agent.settleMs))
  }

  private func cancelSettle(_ taskId: String) {
    settleTokens[taskId, default: 0] += 1
  }

  /// The settle delay passed without further edits: start working, unless the user is still
  /// typing on that line.
  func settled(_ taskId: String, token: Int) {
    guard settleTokens[taskId] == token, simulation == .enabled, settings.agent.enabled, records[taskId] == nil,
      let path = tracked.first(where: { $0.value.contains { $0.id == taskId } })?.key,
      let task = tracked[path]?.first(where: { $0.id == taskId }),
      task.isOpen, !FakeTaskParser.isBlank(task.text), watchedDate(of: path) != nil
    else { return }
    if let activity = editorActivity, activity.notePath == path, activity.line == task.line,
      nowMillis - activity.at < Double(settings.agent.settleMs)
    {
      scheduleSettle(taskId)
      return
    }
    startJob(path, taskId: taskId, text: task.text, line: task.line, threadId: nil)
  }

  // MARK: - Jobs

  func startJob(_ path: String, taskId: String, text: String, line: Int, threadId: String?) {
    let date = watchedDate(of: path)?.iso ?? records[taskId]?.date
    if records[taskId] == nil {
      // Like the runtime's `records.ensure`: a new task first appears as `idle`.
      records[taskId] = TaskAgentRecord(
        taskId: taskId, notePath: path, date: date, text: text, line: line, status: .idle, threadId: threadId,
        updatedAt: nowMillis, unread: 0)
      emitRecord(taskId)
      emitRecords(path)
    }
    let existing = records[taskId]
    var record = TaskAgentRecord(
      taskId: taskId, notePath: path, date: date, text: text, line: line, status: .triaging, summary: "Reading the task…",
      threadId: threadId ?? existing?.threadId, updatedAt: nowMillis, unread: existing?.unread ?? 0)
    if runningTaskJobs >= max(1, settings.agent.maxConcurrentSubagents) {
      record.status = .queued
      record.summary = "Waiting for a free agent"
      records[taskId] = record
      emitRecord(taskId)
      waitingJobs.append(QueuedJob(notePath: path, taskId: taskId, threadId: record.threadId))
      emitStatus()
      return
    }
    records[taskId] = record
    emitRecord(taskId)
    let script = AgentScript.forTask(text)
    jobGeneration += 1
    jobs[taskId] = Job(
      id: taskId, taskId: taskId, threadId: record.threadId, script: script, beats: taskBeats(script),
      generation: jobGeneration)
    emitStatus()
    scheduleNextBeat(taskId)
  }

  private func taskBeats(_ script: AgentScript) -> [Job.Beat] {
    var beats = [Job.Beat(delay: 700, step: .begin)]
    beats += say("orchestrator", "Picked this up — handing it to a **\(script.subagent)** subagent.")
    beats += say(script.author, script.intro)
    for step in script.steps {
      beats.append(Job.Beat(delay: 0, step: .toolStart(step)))
      if let page = step.page {
        beats.append(Job.Beat(delay: (step.durationMs / 2).rounded(.down), step: .frame(page)))
        beats.append(Job.Beat(delay: (step.durationMs / 2).rounded(.up), step: .toolFinish(.ok, preview: step.resultPreview)))
      } else {
        beats.append(Job.Beat(delay: step.durationMs, step: .toolFinish(.ok, preview: step.resultPreview)))
      }
    }
    beats.append(Job.Beat(delay: 0, step: .artifact(script.artifact)))
    if let risky = script.risky {
      let tool = AgentScript.ToolStep(
        toolName: risky.toolName, label: risky.toolLabel, input: risky.input, resultPreview: "", durationMs: 0)
      beats.append(Job.Beat(delay: 0, step: .toolStart(tool)))
      beats.append(Job.Beat(delay: 0, step: .requestApproval(risky)))
    } else {
      beats += say(script.author, script.finalText)
      beats.append(Job.Beat(delay: 0, step: .finish(.done, summary: script.doneSummary)))
    }
    return beats
  }

  private func decisionBeats(
    approved: Bool, note: String?, _ risky: AgentScript.RiskyAction, author: MessageAuthor
  ) -> [Job.Beat] {
    var beats = [Job.Beat(delay: 0, step: .resume(approved: approved))]
    if approved {
      beats.append(Job.Beat(delay: 800, step: .toolFinish(.ok, preview: "Done")))
      beats += say(author, risky.approvedText)
      beats.append(Job.Beat(delay: 0, step: .finish(.done, summary: risky.approvedSummary)))
    } else {
      beats.append(Job.Beat(delay: 0, step: .toolFinish(.blocked, preview: note.map { "Denied: \($0)" } ?? "Denied by you")))
      beats += say(author, risky.deniedText + (note.map { "\n\n> Your note: \($0)" } ?? ""))
      beats.append(Job.Beat(delay: 0, step: .finish(.done, summary: risky.deniedSummary)))
    }
    return beats
  }

  /// A streamed message: an empty streaming text, one delta per word (26 ms apart), the final text.
  private func say(_ author: MessageAuthor, _ text: String, after delay: Double = 0) -> [Job.Beat] {
    [Job.Beat(delay: delay, step: .textStart(author: author))]
      + text.streamingChunks.map { Job.Beat(delay: 26, step: .textDelta($0)) }
      + [Job.Beat(delay: 0, step: .textFinish(text))]
  }

  private func scheduleNextBeat(_ jobId: String) {
    guard let job = jobs[jobId], job.index < job.beats.count else { return }
    schedule(.beat(jobId: jobId, generation: job.generation), after: job.beats[job.index].delay)
  }

  func runBeat(_ jobId: String, generation: Int) {
    guard var job = jobs[jobId], job.generation == generation, job.index < job.beats.count, job.waitingApproval == nil
    else { return }
    let step = job.beats[job.index].step
    job.index += 1
    jobs[jobId] = job
    if perform(step, in: jobId) { scheduleNextBeat(jobId) }
  }

  /// Runs one beat; false when the job suspended or ended.
  private func perform(_ step: Job.Step, in jobId: String) -> Bool {
    guard var job = jobs[jobId] else { return false }
    switch step {
    case .begin:
      guard let taskId = job.taskId, let record = records[taskId], let script = job.script else {
        jobs[jobId] = nil
        return false
      }
      let threadId = job.threadId.flatMap { threads[$0] == nil ? nil : $0 }
        ?? createThread(taskId: taskId, notePath: record.notePath, title: record.text)
      job.threadId = threadId
      jobs[jobId] = job
      patchRecord(taskId) {
        $0.status = .working
        $0.summary = script.workingSummary
        $0.threadId = threadId
      }
      setThreadStatus(threadId, .working, "Started a \(script.subagent) subagent")
    case .textStart(let author):
      guard let threadId = job.threadId else { return false }
      let text = Job.StreamingText(id: nextID("msg"), author: author, createdAt: nowMillis, streamed: "")
      job.text = text
      jobs[jobId] = job
      pushMessage(
        threadId, .text(TextMessage(id: text.id, author: author, createdAt: nowMillis, role: .agent, text: "", streaming: true)))
    case .textDelta(let chunk):
      guard let threadId = job.threadId, var text = job.text else { return false }
      text.streamed += chunk
      job.text = text
      jobs[jobId] = job
      updateMessage(threadId, id: text.id) { message in
        if case .text(var body) = message {
          body.text = text.streamed
          message = .text(body)
        }
      }
      emit(.threadDelta(ThreadDeltaEvent(threadId: threadId, messageId: text.id, delta: chunk)))
    case .textFinish(let full):
      guard let threadId = job.threadId, let text = job.text else { return false }
      job.text = nil
      jobs[jobId] = job
      replaceMessage(threadId, Self.agentText(text.author, full, at: text.createdAt, id: text.id))
      bumpUnread(threadId)
    case .toolStart(let tool):
      guard let threadId = job.threadId else { return false }
      let message = ToolCallMessage(
        id: nextID("msg"), author: job.script?.author ?? "orchestrator", createdAt: nowMillis, toolCallId: nextID("call"),
        toolName: tool.toolName, label: tool.label, input: tool.input, status: .running)
      job.tool = message
      jobs[jobId] = job
      pushMessage(threadId, .toolCall(message))
      if let page = tool.page { showSurface(threadId, page) }
    case .frame(let page):
      guard let threadId = job.threadId else { return false }
      showSurface(threadId, page)
    case .toolFinish(let status, let preview):
      guard let threadId = job.threadId, var message = job.tool else { return false }
      message.status = status
      message.resultPreview = preview.isEmpty ? nil : preview
      message.endedAt = nowMillis
      job.tool = nil
      jobs[jobId] = job
      replaceMessage(threadId, .toolCall(message))
    case .artifact(let artifact):
      guard let threadId = job.threadId else { return false }
      addArtifact(threadId, artifact, author: job.script?.author ?? "orchestrator")
    case .requestApproval(let risky):
      guard let threadId = job.threadId, let taskId = job.taskId else { return false }
      let approval = ApprovalRequest(
        id: nextID("apr"), threadId: threadId, taskId: taskId, toolName: risky.toolName, toolLabel: risky.toolLabel,
        input: risky.input, summary: risky.summary, risk: risky.risk, categories: risky.categories, reason: risky.reason,
        status: .pending, createdAt: nowMillis, expiresAt: nowMillis + Double(settings.agent.approvalTimeoutMs))
      approvals[approval.id] = approval
      job.waitingApproval = approval.id
      jobs[jobId] = job
      emit(.approvalUpsert(approval))
      let marker = ApprovalMessage(id: nextID("msg"), author: "system", createdAt: nowMillis, approvalId: approval.id)
      pushMessage(threadId, .approval(marker))
      patchRecord(taskId) {
        $0.status = .waitingApproval
        $0.summary = "Needs approval"
      }
      setThreadStatus(threadId, .waitingApproval, "Waiting for your approval")
      emitStatus()
      return false
    case .resume(let approved):
      guard let threadId = job.threadId, let taskId = job.taskId else { return false }
      patchRecord(taskId) {
        $0.status = .working
        $0.summary = approved ? "Finishing up…" : "Wrapping up…"
      }
      setThreadStatus(threadId, .working, approved ? "Approved — continuing" : "Denied — skipping that step")
    case .finish(let status, let summary):
      jobs[jobId] = nil
      if let taskId = job.taskId {
        patchRecord(taskId) {
          $0.status = status
          if !summary.isEmpty { $0.summary = summary }
        }
      }
      if let threadId = job.threadId { setThreadStatus(threadId, status, status == .done ? "Task complete" : nil) }
      emitStatus()
      drainQueue()
      return false
    case .end:
      jobs[jobId] = nil
      return false
    }
    return true
  }

  /// Stops a job the user cancelled: running tool calls fail, streaming text is closed, a pending
  /// approval is cancelled.
  private func abort(_ job: Job) {
    jobs[job.id] = nil
    guard let threadId = job.threadId else { return }
    cancelApproval(of: job)
    if var tool = job.tool {
      tool.status = .error
      tool.resultPreview = "Cancelled"
      tool.endedAt = nowMillis
      replaceMessage(threadId, .toolCall(tool))
    }
    if let text = job.text {
      replaceMessage(threadId, Self.agentText(text.author, text.streamed, at: text.createdAt, id: text.id))
    }
  }

  /// Drops a task's job without a trace in its thread (the task was deleted from the note).
  func stopJob(_ taskId: String) {
    waitingJobs.removeAll { $0.taskId == taskId }
    guard let job = jobs.removeValue(forKey: taskId) else { return }
    cancelApproval(of: job)
    emitStatus()
    drainQueue()
  }

  private func cancelApproval(of job: Job) {
    guard let id = job.waitingApproval, var approval = approvals[id], approval.isPending else { return }
    approval.status = .cancelled
    approval.decidedAt = nowMillis
    approvals[id] = approval
    emit(.approvalUpsert(approval))
    if let threadId = approval.threadId { emitThread(threadId) }
  }

  private func drainQueue() {
    while !waitingJobs.isEmpty, runningTaskJobs < max(1, settings.agent.maxConcurrentSubagents) {
      let next = waitingJobs.removeFirst()
      guard let record = records[next.taskId], record.status == .queued else { continue }
      startJob(next.notePath, taskId: next.taskId, text: record.text, line: record.line, threadId: next.threadId)
    }
  }

  // MARK: - Threads, records and events

  func createThread(taskId: String?, notePath: String?, title: String) -> String {
    let id = nextID("thr")
    threads[id] = AgentThread(
      id: id, taskId: taskId, notePath: notePath, title: title, status: .triaging, createdAt: nowMillis,
      updatedAt: nowMillis)
    emitThread(id)
    return id
  }

  func pushMessage(_ threadId: String, _ message: ThreadMessage) {
    guard threads[threadId] != nil else { return }
    threads[threadId]?.messages.append(message)
    threads[threadId]?.updatedAt = nowMillis
    emit(.threadMessage(ThreadMessageEvent(threadId: threadId, message: message)))
    emitThread(threadId)
  }

  func replaceMessage(_ threadId: String, _ message: ThreadMessage) {
    guard let thread = threads[threadId] else { return }
    if let index = thread.messages.firstIndex(where: { $0.id == message.id }) {
      threads[threadId]?.messages[index] = message
    } else {
      threads[threadId]?.messages.append(message)
    }
    threads[threadId]?.updatedAt = nowMillis
    emit(.threadMessage(ThreadMessageEvent(threadId: threadId, message: message)))
    emitThread(threadId)
  }

  /// Updates a stored message without an event (streamed text between deltas).
  private func updateMessage(_ threadId: String, id: String, _ update: (inout ThreadMessage) -> Void) {
    guard var thread = threads[threadId], let index = thread.messages.firstIndex(where: { $0.id == id }) else { return }
    update(&thread.messages[index])
    threads[threadId] = thread
  }

  func setThreadStatus(_ threadId: String, _ status: TaskAgentStatus, _ text: String?) {
    guard threads[threadId] != nil else { return }
    threads[threadId]?.status = status
    pushMessage(threadId, Self.statusMessage(status, text, at: nowMillis, id: nextID("msg")))
  }

  /// A finished agent text message (`streaming: false`).
  static func agentText(_ author: MessageAuthor, _ text: String, at time: EpochMillis, id: String) -> ThreadMessage {
    .text(TextMessage(id: id, author: author, createdAt: time, role: .agent, text: text, streaming: false))
  }

  static func statusMessage(_ status: TaskAgentStatus, _ text: String?, at time: EpochMillis, id: String) -> ThreadMessage {
    .status(StatusMessage(id: id, author: "system", createdAt: time, status: status, text: text))
  }

  private func addArtifact(_ threadId: String, _ artifact: AgentScript.Artifact, author: MessageAuthor) {
    let id = nextID("art")
    let data = Data(artifact.content.utf8)
    let meta = ArtifactMeta(
      id: id, threadId: threadId, title: artifact.title, kind: .markdown, mimeType: "text/markdown",
      path: "\(FakeVaultPaths.sidecar)/artifacts/\(threadId)/\(id).md", size: data.count, createdAt: nowMillis)
    artifacts[id] = StoredArtifact(meta: meta, data: data)
    threads[threadId]?.artifacts.append(meta)
    pushMessage(threadId, .artifact(ArtifactMessage(id: nextID("msg"), author: author, createdAt: nowMillis, artifactId: id)))
  }

  private func showSurface(_ threadId: String, _ page: AgentScript.BrowserPage) {
    guard let thread = threads[threadId] else { return }
    if !thread.surfaces.contains(.browser) {
      threads[threadId]?.surfaces.append(.browser)
      emitThread(threadId)
    }
    let key = SurfaceKey(threadId: threadId, surface: .browser)
    surfaces[key] = page
    emitFrame(key, page)
  }

  func emitFrame(_ key: SurfaceKey, _ page: AgentScript.BrowserPage) {
    guard surfaceSubscriptions.contains(key) else { return }
    emit(
      .surfaceFrame(
        SurfaceFrame(
          threadId: key.threadId, surface: key.surface, mimeType: "image/png", data: AgentScript.framePNGBase64,
          width: AgentScript.frameSize.width, height: AgentScript.frameSize.height, url: page.url, title: page.title,
          action: SurfaceFrameAction(kind: page.action, x: 8, y: 5), ts: nowMillis)))
  }

  private func bumpUnread(_ threadId: String) {
    guard let taskId = threads[threadId]?.taskId, records[taskId] != nil else { return }
    patchRecord(taskId) { $0.unread += 1 }
  }

  func patchRecord(_ taskId: String, _ update: (inout TaskAgentRecord) -> Void) {
    guard var record = records[taskId] else { return }
    update(&record)
    record.updatedAt = nowMillis
    records[taskId] = record
    emitRecord(taskId)
  }

  func emitRecord(_ taskId: String) {
    if let record = records[taskId] { emit(.taskRecord(record)) }
  }

  func emitRecords(_ notePath: String) {
    emit(.taskRecords(TaskRecordsEvent(notePath: notePath, records: recordsFor(notePath))))
  }

  func emitThread(_ threadId: String) {
    if let thread = threads[threadId] { emit(.threadUpsert(summary(thread))) }
  }

  func emitStatus() {
    emit(.agentStatus(status()))
  }
}
