import DailyDoListEditor
import DailyDoListModels
import Foundation

/// Turns the orchestrator's chips into editor badges: the wording of each state (the web app's)
/// and the line each chip goes on in the (possibly locally edited) text.
enum ChipBuilder {
  typealias Status = EditorBadge.OrchestratorStatus

  struct Presentation: Equatable {
    var status: String
    /// Empty for the noticed dot.
    var label: String
    var tooltip: String
  }

  static let looking = "Orchestrator is looking…"

  static func presentation(of chip: OrchestratorChip) -> Presentation {
    let opens = chip.threadToOpen == nil ? "open the orchestrator chat" : "open thread"
    func make(_ status: String, _ label: String, _ what: String) -> Presentation {
      Presentation(status: status, label: label, tooltip: "\(what) — \(opens)")
    }
    guard let outcome = chip.outcome else {
      switch chip.phase {
      case .noticed: return make(Status.noticed, "", "The orchestrator noticed this line")
      case .reading:
        return make(Status.looking, looking, "The orchestrator is reading this note")
      case .thinking:
        return make(Status.looking, looking, "The orchestrator is thinking about this line")
      case .acting:
        return make(Status.acting, "Working…", "The orchestrator is working on this line")
      default:
        return make(Status.looking, looking, "The orchestrator is looking at this line")
      }
    }
    let text = outcome.text?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    let count = outcome.count ?? 1
    switch outcome.kind {
    case .noAction:
      return make(Status.nothing, "Nothing to do", text ?? "Nothing to do for this line")
    case .tasksAdded:
      return make(
        Status.done, count > 1 ? "Added \(count) tasks ↗" : "Added a task ↗",
        text ?? (count > 1 ? "Added \(count) tasks" : "Added a task"))
    case .noteEdited: return make(Status.done, "Edited the note ↗", text ?? "Edited the note")
    case .replied: return make(Status.done, "Replied ↗", text ?? "Replied in the orchestrator chat")
    case .delegated:
      return make(
        Status.done, count > 1 ? "Started \(count) tasks ↗" : "Started a task ↗",
        text ?? (count > 1 ? "Started \(count) tasks" : "Started a task"))
    case .routineCreated: return make(Status.done, "Made a routine ↗", text ?? "Made a routine")
    case .askedApproval:
      return make(Status.needsYou, "Needs your approval ↗", text ?? "Needs your approval")
    default: return make(Status.done, "Done ↗", text ?? "Done")
    }
  }

  static func badge(for chip: OrchestratorChip, line: Int) -> EditorBadge {
    let look = presentation(of: chip)
    return EditorBadge(
      id: chip.id, line: line, status: look.status, label: look.label,
      threadId: chip.outcome?.threadId, tooltip: look.tooltip, anchorText: chip.text,
      isFading: chip.isFading)
  }

  /// Badges for a note's chips against `document`. A chip the editor has keeps the line the
  /// editor mapped it to; one placed before and since dropped by the editor (its line was
  /// rewritten) stays gone; a new one is found by line and text (`placed` remembers it). One chip
  /// per line (the newest), and none on a line in `taken` (a task's badge speaks for it).
  static func badges(
    for chips: [OrchestratorChip], in document: String, current: [EditorBadge],
    placed: inout Set<String>, taken: Set<Int>
  ) -> [EditorBadge] {
    guard !chips.isEmpty else { return [] }
    let mapped = Dictionary(
      current.filter { OrchestratorChip.isChipId($0.id) }.map { ($0.id, $0.line) },
      uniquingKeysWith: { first, _ in first })
    var lines: [String]?
    var normalized: [String]?
    var byLine: [Int: EditorBadge] = [:]
    for chip in chips {
      let line: Int
      if let known = mapped[chip.id] {
        line = known
      } else if placed.contains(chip.id) {
        continue
      } else {
        let all = lines ?? document.components(separatedBy: "\n")
        let keys = normalized ?? all.map(EditorLineMatch.normalize)
        lines = all
        normalized = keys
        guard let found = resolve(chip.line, text: chip.text, in: all, normalized: keys) else {
          continue
        }
        line = found
        placed.insert(chip.id)
      }
      guard !taken.contains(line) else { continue }
      byLine[line] = badge(for: chip, line: line)
    }
    return byLine.values.sorted { ($0.line, $0.id) < ($1.line, $1.id) }
  }

  /// Where a line the orchestrator saw (`line`, `text`) is now, like the web's `findEditedLine`:
  /// that line while the editor still recognizes it, else the nearest line with that text, else
  /// the nearest line the editor would recognize as it, anywhere in the note (the earlier on
  /// ties). Nil when it's gone.
  static func resolve(_ line: Int, text: String, in lines: [String], normalized: [String]? = nil)
    -> Int?
  {
    let keys = normalized ?? lines.map(EditorLineMatch.normalize)
    let wanted = EditorLineMatch.normalize(text)
    guard !wanted.isEmpty, !lines.isEmpty else { return nil }
    if lines.indices.contains(line), EditorLineMatch.recognizes(text, lines[line]) { return line }
    return nearest(to: line, in: lines.indices) { keys[$0] == wanted }
      ?? nearest(to: line, in: lines.indices) { EditorLineMatch.recognizes(text, lines[$0]) }
  }

  /// The index in `indices` nearest to `line` that matches (the earlier on ties), looking outward
  /// so the first match found is the answer.
  private static func nearest(
    to line: Int, in indices: Range<Int>, where matches: (Int) -> Bool
  ) -> Int? {
    guard !indices.isEmpty else { return nil }
    let origin = min(max(line, indices.lowerBound), indices.upperBound - 1)
    let reach = max(origin - indices.lowerBound, indices.upperBound - 1 - origin)
    for distance in 0...reach {
      let before = origin - distance
      if before >= indices.lowerBound, matches(before) { return before }
      let after = origin + distance
      if distance > 0, after < indices.upperBound, matches(after) { return after }
    }
    return nil
  }
}
