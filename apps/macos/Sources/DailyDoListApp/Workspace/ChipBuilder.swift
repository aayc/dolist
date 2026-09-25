import DailyDoListEditor
import DailyDoListModels
import Foundation

/// Turns the orchestrator's chips into editor badges: the wording of each state (the web app's)
/// and the line each chip goes on in the (possibly locally edited) text.
enum ChipBuilder {
  typealias Status = EditorBadge.OrchestratorStatus

  /// How far from the line it saw the orchestrator's line can have moved and still be found by a
  /// similar (not identical) text.
  static let searchWindow = 20

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

  /// Where a line the orchestrator saw (`line`, `text`) is now: that line if it still has the
  /// text, else the nearest line with it, else the most similar line the editor would recognize
  /// as it within ``searchWindow`` lines (the nearest on ties). Nil when it's gone.
  static func resolve(_ line: Int, text: String, in lines: [String], normalized: [String]? = nil)
    -> Int?
  {
    let keys = normalized ?? lines.map(EditorLineMatch.normalize)
    let wanted = EditorLineMatch.normalize(text)
    guard !wanted.isEmpty, !lines.isEmpty else { return nil }
    if keys.indices.contains(line), keys[line] == wanted { return line }
    if let exact = keys.indices.filter({ keys[$0] == wanted }).min(by: {
      abs($0 - line) < abs($1 - line)
    }) {
      return exact
    }
    let low = max(0, line - searchWindow)
    let high = min(lines.count - 1, line + searchWindow)
    guard low <= high else { return nil }
    var best: (index: Int, similarity: Double)?
    for index in low...high where EditorLineMatch.recognizes(text, lines[index]) {
      let similarity = EditorLineMatch.similarity(text, lines[index])
      guard let current = best else {
        best = (index, similarity)
        continue
      }
      if similarity > current.similarity
        || (similarity == current.similarity && abs(index - line) < abs(current.index - line))
      {
        best = (index, similarity)
      }
    }
    return best?.index
  }
}
