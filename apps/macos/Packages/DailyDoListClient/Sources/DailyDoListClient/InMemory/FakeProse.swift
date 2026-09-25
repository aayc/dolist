import DailyDoListModels
import Foundation

/// A note's prose (its user lines that aren't tasks), like the daemon's task watcher: which lines
/// are new since the last settle, and which of them may be addressed to the agent
/// (`mayBeRequest` in `packages/agent/src/orchestrator/prose.ts`).
enum FakeProse {
  private static func regex(_ pattern: String) -> NSRegularExpression {
    try! NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
  }

  private static let question = regex(#"\?\s*$"#)
  private static let address = regex(
    #"^(?:@\s*agent\b|agent\s*[:,]|@\w|todo\b|to do:|reminder\b|remind me\b)"#)
  private static let requestLead = regex(
    #"^(?:please\s+)?(?:find|look\s*up|look\s+into|research|book|reserve|buy|order|schedule|plan|compare|check|figure\s+out|summari[sz]e|draft|write|email|message|text|send|translate|explain|recommend|suggest|get|renew|cancel|track|organi[sz]e|prepare|set\s+up|sign\s+up|remind|can\s+you|could\s+you|would\s+you|help\s+me)\b"#
  )
  private static let recurring = regex(
    #"^(?:every|each)\s+(?:\S+\s+){0,4}?(?:please\s+)?(?:brief|send|check|remind|tell|give|summari[sz]e|find|look|review|track|watch|monitor|write|draft|email|let|carry|move)\b"#
  )
  private static let listMarker = regex(#"^(?:[-*+]|\d{1,9}[.)])\s+"#)
  private static let heading = regex(#"^#{1,6}\s+"#)

  /// `mayBeRequest`: whether a line that isn't a task may be addressed to the agent.
  static func mayBeRequest(_ line: String) -> Bool {
    let text = stripped(line)
    guard text.count >= 3 else { return false }
    let range = NSRange(text.startIndex..., in: text)
    return [question, address, requestLead, recurring].contains {
      $0.firstMatch(in: text, range: range) != nil
    }
  }

  /// A question to answer rather than something to do.
  static func isQuestion(_ line: String) -> Bool {
    let text = line.trimmingCharacters(in: .whitespaces)
    return question.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
  }

  /// The line without its list marker or heading hashes, trimmed.
  static func stripped(_ line: String) -> String {
    var text = line.trimmingCharacters(in: .whitespaces)
    for pattern in [listMarker, heading] {
      text = pattern.stringByReplacingMatches(
        in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "")
    }
    return text
  }

  /// `userProse`: the user's non-blank lines that are neither tasks nor the agent's, trimmed.
  static func userProse(_ content: String) -> [OrchestratorTriggerLine] {
    content.textLines.enumerated().compactMap { index, raw in
      let line = String(raw)
      let text = line.trimmingCharacters(in: .whitespaces)
      guard !text.isEmpty, FakeTaskParser.tasks(in: line).isEmpty,
        FakeAgentText.strip(line) == line
      else { return nil }
      return OrchestratorTriggerLine(line: index, text: text)
    }
  }

  /// `newProse`: lines of `next` whose text isn't in `previous` (as many times): new or edited.
  static func newProse(_ next: [OrchestratorTriggerLine], previous: [String])
    -> [OrchestratorTriggerLine]
  {
    var left: [String: Int] = [:]
    for text in previous { left[text, default: 0] += 1 }
    return next.filter { entry in
      guard let count = left[entry.text], count > 0 else { return true }
      left[entry.text] = count - 1
      return false
    }
  }

  /// A trigger's summary: the line in quotes (bounded), or "your note" for several.
  static func summary(of lines: [OrchestratorTriggerLine]) -> String {
    guard lines.count == 1, let line = lines.first else { return "your note" }
    return "“\(FakeDaemon.excerpt(stripped(line.text)))”"
  }

  /// A request as the task the orchestrator adds for it: "find a lamp." → "Find a lamp".
  static func taskText(for line: String) -> String {
    var text = stripped(line)
    while text.hasSuffix(".") || text.hasSuffix("!") { text.removeLast() }
    guard let first = text.first else { return text }
    return first.uppercased() + text.dropFirst()
  }
}
