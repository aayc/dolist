import DailyDoListModels
import Foundation

/// The simulated orchestrator's activity state (see `FakeDaemon+Activity`).
struct FakeOrchestrator: Sendable {
  /// The latest turn's activity; `agent.status` carries it while the turn runs.
  var activity = OrchestratorActivity.idle
  /// Per note: the user's prose as of the last settle (the baseline for new lines).
  var settledProse: [String: [String]] = [:]
  /// Per note: request-like lines noticed and waiting for the settle delay.
  var noticed: [String: [OrchestratorTriggerLine]] = [:]
  var proseTokens: [String: Int] = [:]
}

/// What the orchestrator is doing, pushed as `orchestrator.activity` like the daemon does
/// (`docs/specs/orchestrator-activity.md`). A request-like line the user writes in a watched daily
/// note (`FakeProse.mayBeRequest`) is `noticed` at once; after the settle delay the orchestrator
/// wakes: `reading`, then `thinking`, then (for a request) `acting` while it adds a task for it
/// under the line, then `idle` with the outcome: "tasks_added", or "replied" for a question
/// (answered in its chat). Writing to it in its chat reports a `message` turn the same way.
extension FakeDaemon {
  /// Pushes a turn's activity; `status()` reports it until the turn is idle again.
  func emitActivity(_ activity: OrchestratorActivity) {
    orchestrator.activity = activity
    emit(.orchestratorActivity(activity))
  }

  /// The activity `agent.status` carries: the turn under way, if any.
  var reportedActivity: OrchestratorActivity? {
    orchestrator.activity.phase == .idle ? nil : orchestrator.activity
  }

  // MARK: Noticing

  /// Follows a note's prose with every version observed. Seeded notes and notes the agent doesn't
  /// watch only move the baseline. In a watched note, new request-like lines are `noticed` at once
  /// (with every line still waiting) and settle like tasks; if they go away first, an `idle`
  /// without outcome says so.
  func trackProse(_ path: String, content: String, watching: Bool) {
    let prose = FakeProse.userProse(content)
    guard watching, simulation == .enabled else {
      orchestrator.settledProse[path] = prose.map(\.text)
      cancelNoticed(path)
      return
    }
    let lines = FakeProse.newProse(prose, previous: orchestrator.settledProse[path] ?? [])
      .filter { FakeProse.mayBeRequest($0.text) }
    let before = orchestrator.noticed[path] ?? []
    guard lines != before else { return }
    guard !lines.isEmpty else {
      cancelNoticed(path)
      return
    }
    orchestrator.noticed[path] = lines
    let token = (orchestrator.proseTokens[path] ?? 0) + 1
    orchestrator.proseTokens[path] = token
    emit(
      .orchestratorActivity(
        OrchestratorActivity(phase: .noticed, trigger: noteTrigger(path, lines))))
    schedule(.proseSettle(path: path, token: token), after: Double(settings.agent.settleMs))
  }

  private func cancelNoticed(_ path: String) {
    guard let lines = orchestrator.noticed.removeValue(forKey: path) else { return }
    orchestrator.proseTokens[path, default: 0] += 1
    emit(
      .orchestratorActivity(OrchestratorActivity(phase: .idle, trigger: noteTrigger(path, lines))))
  }

  private func noteTrigger(_ path: String, _ lines: [OrchestratorTriggerLine])
    -> OrchestratorTrigger
  {
    OrchestratorTrigger(
      kind: .note, notePath: path, lines: lines, summary: FakeProse.summary(of: lines))
  }

  /// The settle delay passed: the orchestrator wakes for the noticed lines, unless the user is
  /// still typing on one of them.
  func proseSettled(_ path: String, token: Int) {
    guard orchestrator.proseTokens[path] == token, simulation == .enabled,
      settings.agent.enabled, let lines = orchestrator.noticed[path], !lines.isEmpty,
      let file = vault.file(path)
    else { return }
    if let activity = editorActivity, activity.notePath == path,
      lines.contains(where: { $0.line == activity.line }),
      nowMillis - activity.at < Double(settings.agent.settleMs)
    {
      schedule(.proseSettle(path: path, token: token), after: Double(settings.agent.settleMs))
      return
    }
    orchestrator.noticed[path] = nil
    orchestrator.settledProse[path] = FakeProse.userProse(file.content).map(\.text)
    startProseTurn(path, lines: lines)
  }

  // MARK: Turns

