// Ported from the undo history of @codemirror/commands 6.11.1 (`HistEvent`, `HistoryState`,
// `updateBranch`, `isAdjacent`, `addSelection`, `popSelection`; MIT, © Marijn Haverbeke and
// others). Vim labels every change of a command after the first "input.type.compose", which this
// history always joins with the previous event, so one command is one undo step.

/// One undoable step: the inverted changes and the selection before them.
struct HistEvent {
  /// The inverse of the event's changes; nil for a selection-only event.
  var changes: ChangeSet?
  var startSelection: EditorSelection?
  var selectionsAfter: [EditorSelection]

  static func selection(_ selections: [EditorSelection]) -> HistEvent {
    HistEvent(changes: nil, startSelection: nil, selectionsAfter: selections)
  }
}

struct UndoHistory {
  var done: [HistEvent] = []
  var undone: [HistEvent] = []
  var prevTime: Double = 0
  var prevUserEvent: String?

  let minDepth = 100
  let newGroupDelay: Double = 500
  private static let maxSelectionsPerEvent = 200

  /// Records a transaction (`historyField.update` without the history annotations).
  mutating func record(
    changes: ChangeSet, inverted: ChangeSet?, startSelection: EditorSelection, selectionSet: Bool,
    time: Double, userEvent: String?
  ) {
    if !changes.isEmpty, let inverted {
      addChanges(
        HistEvent(changes: inverted, startSelection: startSelection, selectionsAfter: []),
        time: time, userEvent: userEvent)
    } else if selectionSet {
      addSelection(startSelection, time: time, userEvent: userEvent)
    }
  }

  private static func isJoinable(_ userEvent: String?) -> Bool {
    guard let userEvent else { return true }
    for prefix in ["input.type", "delete"]
    where userEvent == prefix || userEvent.hasPrefix(prefix + ".") { return true }
    return false
  }

  private mutating func addChanges(_ event: HistEvent, time: Double, userEvent: String?) {
    if let lastEvent = done.last, let lastChanges = lastEvent.changes, !lastChanges.isEmpty,
      let changes = event.changes,
      Self.isJoinable(userEvent),
      (lastEvent.selectionsAfter.isEmpty && time - prevTime < newGroupDelay
        && Self.isAdjacent(lastChanges, changes))
        || userEvent == "input.type.compose"
    {
      let joined = HistEvent(
        changes: changes.compose(lastChanges), startSelection: lastEvent.startSelection,
        selectionsAfter: [])
      done = Self.updateBranch(done, done.count - 1, minDepth, joined)
    } else {
      done = Self.updateBranch(done, done.count, minDepth, event)
    }
    undone = []
    prevTime = time
    prevUserEvent = userEvent
  }

  private mutating func addSelection(_ selection: EditorSelection, time: Double, userEvent: String?)
  {
    let last = done.last?.selectionsAfter ?? []
    if !last.isEmpty && time - prevTime < newGroupDelay && userEvent == prevUserEvent,
      let userEvent,
      userEvent == "select" || userEvent.hasPrefix("select."),
      Self.eqSelectionShape(last[last.count - 1], selection)
    {
      return
    }
    done = Self.addSelection(done, selection)
    prevTime = time
    prevUserEvent = userEvent
  }

  private static func eqSelectionShape(_ a: EditorSelection, _ b: EditorSelection) -> Bool {
    a.ranges.count == b.ranges.count
      && zip(a.ranges, b.ranges).allSatisfy { $0.isEmpty == $1.isEmpty }
  }

  private static func updateBranch(
    _ branch: [HistEvent], _ to: Int, _ maxLen: Int, _ newEvent: HistEvent
  ) -> [HistEvent] {
    let start = to + 1 > maxLen + 20 ? to - maxLen - 1 : 0
    var newBranch = Array(branch[start..<to])
    newBranch.append(newEvent)
    return newBranch
  }

  private static func addSelection(_ branch: [HistEvent], _ selection: EditorSelection)
    -> [HistEvent]
  {
    guard let lastEvent = branch.last else { return [.selection([selection])] }
    var sels = Array(lastEvent.selectionsAfter.suffix(maxSelectionsPerEvent))
    if let last = sels.last, last.eq(selection) { return branch }
    sels.append(selection)
    var updated = lastEvent
    updated.selectionsAfter = sels
    return updateBranch(branch, branch.count - 1, 1_000_000_000, updated)
  }

  /// Whether the changes of two consecutive (inverted) events touch.
  private static func isAdjacent(_ a: ChangeSet, _ b: ChangeSet) -> Bool {
    var ranges: [(Int, Int)] = []
    a.iterChangedRanges { f, t, _, _ in ranges.append((f, t)) }
    var adjacent = false
    b.iterChangedRanges { _, _, f, t in
      for (from, to) in ranges where t >= from && f <= to { adjacent = true }
    }
    return adjacent
  }

  /// What undo (`side == 0`) or redo applies: the changes, the selection afterwards, and the
  /// selection to remember for the opposite branch. nil when there is nothing to pop.
  func pop(undo: Bool, currentSelection: EditorSelection) -> (
    changes: ChangeSet, selection: EditorSelection?, rest: [HistEvent], remembered: EditorSelection
  )? {
    let branch = undo ? done : undone
    guard let event = branch.last, let changes = event.changes else { return nil }
    let remembered =
      event.selectionsAfter.first
      ?? event.startSelection.map { $0.map(changes.invertedDesc, assoc: 1) }
      ?? currentSelection
    return (changes, event.startSelection, Array(branch.dropLast()), remembered)
  }

  /// Records an undo or redo transaction (`fromHistory` branch of `historyField.update`).
  mutating func recordPop(
    undo: Bool, rest: [HistEvent], applied: ChangeSet, inverted: ChangeSet,
    remembered: EditorSelection, startSelection: EditorSelection
  ) {
    var other = undo ? undone : done
    if !applied.isEmpty {
      other = Self.updateBranch(
        other, other.count, minDepth,
        HistEvent(changes: inverted, startSelection: remembered, selectionsAfter: []))
    } else {
      other = Self.addSelection(other, startSelection)
    }
    if undo {
      done = rest
      undone = other
    } else {
      done = other
      undone = rest
    }
    prevTime = 0
    prevUserEvent = nil
  }
}
