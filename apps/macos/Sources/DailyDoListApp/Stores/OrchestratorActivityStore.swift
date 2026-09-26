import DailyDoListModels
import DailyDoListUI
import Foundation
import Observation

/// What the orchestrator is doing, for the editor's chips, the note header and the status bar.
/// Fed every `orchestrator.activity` event (and the activity an `agent.status` carries); adds the
/// timers: a turn's outcome shows for a few seconds ("Nothing to do" sooner) and then fades, and
/// noticed lines that nothing followed are let go.
@MainActor
@Observable
final class OrchestratorActivityStore {
  /// How long a turn's outcome stays on its lines before fading.
  static let outcomeHold: TimeInterval = 6
  /// "Nothing to do" goes sooner.
  static let nothingToDoHold: TimeInterval = 2.5
  /// A fading chip is removed once the editor's fade (0.4 s) is over.
  static let fadeDuration: TimeInterval = 0.5
  /// A noticed line nothing followed (a missed event, an older daemon) stops showing its dot.
  static let noticedExpiry: TimeInterval = 60

  private(set) var board = OrchestratorChipBoard()
  /// The turn under way (reading, thinking, acting), nil while the orchestrator is idle.
  private(set) var working: OrchestratorActivity?
  /// Events applied so far: a snapshot fetched before the latest event is older than it.
  @ObservationIgnored private(set) var eventCount = 0
  /// The notes whose chips changed (the editor refreshes its badges).
  @ObservationIgnored var onChipsChanged: (@MainActor (Set<String>) -> Void)?
  @ObservationIgnored private let scheduler: AppScheduler
  @ObservationIgnored private var timers: [String: ScheduledAction] = [:]

  init(scheduler: AppScheduler) {
    self.scheduler = scheduler
  }

  var chips: [OrchestratorChip] { board.chips }

  func chips(for notePath: String) -> [OrchestratorChip] { board.chips(for: notePath) }

  func chip(_ id: String) -> OrchestratorChip? { board.chip(id) }

  /// The turn under way when it's about `notePath`.
  func working(on notePath: String) -> OrchestratorActivity? {
    working?.trigger?.notePath == notePath ? working : nil
  }

  /// One `orchestrator.activity` event (or the activity an `agent.status` push carries).
  func apply(_ activity: OrchestratorActivity) {
    eventCount += 1
    receive(activity)
  }

  /// The activity fetched with the agent's status (at launch, after a reconnect), unless an event
  /// arrived since `mark`. Nil or idle means nothing is under way: unfinished chips go.
  func adopt(_ snapshot: OrchestratorActivity?, since mark: Int) {
    guard eventCount == mark else { return }
    if snapshot?.phase.isWorking != true {
      working = nil
      let notes = board.removeUnfinished()
      if !notes.isEmpty { onChipsChanged?(notes) }
    }
    if let snapshot, snapshot.phase != .idle || snapshot.outcome != nil { receive(snapshot) }
  }

  private func receive(_ activity: OrchestratorActivity) {
    if activity.phase.isWorking {
      working = activity
    } else if activity.phase == .idle, let current = working, current.turnId == activity.turnId,
      activity.turnId != nil || current.trigger == activity.trigger
    {
      working = nil
    }
    let changes = board.apply(activity)
    for id in changes.noticed {
      schedule(id, after: Self.noticedExpiry) { store in store.expire(id) }
    }
    for id in changes.ended {
      let hold =
        board.chip(id)?.outcome?.kind == .noAction ? Self.nothingToDoHold : Self.outcomeHold
      schedule(id, after: hold) { store in store.fade(id) }
    }
    if !changes.notes.isEmpty { onChipsChanged?(changes.notes) }
  }

  // MARK: Timers

  private func schedule(
    _ id: String, after delay: TimeInterval,
    _ action: @escaping @MainActor (OrchestratorActivityStore) -> Void
  ) {
    timers[id]?.cancel()
    timers[id] = scheduler.schedule(after: delay) { [weak self] in
      guard let self else { return }
      self.timers[id] = nil
      action(self)
    }
  }

  private func expire(_ id: String) {
    guard board.chip(id)?.phase == .noticed, let note = board.remove(id) else { return }
    onChipsChanged?([note])
  }

  private func fade(_ id: String) {
    guard let note = board.fade(id) else { return }
    onChipsChanged?([note])
    schedule(id, after: Self.fadeDuration) { store in
      guard let note = store.board.remove(id) else { return }
      store.onChipsChanged?([note])
    }
  }
}