  /// One turn for a note's request-like lines: questions get an answer in the chat, anything else
  /// a task under its line.
  func startProseTurn(_ path: String, lines: [OrchestratorTriggerLine]) {
    guard threads[OrchestratorThread.id] != nil else { return }
    let questions = lines.filter { FakeProse.isQuestion($0.text) }
    let requests = lines.filter { !FakeProse.isQuestion($0.text) }
    let count = lines.count == 1 ? "1 line" : "\(lines.count) lines"
    var beats = [
      Job.Beat(delay: 0, step: .turn("\(path) changed: \(count)")),
      Job.Beat(delay: 600, step: .phase(.thinking)),
    ]
    var outcome = OrchestratorOutcome(kind: .replied, text: "Answered in the orchestrator chat")
    if !requests.isEmpty {
      let tasks = requests.map { FakeProse.taskText(for: $0.text) }
      let added = tasks.count == 1 ? "1 task" : "\(tasks.count) tasks"
      beats += [
        Job.Beat(delay: 1_200, step: .phase(.acting)),
        Job.Beat(
          delay: 0,
          step: .toolStart(
            AgentScript.ToolStep(
              toolName: "edit_note", label: "Edit note",
              input: [
                "notePath": .string(path), "add": .array(tasks.map { .string("- [ ] \($0)") }),
              ],
              resultPreview: "", durationMs: 0))),
        Job.Beat(delay: 500, step: .addTasks(notePath: path, lines: requests)),
        Job.Beat(delay: 0, step: .toolFinish(.ok, preview: "Added \(added)")),
      ]
      outcome = OrchestratorOutcome(
        kind: .tasksAdded, count: tasks.count,
        text: tasks.count == 1 ? "Added “\(Self.excerpt(tasks[0]))” to your list" : "Added \(added)"
      )
    }
    if !questions.isEmpty {
      beats += say("orchestrator", Self.answer(questions), after: requests.isEmpty ? 1_200 : 200)
    }
    beats.append(Job.Beat(delay: 0, step: .outcome(outcome)))
    jobGeneration += 1
    let jobId = nextID("turn")
    jobs[jobId] = Job(
      id: jobId, taskId: nil, threadId: OrchestratorThread.id, script: nil, beats: beats,
      generation: jobGeneration,
      activity: OrchestratorActivity(phase: .reading, trigger: noteTrigger(path, lines)))
    scheduleNextBeat(jobId)
  }

  private static func answer(_ questions: [OrchestratorTriggerLine]) -> String {
    let asked =
      questions.count == 1
      ? "“\(excerpt(FakeProse.stripped(questions[0].text)))”" : "\(questions.count) questions"
    return "You asked \(asked) — the demo agent can't look things up, so this is where its answer "
      + "would be."
  }

  /// The turn's status line is posted: it reads the note, with that message as the turn's id.
  func startTurnActivity(turnId: String, in jobId: String) {
    guard var activity = jobs[jobId]?.activity else { return }
    activity.phase = .reading
    activity.turnId = turnId
    activity.startedAt = nowMillis
    jobs[jobId]?.activity = activity
    emitActivity(activity)
  }

  func setTurnPhase(_ phase: OrchestratorPhase, in jobId: String) {
    guard var activity = jobs[jobId]?.activity else { return }
    activity.phase = phase
    jobs[jobId]?.activity = activity
    emitActivity(activity)
  }

  /// The turn is over: `idle` with what it did, and the chat's status back to idle.
  func finishTurn(_ outcome: OrchestratorOutcome, in jobId: String) {
    let job = jobs.removeValue(forKey: jobId)
    if var activity = job?.activity {
      activity.phase = .idle
      activity.outcome = outcome
      emitActivity(activity)
    }
    endOrchestratorTurn()
  }

  /// Adds `- [ ] <request>` under each request line (where it is now), as lines the orchestrator
  /// wrote; they're tasks like any other from then on.
  func addRequestTasks(_ path: String, lines: [OrchestratorTriggerLine]) {
    guard let file = vault.file(path) else { return }
    var rows = file.content.textLines.map(String.init)
    let placed = lines.map { line -> (at: Int, text: String) in
      let candidates = rows.indices.filter {
        rows[$0].trimmingCharacters(in: .whitespaces) == line.text
      }
      let at = candidates.min { abs($0 - line.line) < abs($1 - line.line) } ?? rows.count - 1
      return (at, line.text)
    }
    for (at, text) in placed.sorted(by: { $0.at > $1.at }) {
      let indent = at < rows.count ? String(rows[at].prefix { $0 == " " || $0 == "\t" }) : ""
      let task = FakeAgentText.mark(
        "\(indent)- [ ] \(FakeProse.taskText(for: text))", threadId: OrchestratorThread.id)
      rows.insert(task, at: min(at + 1, rows.count))
    }
    let content = rows.joined(separator: "\n")
    let (stored, _) = vault.store(path, content, mtime: nowMillis)
    emitVaultChange(
      [VaultChange(path: path, kind: .modified, version: stored.version)], origin: .agent)
    observeNote(path, content: content)
  }
}
