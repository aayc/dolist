import DailyDoListModels
import Foundation

// Routines: the list (`routines.changed` and REST answers) and each routine's runs.

extension AgentState {
  /// Replaces every routine (`routines.changed`, or `GET /api/routines`).
  mutating func setRoutines(_ routines: [Routine]) -> Changes {
    let sorted = Self.sortedByName(routines)
    guard self.routines != sorted else { return [] }
    self.routines = sorted
    return .routines
  }

  /// One routine as an action answered it (create, run, pause, resume).
  mutating func upsertRoutine(_ routine: Routine) -> Changes {
    var next = routines
    if let index = next.firstIndex(where: { $0.id == routine.id }) {
      guard next[index] != routine else { return [] }
      next[index] = routine
    } else {
      next.append(routine)
    }
    routines = Self.sortedByName(next)
    return .routines
  }

  /// A routine's runs as `GET /api/threads?routineId=` listed them: replaces the summaries of
  /// that routine's runs, except those live events changed since (`preserving`).
  mutating func applyRoutineRuns(
    _ runs: [ThreadSummary], routineId: String, preserving: Set<String> = []
  ) -> Changes {
    let before = threads
    var next = threads.filter { id, summary in
      summary.routineId != routineId || preserving.contains(id)
    }
    for var summary in runs {
      summary.routineId = summary.routineId ?? routineId
      if let local = next[summary.id], preserving.contains(summary.id),
        local.updatedAt > summary.updatedAt
      {
        continue
      }
      next[summary.id] = summary
    }
    threads = next
    var changes: Changes = threads == before ? [] : .threads
    for summary in runs where loadedThreads[summary.id] != nil {
      if syncHeader(ofThread: summary.id, from: summary) { changes.insert(.loadedThreads) }
    }
    return changes
  }

  /// A routine's runs, newest first.
  func runs(ofRoutine routineId: String) -> [ThreadSummary] {
    threads.values.filter { $0.routineId == routineId }
      .sorted { ($0.createdAt, $0.id) > ($1.createdAt, $1.id) }
  }

  /// The routine a thread is a run of.
  func routineId(ofThread threadId: String) -> String? {
    loadedThreads[threadId]?.routineId ?? threads[threadId]?.routineId
  }

  private static func sortedByName(_ routines: [Routine]) -> [Routine] {
    routines.sorted {
      let order = $0.name.localizedStandardCompare($1.name)
      return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
    }
  }
}
