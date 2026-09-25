import DailyDoListClient
import DailyDoListModels
import Foundation

// Routines: standing jobs the agent runs on a schedule. The list comes from `GET /api/routines`
// and `routines.changed`; each routine's runs are threads (with `routineId`) kept live like any
// other. Actions never throw: Run Now, Pause and Resume leave a `RoutineAlert` on the routine
// when they fail, and creating one returns the error for the form's field.

extension AgentStore {
  /// How many `routine.notification`s `routineNotifications` keeps.
  public static let routineNotificationLimit = 50

  // MARK: Queries

  public func routine(_ id: String) -> Routine? {
    routines.first { $0.id == id }
  }

  /// A routine's runs, newest first.
  public func runs(ofRoutine routineId: String) -> [ThreadSummary] {
    _ = threads
    return state.runs(ofRoutine: routineId)
  }

  /// The routine a thread is a run of (nil for task threads).
  public func routineId(forThread threadId: String) -> String? {
    _ = threads
    _ = loadedThreads
    return state.routineId(ofThread: threadId)
  }

  // MARK: Loading

  /// Fetches the routines and the starter templates. Failures show in the Routines view
  /// (`routinesLoadError`), not as a toast.
  public func loadRoutines() async {
    let mark = eventSeq
    do {
      let list = try await client.routines()
      applyFetchedRoutines(list, since: mark)
    } catch {
      if case DaemonClientError.cancelled = error { return }
      routinesLoadError = AgentAlert.describe(error)
    }
  }

  func applyFetchedRoutines(_ list: RoutineListResponse, since mark: UInt64) {
    // A `routines.changed` push arrived while we waited: it's newer.
    if routinesTouch <= mark { mutate { $0.setRoutines(list.routines) } }
    if routineTemplates != list.templates { routineTemplates = list.templates }
    routinesLoaded = true
    routinesLoadError = nil
  }

  /// Fetches a routine's runs; `refresh()` refetches them from then on (events keep them live).
  public func loadRuns(ofRoutine routineId: String) async {
    trackedRoutines.insert(routineId)
    let mark = eventSeq
    do {
      let runs = try await client.threads(routineId: routineId)
      applyFetchedRuns(runs, routineId: routineId, since: mark)
    } catch {
      report(error, title: "Couldn't load the routine's runs")
    }
  }

  func applyFetchedRuns(_ runs: [ThreadSummary], routineId: String, since mark: UInt64) {
    let preserving = touchedIds(threadTouches, since: mark)
    mutate { $0.applyRoutineRuns(runs, routineId: routineId, preserving: preserving) }
  }

  // MARK: Actions

  /// Runs a routine now. On success the run's thread id; on failure nil, with the reason in
  /// `routineAlerts[id]` (a run in progress, a problem, no extra runs left, the agent off…).
  @discardableResult
  public func runRoutine(_ id: String) async -> String? {
    guard !busyRoutineIds.contains(id) else { return nil }
    busyRoutineIds.insert(id)
    defer { busyRoutineIds.remove(id) }
    routineAlerts[id] = nil
    let mark = eventSeq
    do {
      let response = try await client.runRoutine(id)
      if routinesTouch <= mark { mutate { $0.upsertRoutine(response.routine) } }
      await loadRuns(ofRoutine: id)
      return response.threadId
    } catch {
      if case DaemonClientError.cancelled = error { return nil }
      routineAlerts[id] = RoutineAlert.run(
        error, routine: routine(id), agentProblem: unavailableReason)
      return nil
    }
  }

  /// Pauses or resumes a routine (optimistic; rolls back and leaves an alert on failure).
  @discardableResult
  public func setRoutinePaused(_ id: String, _ paused: Bool) async -> Bool {
    guard !busyRoutineIds.contains(id) else { return false }
    busyRoutineIds.insert(id)
    defer { busyRoutineIds.remove(id) }
    routineAlerts[id] = nil
    let previous = routine(id)
    var optimistic: Routine?
    if var next = previous {
      next.paused = paused
      if paused { next.nextRunAt = nil }
      optimistic = next
      mutate { $0.upsertRoutine(next) }
    }
    let mark = eventSeq
    do {
      let updated =
        paused ? try await client.pauseRoutine(id) : try await client.resumeRoutine(id)
      if routinesTouch <= mark { mutate { $0.upsertRoutine(updated) } }
      return true
    } catch {
      if let previous, let optimistic, routine(id) == optimistic {
        mutate { $0.upsertRoutine(previous) }
      }
      if case DaemonClientError.cancelled = error { return false }
      routineAlerts[id] = RoutineAlert.pause(error, routine: previous, paused: paused)
      return false
    }
  }

