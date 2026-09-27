import DailyDoListEditorCore
import DailyDoListModels
import Foundation

/// What the orchestrator is doing about one line that woke it: a chip at the end of that line.
public struct OrchestratorChip: Equatable, Identifiable, Sendable {
  public static let idPrefix = "orchestrator:"

  /// `orchestrator:<n>`, stable while the chip lives (the editor animates by id).
  public let id: String
  public var notePath: String
  /// The line as it was when the orchestrator saw it (0-based), to find it in the editor.
  public var line: Int
  public var text: String
  public var phase: OrchestratorPhase
  public var turnId: String?
  /// What woke it (for the tooltip).
  public var summary: String
  /// What the turn did (its chip shows it, then fades), or the approval it waits for while acting.
  public var outcome: OrchestratorOutcome?
  public var isFading = false

  public init(
    id: String, notePath: String, line: Int, text: String, phase: OrchestratorPhase,
    turnId: String? = nil, summary: String, outcome: OrchestratorOutcome? = nil,
    isFading: Bool = false
  ) {
    self.id = id
    self.notePath = notePath
    self.line = line
    self.text = text
    self.phase = phase
    self.turnId = turnId
    self.summary = summary
    self.outcome = outcome
    self.isFading = isFading
  }

  /// Its turn is over (idle with an outcome).
  public var isEnded: Bool { phase == .idle && outcome != nil }

  /// The thread a click opens instead of the orchestrator's chat at the turn: the outcome's,
  /// unless that's the orchestrator's own chat.
  public var threadToOpen: String? {
    guard let threadId = outcome?.threadId, !OrchestratorThread.isOrchestrator(threadId) else {
      return nil
    }
    return threadId
  }

  public static func isChipId(_ id: String) -> Bool { id.hasPrefix(idPrefix) }

  /// The same line as `line`: its line number as it was, or text the editor would still
  /// recognize as it.
  public func isSameLine(as line: OrchestratorTriggerLine) -> Bool {
    self.line == line.line || EditorLineMatch.recognizes(text, line.text)
  }
}

/// The chips of every note, driven by `orchestrator.activity` events (a pure value; the store
/// adds the timers). Each event carries the whole state of one moment, and events of different
/// moments interleave (a line can be noticed while another turn runs), so chips are matched to
/// events by line and turn:
///
/// - `noticed` carries every line of its note still waiting: chips on the same lines are updated
///   (a line being typed keeps one chip), new lines get one, and the note's other noticed chips go;
/// - a turn's phase moves its chips (or the noticed chips of its lines) along, adding any missing;
///   while it waits for an approval, its outcome says so;
/// - `idle` with an outcome ends the turn's chips (creating them for a client that only saw the
///   end); `idle` without one removes them (the turn stopped, or the noticed lines went away).
///   A turn ends once: its end seen again (a snapshot) changes nothing.
public struct OrchestratorChipBoard: Equatable, Sendable {
  public init() {}
  /// How many ended turns are remembered.
  public static let endedTurnMemory = 64

  public private(set) var chips: [OrchestratorChip] = []
  private var nextId = 0
  /// The latest turns that ended, oldest first.
  private var endedTurns: [String] = []

  /// What an event changed.
  public struct Changes: Equatable, Sendable {
    public init() {}
    /// Notes whose chips changed.
    public var notes: Set<String> = []
    /// Chips whose turn just ended (their fade starts later).
    public var ended: [String] = []
    /// Chips that were noticed (they expire if nothing follows).
    public var noticed: [String] = []
  }

  public func chip(_ id: String) -> OrchestratorChip? { chips.first { $0.id == id } }

  public func chips(for notePath: String) -> [OrchestratorChip] {
    chips.filter { $0.notePath == notePath }
  }

