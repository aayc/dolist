import DailyDoListModels

/// A line that isn't a task, with a thread attached to it (`TaskAgentRecord.anchor == .line`).
public struct LineAnchor: Hashable, Sendable, Codable {
  public var anchorId: String
  /// The line, trimmed and without an agent marker.
  public var text: String
  /// Last known 0-based line.
  public var line: Int

  public init(anchorId: String, text: String, line: Int) {
    self.anchorId = anchorId
    self.text = text
    self.line = line
  }

  /// The anchor of a daemon record attached to a line (its `taskId` is the anchor's id).
  public init(record: TaskAgentRecord) {
    self.init(anchorId: record.taskId, text: record.text, line: record.line)
  }
}

/// A line a thread can be anchored to, or where an anchor is now.
public struct AnchoredLine: Hashable, Sendable {
  /// 0-based line.
  public var line: Int
  /// The line, trimmed and without an agent marker.
  public var text: String

  public init(line: Int, text: String) {
    self.line = line
    self.text = text
  }
}

/// Port of the line anchors of @ddl/core `markdown/anchors.ts`.
public enum LineAnchors {
  /// `anchorableLines`: every line a thread can be anchored to (not blank, not a task), trimmed
  /// and without its agent marker. Lines split on `\n`; a trailing `\r` is dropped.
  public static func anchorableLines(_ doc: String) -> [AnchoredLine] {
    UTF16Buffer(doc).withPointer { p, n in
      var lines: [AnchoredLine] = []
      var lineStart = 0
      var line = 0
      while true {
        var lineEnd = lineStart
        while lineEnd < n && p[lineEnd] != 0x0A { lineEnd += 1 }
        let rawEnd = lineEnd > lineStart && p[lineEnd - 1] == 0x0D ? lineEnd - 1 : lineEnd
        if TaskParser.matchTaskLine(p, lineStart, rawEnd, checkNewlines: false) == nil {
          let textEnd = AgentText.findMarker(p, lineStart, rawEnd)?.from ?? rawEnd
          let text = jsTrim(p, lineStart..<textEnd)
          if !text.isEmpty { lines.append(AnchoredLine(line: line, text: String(utf16: p, text))) }
        }
        if lineEnd >= n { break }
        lineStart = lineEnd + 1
        line += 1
      }
      return lines
    }
  }

  /// `resolveLineAnchors`: re-finds line anchors in an edited document with the task tracker's
  /// identity rules (same text, then the most similar nearby text, then an in-place rewrite of
  /// the same line). Returns anchorId → where the anchor is now, for every anchor still there.
  public static func resolve(_ doc: String, anchors: [LineAnchor]) -> [String: AnchoredLine] {
    let candidates = anchorableLines(doc)
    let matchOf = TaskMatcher(
      previous: anchors.map { ($0.text, $0.line) }, parsed: candidates.map { ($0.text, $0.line) },
      threshold: TaskTracker.defaultSimilarityThreshold
    ).match()
    var resolved: [String: AnchoredLine] = [:]
    for (index, candidate) in candidates.enumerated() where matchOf[index] >= 0 {
      let id = anchors[matchOf[index]].anchorId
      if !id.isEmpty { resolved[id] = candidate }
    }
    return resolved
  }
}
