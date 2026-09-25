import DailyDoListModels
import Foundation

/// What the scheduler keeps about a routine besides its file (the daemon's sidecar state).
struct FakeRoutineState: Sendable {
  var lastRun: RoutineRun?
  var runCount = 0
  /// `YYYY-MM-DD` of `extraRunsUsed`.
  var extraRunsDate: String?
  var extraRunsUsed = 0
}

/// Routines like the daemon's: one file per routine in `Routines/`, read on demand (so edits,
/// renames and deletes apply at once), a run per Run Now as a thread with `routineId`, pausing by
/// rewriting the file's `paused:` line, and `routines.changed` whenever a file or a run changes.
///
/// Runs follow the task scripts (a routine whose instructions order, book or send something waits
/// on an approval) and report on odd-numbered runs that something changed. Schedules only compute
/// `nextRunAt`: the fake doesn't start runs on its own.
extension FakeDaemon {
  static let extraRunsPerDay = 5

  /// `ROUTINE_TEMPLATES` of `@ddl/core`.
  static let templates: [RoutineTemplate] = [
    RoutineTemplate(
      id: "morning-briefing", name: "Morning briefing",
      description: "Your day at a glance: calendar, weather, leftovers and news.",
      schedule: "every weekday at 7:30", notify: .always, uses: [.web, .connectors],
      instructions:
        "Brief me for the day: my calendar, the weather where I am, what I didn't finish yesterday (from yesterday's daily note), and anything new from my news sources. Under 10 lines."
    ),
    RoutineTemplate(
      id: "weekly-review", name: "Weekly review",
      description: "Sunday evening: what got done, what slipped, what's next.",
      schedule: "every sunday at 18:00", notify: .always, uses: [],
      instructions:
        "Review my week from this week's daily notes: what got done, what slipped and why, and what to carry into next week. End with my top 3 priorities for the coming week."
    ),
    RoutineTemplate(
      id: "carry-over", name: "Carry over unfinished tasks",
      description: "Moves yesterday's open tasks into today's note.",
      schedule: "every day at 6:00", notify: .whenChanged, uses: [],
      instructions:
        "Read yesterday's daily note and add its unfinished tasks (open checkboxes) to today's note under a “Carried over” heading, as your own lines. If there were none, say so and change nothing."
    ),
    RoutineTemplate(
      id: "price-watch", name: "Price watch",
      description: "Checks a price or stock level and tells you when it moves.",
      schedule: "every 2 hours", notify: .whenChanged, uses: [.web],
      instructions:
        "Check the price and availability of <product> at <store link>. Tell me when the price drops below <amount> or it comes back in stock; otherwise report the current price in one line."
    ),
    RoutineTemplate(
      id: "news-digest", name: "News digest",
      description: "Evening digest of the topics you follow, with links.",
      schedule: "every day at 18:00", notify: .always, uses: [.web],
      instructions:
        "Summarize today's most important news about <topics> from reputable sources: 5 bullets, one line each, each with its link. Skip anything I've already seen in earlier digests."
    ),
    RoutineTemplate(
      id: "inbox-triage", name: "Inbox triage",
      description: "Sorts new email twice a day and drafts easy replies.",
      schedule: "every weekday at 9:00 and 14:00", notify: .whenChanged, uses: [.connectors],
      instructions:
        "Go through my new email since the last run: list what needs a reply today, draft replies for the simple ones (save them as drafts, never send), and flag anything urgent."
    ),
  ]

  // MARK: - Queries

  var routinePaths: [String] {
    vault.files.keys.filter(FakeRoutineFile.isRoutinePath).sorted {
      FakeRoutineFile.name(ofPath: $0).localizedStandardCompare(FakeRoutineFile.name(ofPath: $1))
        == .orderedAscending
    }
  }

  func routineList() -> [Routine] {
    routinePaths.compactMap(routine(atPath:))
  }

  func routine(atPath path: String) -> Routine? {
    guard let content = vault.file(path)?.content else { return nil }
    let file = FakeRoutineFile(content: content)
    let id = FakeRoutineFile.id(forPath: path)
    let state = routineStates[id] ?? FakeRoutineState()
    let error = file.problems.first
    let next =
      file.paused || error != nil
      ? nil : file.parsedSchedule?.nextRun(after: now, calendar: calendar)?.epochMillis
    let used = state.extraRunsDate == today.iso ? state.extraRunsUsed : 0
    return Routine(
      id: id, path: path, name: FakeRoutineFile.name(ofPath: path), schedule: file.schedule ?? "",
      scheduleText: file.parsedSchedule?.text, notify: file.notify, uses: file.uses,
      paused: file.paused, instructions: file.instructions, error: error, nextRunAt: next,
      lastRun: state.lastRun, runCount: state.runCount,
      extraRunsLeft: max(0, Self.extraRunsPerDay - used))
  }

