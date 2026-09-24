import DailyDoListModels
import Foundation

/// Lines the agent writes into notes: they end with `%%agent:<threadId>%%` (the daemon's
/// `markAgentLine`), which task texts and anchors leave out.
enum FakeAgentText {
  /// `AGENT_MARKER_RE` with the blanks before it.
  private static let marker = try! NSRegularExpression(pattern: "[ \\t]*%%agent(?::[A-Za-z0-9_-]{1,64})?%%[ \\t]*$")

  /// `line` without its agent marker.
  static func strip(_ line: String) -> String {
    let range = NSRange(line.startIndex..., in: line)
    guard line.contains("%%agent"), let match = marker.firstMatch(in: line, range: range),
      let found = Range(match.range, in: line)
    else { return line }
    return String(line[..<found.lowerBound])
  }

  /// `text` as a line the agent wrote for `threadId`.
  static func mark(_ text: String, threadId: String) -> String {
    "\(strip(text)) %%agent:\(threadId)%%"
  }
}

extension FakeDaemon {
  /// Writes an agent line under a task (after the lines nested under it), like the runtime does
  /// with what it found: a `vault.changed` from the agent, which clients merge with unsaved edits.
  func writeAgentLine(_ text: String, underTask taskId: String, threadId: String) {
    guard let path = records[taskId]?.notePath, let file = vault.file(path),
      let task = tracked[path]?.first(where: { $0.id == taskId })
    else { return }
    var lines = file.content.textLines.map(String.init)
    guard task.line < lines.count else { return }
    let indent = String(lines[task.line].prefix { $0 == " " || $0 == "\t" })
    var at = task.line + 1
    while at < lines.count, lines[at].prefix(while: { $0 == " " || $0 == "\t" }).count > indent.count,
      !lines[at].trimmingCharacters(in: .whitespaces).isEmpty
    {
      at += 1
    }
    lines.insert(FakeAgentText.mark("\(indent)  - \(text)", threadId: threadId), at: at)
    let content = lines.joined(separator: "\n")
    let (stored, _) = vault.store(path, content, mtime: nowMillis)
    emitVaultChange([VaultChange(path: path, kind: .modified, version: stored.version)], origin: .agent)
    observeNote(path, content: content)
  }

  /// Moves line anchors of `path` to the line that now has their text (the client re-resolves
  /// them with the tracker's rules; this keeps the records' last known line close).
  func followAnchors(_ path: String, content: String) -> Bool {
    let lines = content.textLines.map { FakeAgentText.strip(String($0)).trimmingCharacters(in: .whitespaces) }
    var changed = false
    for var record in records.values where record.notePath == path && record.anchor == .line {
      guard let line = lines.firstIndex(of: record.text), line != record.line else { continue }
      record.line = line
      records[record.taskId] = record
      changed = true
    }
    return changed
  }
}
