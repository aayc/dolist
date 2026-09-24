/// A line the agent wrote into a note: it ends with an Obsidian comment naming the thread that wrote
/// it, `%%agent:thr_abc%%` (`%%agent%%` without one). The marker belongs to the whole line and
/// stays when the user edits the line (deleting it makes the line theirs).
public struct AgentLine: Hashable, Sendable {
  /// The line without its marker (and without the blanks before it).
  public var text: String
  /// The thread that wrote the line, when the marker names one.
  public var threadId: String?
  /// UTF-16 offset in the line where the marker, with the blanks before it, starts.
  public var markerFrom: Int

  public init(text: String, threadId: String?, markerFrom: Int) {
    self.text = text
    self.threadId = threadId
    self.markerFrom = markerFrom
  }
}

/// Port of @ddl/core `markdown/agent-text.ts`. The marker is
/// `AGENT_MARKER_RE = /%%agent(?::([A-Za-z0-9_-]{1,64}))?%%[ \t]*$/`, matched on UTF-16 code units.
public enum AgentText {
  /// Longest thread id a marker can name.
  public static let maxThreadIdLength = 64

  /// `parseAgentLine`: the agent's authorship of `line`, or nil for the user's lines.
  public static func parse(_ line: String) -> AgentLine? {
    guard line.utf8.count >= 9 else { return nil }
    return UTF16Buffer(line).withPointer { p, n in
      guard let marker = findMarker(p, 0, n) else { return nil }
      return AgentLine(
        text: String(utf16: p, 0..<marker.from), threadId: marker.threadId.map { String(utf16: p, $0) },
        markerFrom: marker.from)
    }
  }

  /// `isAgentLine`.
  public static func isAgentLine(_ line: String) -> Bool {
    parse(line) != nil
  }

  /// `stripAgentMarker`: `line` without an agent marker (unchanged when it has none).
  public static func stripMarker(_ line: String) -> String {
    parse(line)?.text ?? line
  }

  /// `agentMarker`: `%%agent:<threadId>%%`, or `%%agent%%` when the id is missing or invalid.
  public static func marker(threadId: String?) -> String {
    guard let threadId, isValidThreadId(threadId) else { return "%%agent%%" }
    return "%%agent:\(threadId)%%"
  }

  /// `markAgentLine`: `text` as a line the agent wrote. Blank lines stay unmarked (a marker alone
  /// would show up as an empty agent line); an existing marker is replaced.
  public static func markLine(_ text: String, threadId: String? = nil) -> String {
    let body = UTF16Buffer(stripMarker(text)).withPointer { p, n -> String in
      var end = n
      while end > 0 && isBlank(p[end - 1]) { end -= 1 }
      return String(utf16: p, 0..<end)
    }
    let isBlankLine = UTF16Buffer(body).withPointer { p, n in jsTrim(p, 0..<n).isEmpty }
    return isBlankLine ? body : "\(body) \(marker(threadId: threadId))"
  }

  /// `^[A-Za-z0-9_-]{1,64}$`
  static func isValidThreadId(_ id: String) -> Bool {
    let units = id.utf16
    return (1...maxThreadIdLength).contains(units.count) && units.allSatisfy(isThreadIdUnit)
  }

  @inline(__always)
  static func isThreadIdUnit(_ u: UInt16) -> Bool {
    (u >= 0x41 && u <= 0x5A) || (u >= 0x61 && u <= 0x7A) || (u >= 0x30 && u <= 0x39) || u == 0x5F || u == 0x2D
  }

  /// `AGENT_MARKER_RE` on the code units `start..<end`, which the regex anchors at the end: where
  /// the marker starts once the blanks before it are included (never before `start`), and the
  /// range of the thread id it names.
  ///
  /// The closing `%%` must be the last non-blank units and thread ids can't contain `%` or `:`, so
  /// the match (and JavaScript's leftmost one) is decided by scanning back from the end.
  static func findMarker(
    _ p: UnsafePointer<UInt16>, _ start: Int, _ end: Int
  ) -> (from: Int, threadId: Range<Int>?)? {
    var close = end
    while close > start && isBlank(p[close - 1]) { close -= 1 }
    close -= 2
    guard close - start >= 7, p[close] == 0x25, p[close + 1] == 0x25 else { return nil }
    var idStart = close
    while idStart > start && isThreadIdUnit(p[idStart - 1]) { idStart -= 1 }
    let matchStart: Int
    var threadId: Range<Int>?
    if close - idStart == 5, idStart - start >= 2, matches(p, idStart - 2, "%%agent") {
      matchStart = idStart - 2
    } else if (1...maxThreadIdLength).contains(close - idStart), idStart - start >= 8, p[idStart - 1] == 0x3A,
      matches(p, idStart - 8, "%%agent")
    {
      matchStart = idStart - 8
      threadId = idStart..<close
    } else {
      return nil
    }
    var from = matchStart
    while from > start && isBlank(p[from - 1]) { from -= 1 }
    return (from, threadId)
  }

  /// Whether the ASCII `literal` occurs at `index`.
  private static func matches(_ p: UnsafePointer<UInt16>, _ index: Int, _ literal: StaticString) -> Bool {
    literal.withUTF8Buffer { bytes in
      for (offset, byte) in bytes.enumerated() where p[index + offset] != UInt16(byte) { return false }
      return true
    }
  }
}