  /// Creates `Routines/<name>.md`. The error says which field of the form it's about.
  public func createRoutine(_ request: CreateRoutineRequest) async -> Result<
    Routine, RoutineFormError
  > {
    do {
      let routine = try await client.createRoutine(request)
      mutate { $0.upsertRoutine(routine) }
      return .success(routine)
    } catch {
      return .failure(RoutineFormError(error))
    }
  }

  /// Clears a routine's alert (only if it is still `alertId`, when given).
  public func dismissRoutineAlert(_ routineId: String, alertId: UUID? = nil) {
    guard let alert = routineAlerts[routineId], alertId == nil || alert.id == alertId else {
      return
    }
    routineAlerts[routineId] = nil
  }

  // MARK: Events

  func receive(_ notification: RoutineNotification) {
    routineNotifications.append(notification)
    let excess = routineNotifications.count - Self.routineNotificationLimit
    if excess > 0 { routineNotifications.removeFirst(excess) }
  }
}

// MARK: - Starting points for "New Routine…"

/// What the New Routine sheet starts from: blank, a starter template, or a finished task ("Repeat
/// this"). The user confirms every field, the schedule especially.
public struct RoutineDraft: Hashable, Sendable {
  public var name: String
  public var schedule: String
  public var instructions: String
  public var notify: RoutineNotify
  public var uses: [RoutineUse]
  /// The template it came from, if any.
  public var templateId: String?

  public init(
    name: String = "", schedule: String = "", instructions: String = "",
    notify: RoutineNotify = .always, uses: [RoutineUse] = [], templateId: String? = nil
  ) {
    self.name = name
    self.schedule = schedule
    self.instructions = instructions
    self.notify = notify
    self.uses = uses
    self.templateId = templateId
  }

  public init(template: RoutineTemplate) {
    self.init(
      name: template.name, schedule: template.schedule, instructions: template.instructions,
      notify: template.notify, uses: template.uses, templateId: template.id)
  }

  /// "Repeat this" on a finished task: its text becomes the instructions and the name; the
  /// schedule is left for the user to choose.
  public init(repeating title: String, result: String? = nil) {
    let task = title.trimmingCharacters(in: .whitespacesAndNewlines)
    var instructions = task
    if let result = result?.trimmingCharacters(in: .whitespacesAndNewlines), !result.isEmpty {
      instructions += "\n\nLast time's result, for comparison:\n\(result)"
    }
    self.init(name: Self.name(from: task), instructions: instructions)
  }

  /// A file name from a task's text: the first line, without characters a routine name can't
  /// have, at most 60 characters.
  static func name(from text: String) -> String {
    let forbidden = Set(#"\/:*?"<>|#^[]"#)
    let firstLine = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
    var name = String(firstLine.filter { !forbidden.contains($0) && !$0.isNewline })
      .split(whereSeparator: \.isWhitespace).joined(separator: " ")
    while name.hasPrefix(".") { name.removeFirst() }
    if name.count > 60 {
      name = String(name.prefix(60)).trimmingCharacters(in: .whitespaces)
    }
    return name
  }

  /// The request the sheet sends (text trimmed).
  public var request: CreateRoutineRequest {
    CreateRoutineRequest(
      name: name.trimmingCharacters(in: .whitespaces),
      schedule: schedule.trimmingCharacters(in: .whitespacesAndNewlines),
      instructions: instructions.trimmingCharacters(in: .whitespacesAndNewlines), notify: notify,
      uses: uses.isEmpty ? nil : uses)
  }

  /// Every field the daemon needs is filled in.
  public var isComplete: Bool {
    let request = self.request
    return !request.name.isEmpty && !request.schedule.isEmpty && !request.instructions.isEmpty
  }
}