  func routinePath(id: String) throws(DaemonClientError) -> String {
    let id = try RequestGuards.runtimeID(id, "id")
    guard let path = routinePaths.first(where: { FakeRoutineFile.id(forPath: $0) == id }) else {
      throw .notFound("Routine not found")
    }
    return path
  }

  func routineResponse(_ id: String) throws(DaemonClientError) -> Routine {
    guard let routine = routine(atPath: try routinePath(id: id)) else {
      throw .notFound("Routine not found")
    }
    return routine
  }

  func routineRuns(_ routineId: String) -> [ThreadSummary] {
    threads.values.filter { $0.routineId == routineId }
      .sorted { ($0.createdAt, $0.id) > ($1.createdAt, $1.id) }
      .map(summary)
  }

  func emitRoutines() {
    emit(.routinesChanged(routineList()))
  }

  // MARK: - Files

  func createRoutine(_ request: CreateRoutineRequest) throws(DaemonClientError) -> Routine {
    let name = request.name.trimmingCharacters(in: .whitespaces)
    if let problem = FakeRoutineFile.nameProblem(name) { throw .invalidPath(problem) }
    let instructions = request.instructions.trimmingCharacters(in: .whitespacesAndNewlines)
    if instructions.isEmpty {
      throw .invalidRequest(
        "✖ Too small: expected string to have >=1 characters\n  → at instructions")
    }
    if case .failure(let error) = FakeRoutineSchedule.parse(request.schedule) {
      throw .invalidRequest(error.message)
    }
    let path = FakeRoutineFile.path(forName: name)
    if vault.file(path) != nil
      || routinePaths.contains(where: { $0.lowercased() == path.lowercased() })
    {
      throw .http(
        status: 409,
        body: ApiErrorBody(error: .conflict, message: "A routine named “\(name)” already exists."))
    }
    let content = FakeRoutineFile.render(request)
    let stored: (file: FakeVault.File, created: Bool)
    do {
      stored = try vault.write(path, content, base: .createOnly, mtime: nowMillis)
    } catch {
      throw Self.internalError()
    }
    emitVaultChange(
      [VaultChange(path: path, kind: .created, version: stored.file.version)], origin: .client)
    guard let routine = routine(atPath: path) else { throw Self.internalError() }
    return routine
  }

  func setRoutinePaused(_ id: String, _ paused: Bool) throws(DaemonClientError) -> Routine {
    let path = try routinePath(id: id)
    guard let file = vault.file(path) else { throw .notFound("Routine not found") }
    let content = FakeRoutineFile.settingPaused(paused, in: file.content)
    if content != file.content {
      let stored = vault.store(path, content, mtime: nowMillis)
      emitVaultChange(
        [VaultChange(path: path, kind: .modified, version: stored.file.version)], origin: .client)
    }
    guard let routine = routine(atPath: path) else { throw .notFound("Routine not found") }
    return routine
  }

  // MARK: - Runs

  func runRoutine(_ id: String) throws(DaemonClientError) -> RoutineRunResponse {
    let path = try routinePath(id: id)
    guard let routine = routine(atPath: path), let content = vault.file(path)?.content else {
      throw .notFound("Routine not found")
    }
    guard simulation == .enabled else { throw Self.agentUnavailable() }
    try requireAgentReachable()
    guard settings.agent.enabled else {
      throw .http(
        status: 503,
        body: ApiErrorBody(
          error: .agentUnavailable, message: "The agent is paused. Resume it to run routines."))
    }
    if routine.isRunning {
      throw Self.cantRun("“\(routine.name)” is already running.")
    }
    if let error = routine.error {
      throw Self.cantRun("“\(routine.name)” has a problem: \(error)")
    }
    if routine.extraRunsLeft == 0 {
      throw Self.cantRun(
        "“\(routine.name)” has used today's \(Self.extraRunsPerDay) extra runs. It runs again at its next scheduled time."
      )
    }
    var state = routineStates[id] ?? FakeRoutineState()
    if state.extraRunsDate != today.iso {
      state.extraRunsDate = today.iso
      state.extraRunsUsed = 0
    }
    state.extraRunsUsed += 1
    state.runCount += 1
    let runId = nextID("run")
    let threadId = nextID("thr")
    threads[threadId] = AgentThread(
      id: threadId, taskId: runId, notePath: path, title: routine.name, status: .working,
      createdAt: nowMillis, updatedAt: nowMillis, routineId: id)
    state.lastRun = RoutineRun(
      threadId: threadId, trigger: .manual, status: .working, startedAt: nowMillis)
    routineStates[id] = state
    emitThread(threadId)
    pushMessage(threadId, Self.statusMessage(.working, "Run now", at: nowMillis, id: nextID("msg")))
    startRunJob(
      runId: runId, threadId: threadId, file: FakeRoutineFile(content: content), name: routine.name,
      changed: state.runCount % 2 == 1)
    emitStatus()
    emitRoutines()
    guard let started = self.routine(atPath: path) else { throw Self.internalError() }
    return RoutineRunResponse(routine: started, threadId: threadId)
  }