  public mutating func apply(_ activity: OrchestratorActivity) -> Changes {
    let trigger = activity.trigger
    let lines = trigger?.lines ?? []
    let notePath = trigger?.notePath
    var changes = Changes()
    switch activity.phase {
    case .noticed:
      guard let notePath else { return changes }
      for line in lines {
        let id = upsert(
          line, in: notePath, activity: activity,
          matching: { $0.phase == .noticed && $0.isSameLine(as: line) })
        changes.noticed.append(id)
      }
      let waiting = Set(changes.noticed)
      let before = chips.count
      chips.removeAll {
        $0.notePath == notePath && $0.phase == .noticed && !waiting.contains($0.id)
      }
      if !lines.isEmpty || chips.count != before { changes.notes.insert(notePath) }
    case .idle:
      if let turnId = activity.turnId, endedTurns.contains(turnId) { return changes }
      let theirs = indices(of: activity, lines: lines)
      if let turnId = activity.turnId {
        endedTurns.append(turnId)
        if endedTurns.count > Self.endedTurnMemory { endedTurns.removeFirst() }
      }
      if let outcome = activity.outcome {
        var ended = theirs
        if ended.isEmpty, let notePath {
          ended = lines.map { line in
            _ = add(line, in: notePath, activity: activity)
            return chips.count - 1
          }
        }
        for index in ended {
          chips[index].phase = .idle
          chips[index].outcome = outcome
          if let turnId = activity.turnId { chips[index].turnId = turnId }
          changes.notes.insert(chips[index].notePath)
          changes.ended.append(chips[index].id)
        }
      } else {
        for index in theirs { changes.notes.insert(chips[index].notePath) }
        let removed = Set(theirs.map { chips[$0].id })
        chips.removeAll { removed.contains($0.id) }
      }
    default:
      let turnId = activity.turnId
      if let notePath {
        for line in lines {
          _ = upsert(
            line, in: notePath, activity: activity,
            matching: { chip in
              !chip.isEnded && chip.isSameLine(as: line)
                && (chip.phase == .noticed || (turnId != nil && chip.turnId == turnId))
            })
        }
        if !lines.isEmpty { changes.notes.insert(notePath) }
      }
      if let turnId {
        for index in chips.indices where chips[index].turnId == turnId && !chips[index].isEnded {
          chips[index].phase = activity.phase
          chips[index].outcome = activity.outcome
          changes.notes.insert(chips[index].notePath)
        }
      }
    }
    return changes
  }

  /// Starts a chip's fade (its outcome has been shown long enough).
  public mutating func fade(_ id: String) -> String? {
    guard let index = chips.firstIndex(where: { $0.id == id }), !chips[index].isFading else {
      return nil
    }
    chips[index].isFading = true
    return chips[index].notePath
  }

  public mutating func remove(_ id: String) -> String? {
    guard let index = chips.firstIndex(where: { $0.id == id }) else { return nil }
    return chips.remove(at: index).notePath
  }

  /// Chips the orchestrator never finished (a snapshot says it's idle): gone. Returns their notes.
  public mutating func removeUnfinished() -> Set<String> {
    let notes = Set(chips.filter { !$0.isEnded }.map(\.notePath))
    chips.removeAll { !$0.isEnded }
    return notes
  }

  // MARK: Matching

  /// The chips an `idle` event is about: its turn's, else the not-yet-started chips of its lines
  /// (every one of its note's when it names no lines), e.g. when the turn's phases were missed.
  private func indices(of activity: OrchestratorActivity, lines: [OrchestratorTriggerLine])
    -> [Int]
  {
    if let turnId = activity.turnId {
      let turn = chips.indices.filter { chips[$0].turnId == turnId && !chips[$0].isEnded }
      if !turn.isEmpty { return turn }
    }
    guard let notePath = activity.trigger?.notePath else { return [] }
    return chips.indices.filter { index in
      let chip = chips[index]
      guard chip.notePath == notePath, chip.phase == .noticed else { return false }
      return lines.isEmpty || lines.contains { chip.isSameLine(as: $0) }
    }
  }

  /// Updates the first chip `matching` on `notePath` to `line` and the event, or adds one.
  private mutating func upsert(
    _ line: OrchestratorTriggerLine, in notePath: String, activity: OrchestratorActivity,
    matching: (OrchestratorChip) -> Bool
  ) -> String {
    guard let index = chips.firstIndex(where: { $0.notePath == notePath && matching($0) }) else {
      return add(line, in: notePath, activity: activity)
    }
    chips[index].line = line.line
    chips[index].text = line.text
    chips[index].phase = activity.phase
    chips[index].outcome = activity.outcome
    chips[index].summary = activity.trigger?.summary ?? chips[index].summary
    if let turnId = activity.turnId { chips[index].turnId = turnId }
    return chips[index].id
  }

  private mutating func add(
    _ line: OrchestratorTriggerLine, in notePath: String, activity: OrchestratorActivity
  ) -> String {
    nextId += 1
    let chip = OrchestratorChip(
      id: "\(OrchestratorChip.idPrefix)\(nextId)", notePath: notePath, line: line.line,
      text: line.text, phase: activity.phase, turnId: activity.turnId,
      summary: activity.trigger?.summary ?? "", outcome: activity.outcome)
    chips.append(chip)
    return chip.id
  }
}