  static func cantRun(_ message: String) -> DaemonClientError {
    .http(status: 409, body: ApiErrorBody(error: .conflict, message: message))
  }

  private func startRunJob(
    runId: String, threadId: String, file: FakeRoutineFile, name: String, changed: Bool
  ) {
    var script = AgentScript.forTask(file.instructions)
    script.intro = "Running **\(name)**: \(AgentScript.topicOf(file.instructions))"
    script.steps = Array(script.steps.prefix(1))
    script.noteLine = nil
    script.finalText =
      changed
      ? "Here's what's new since the last run:\n\n- 2 new items worth a look\n- 1 price changed\n\nDetails are in the notes above."
      : "Nothing new since the last run."
    script.doneSummary = changed ? "Something new" : "Nothing new"
    var beats = say(script.author, script.intro, after: 600)
    for step in script.steps {
      beats.append(Job.Beat(delay: 0, step: .toolStart(step)))
      beats.append(
        Job.Beat(delay: step.durationMs, step: .toolFinish(.ok, preview: step.resultPreview)))
    }
    if let risky = script.risky {
      let tool = AgentScript.ToolStep(
        toolName: risky.toolName, label: risky.toolLabel, input: risky.input, resultPreview: "",
        durationMs: 0)
      beats.append(Job.Beat(delay: 0, step: .toolStart(tool)))
      beats.append(Job.Beat(delay: 0, step: .requestApproval(risky)))
    } else {
      beats += say(script.author, script.finalText)
      beats.append(Job.Beat(delay: 0, step: .finish(.done, summary: script.doneSummary)))
    }
    jobGeneration += 1
    jobs[runId] = Job(
      id: runId, taskId: runId, threadId: threadId, script: script, beats: beats,
      generation: jobGeneration)
    runChanges[threadId] = changed
    scheduleNextBeat(runId)
  }

  /// Retry on a run's thread: the same run goes again.
  func retryRun(_ threadId: String) {
    guard let thread = threads[threadId], let routineId = thread.routineId,
      let runId = thread.taskId, jobs[runId] == nil,
      let path = try? routinePath(id: routineId), let content = vault.file(path)?.content
    else { return }
    setThreadStatus(threadId, .working, "Trying again")
    startRunJob(
      runId: runId, threadId: threadId, file: FakeRoutineFile(content: content),
      name: thread.title, changed: runChanges[threadId] ?? true)
    emitStatus()
  }

  /// Keeps a routine's last run in step with its thread's status.
  func syncRoutineRun(_ threadId: String) {
    guard let thread = threads[threadId], let routineId = thread.routineId,
      var state = routineStates[routineId], var run = state.lastRun, run.threadId == threadId,
      run.status != thread.status
    else { return }
    run.status = thread.status
    if thread.status.isActive {
      run.finishedAt = nil
    } else if run.finishedAt == nil {
      run.finishedAt = nowMillis
    }
    state.lastRun = run
    routineStates[routineId] = state
    emitRoutines()
  }

  /// A run's work ended: record its result and notify per the routine's `notify`.
  func finishRun(_ threadId: String, status: TaskAgentStatus, summary: String) {
    guard let thread = threads[threadId], let routineId = thread.routineId,
      var state = routineStates[routineId], var run = state.lastRun, run.threadId == threadId
    else { return }
    let changed = runChanges[threadId] ?? true
    run.status = status
    run.finishedAt = run.finishedAt ?? nowMillis
    if !summary.isEmpty { run.summary = summary }
    run.changed = changed
    state.lastRun = run
    routineStates[routineId] = state
    emitRoutines()
    let file = (try? routinePath(id: routineId)).flatMap { vault.file($0) }.map {
      FakeRoutineFile(content: $0.content)
    }
    guard Self.shouldNotify(file?.notify ?? .always, status: status, changed: changed) else {
      return
    }
    let body: String =
      switch status {
      case .failed: "Failed: \(summary)"
      case .waitingUser: "Needs you: \(summary)"
      default: changed ? "2 new items worth a look · 1 price changed" : "Nothing new."
      }
    emit(
      .routineNotification(
        RoutineNotification(
          routineId: routineId, title: thread.title, body: body, threadId: threadId,
          status: status, at: nowMillis)))
  }

  /// `shouldNotify` of the daemon's scheduler.
  static func shouldNotify(_ notify: RoutineNotify, status: TaskAgentStatus, changed: Bool) -> Bool
  {
    if notify == .never { return false }
    switch status {
    case .failed, .waitingUser: return true
    case .done: return notify == .always || changed
    default: return false
    }
  }

  // MARK: - Seed

  static let demoRoutines: [(name: String, content: String, runs: Int)] = [
    (
      "Morning briefing",
      """
      ---
      schedule: every weekday at 7:30
      notify: always
      uses: [web, connectors]
      ---
      Brief me for the day: my calendar, the weather where I am, what I didn't finish yesterday (from yesterday's daily note), and anything new from my news sources. Under 10 lines.

      """,
      3
    ),
    (
      "Price watch",
      """
      ---
      schedule: every 2 hours
      notify: when changed
      uses: [web]
      paused: true
      ---
      Check the price and availability of the example kettle at https://shop.example.com/kettle. Tell me when it drops below $80.

      """,
      2
    ),
    (
      "Weekly review",
      """
      ---
      schedule: every sunday at 18:00
      notify: always
      ---
      Review my week from this week's daily notes: what got done, what slipped, and my top 3 priorities for next week.

      """,
      0
    ),
    (
      "Someday",
      """
      ---
      schedule: whenever I have time
      ---
      Tidy up the Ideas note.

      """,
      0
    ),
  ]

  /// Routine files with a few finished runs each (demo seed; the disabled simulation, like the
  /// daemon without an agent runtime, has the files but no runs).
  func seedDemoRoutines(mtime: EpochMillis) {
    for routine in Self.demoRoutines {
      let path = FakeRoutineFile.path(forName: routine.name)
      vault.store(path, routine.content, mtime: mtime)
      let file = FakeRoutineFile(content: routine.content)
      guard simulation == .enabled, routine.runs > 0, let schedule = file.parsedSchedule else {
        continue
      }
      let id = FakeRoutineFile.id(forPath: path)
      var state = FakeRoutineState()
      var at = nowMillis - 3 * 86_400_000
      for index in 0..<routine.runs {
        guard let slot = schedule.nextRun(after: Date(epochMillis: at), calendar: calendar),
          slot.epochMillis < nowMillis
        else { break }
        at = slot.epochMillis
        let changed = index % 2 == 0
        let threadId = seedRun(
          routineId: id, path: path, name: routine.name, at: at, schedule: schedule.text,
          changed: changed)
        state.runCount += 1
        state.lastRun = RoutineRun(
          threadId: threadId, trigger: .schedule, status: .done, startedAt: at,
          finishedAt: at + 45_000, summary: changed ? "Something new" : "Nothing new",
          changed: changed)
      }
      routineStates[id] = state
    }
  }

  private func seedRun(
    routineId: String, path: String, name: String, at: EpochMillis, schedule: String,
    changed: Bool
  ) -> String {
    let threadId = nextID("thr")
    let report =
      changed
      ? "Good morning! **3 meetings** today (first at 9:30), 68°F and sunny. Carried over: *call the plumber*. News: 2 new posts from your sources."
      : "Nothing new since the last run."
    threads[threadId] = AgentThread(
      id: threadId, taskId: nextID("run"), notePath: path, title: name, status: .done,
      createdAt: at, updatedAt: at + 45_000,
      messages: [
        Self.statusMessage(.working, "Scheduled run · \(schedule)", at: at, id: nextID("msg")),
        Self.agentText("subagent:research", report, at: at + 40_000, id: nextID("msg")),
        Self.statusMessage(.done, "Run complete", at: at + 45_000, id: nextID("msg")),
      ], routineId: routineId)
    runChanges[threadId] = changed
    return threadId
  }
}
