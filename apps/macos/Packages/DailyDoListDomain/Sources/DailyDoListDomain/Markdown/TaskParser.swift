/// Markdown checkbox tasks, port of @ddl/core `markdown/tasks.ts` with the same grammar:
///
/// - a task line is `[ \t]*` + marker (`-`, `*`, `+`, or 1-9 digits and `.`/`)`) + `[ \t]+` +
///   `[` + one UTF-16 code unit + `]`, then the end of the line or blanks and the text;
/// - YAML frontmatter (`---` on the first line, closed by `---`/`...` within 200 lines) and fenced
///   code (``` or ~~~; a closer is the same character, at least as long, with nothing after it)
///   are skipped;
/// - lines split on `\n` (one trailing `\r` is dropped; a lone `\r` is not a break); a leading
///   byte order mark belongs to no line but offsets still count it;
/// - any line closes the list items at its indent or deeper (tab = 4 columns); non-task lines
///   under a task become its notes;
/// - an agent marker (`AgentText`) ending a line is left out of task texts and notes, and flags
///   the task as the agent's.
public enum TaskParser {
  /// `parseTasks`: every checkbox task in the document, in one linear pass.
  public static func parse(_ markdown: String) -> [ParsedTask] {
    UTF16Buffer(markdown).withPointer { p, n in parse(p, n) }
  }

  /// `toggleTaskLine`: `[ ]` ↔ `[x]`; any other status becomes done. Non-task lines unchanged.
  public static func toggleLine(_ line: String) -> String {
    let buffer = UTF16Buffer(line)
    return buffer.withPointer { p, n in
      guard let match = matchTaskLine(p, 0, n, checkNewlines: true) else { return line }
      let done = TaskStatus(unit: p[match.statusIndex]) == .done
      return replaceStatus(p, n, match, with: done ? " " : "x")
    }
  }

  /// `setStatusCharOnLine`: replaces the checkbox character of a task line with `statusChar`,
  /// inserted literally. Non-task lines unchanged.
  public static func setStatusChar(_ statusChar: String, onLine line: String) -> String {
    let buffer = UTF16Buffer(line)
    return buffer.withPointer { p, n in
      guard let match = matchTaskLine(p, 0, n, checkNewlines: true) else { return line }
      return replaceStatus(p, n, match, with: statusChar)
    }
  }

  /// `isTaskLine`.
  public static func isTaskLine(_ line: String) -> Bool {
    UTF16Buffer(line).withPointer { p, n in matchTaskLine(p, 0, n, checkNewlines: true) != nil }
  }

  /// `isBlankTaskText`: fewer than two code units besides whitespace, `.`, `…` and `-` (e.g. the
  /// empty `- [ ] ` of the daily template).
  public static func isBlankTaskText(_ text: String) -> Bool {
    var meaningful = 0
    for u in text.utf16 where !(isJSWhitespace(u) || u == 0x2E || u == 0x2026 || u == 0x2D) {
      meaningful += 1
      if meaningful >= 2 { return false }
    }
    return true
  }

  // MARK: - Parsing

  static func parse(_ p: UnsafePointer<UInt16>, _ n: Int) -> [ParsedTask] {
    var tasks: [ParsedTask] = []
    let bom = n > 0 && p[0] == 0xFEFF ? 1 : 0
    let lastFrontmatterLine = frontmatterEnd(p, bom, n)
    // Open list items, innermost last: their indent, and the innermost task at or above them
    // (-1 when only plain bullets are open), so the owner of a line is just the last entry.
    var stackIndent: [Int] = []
    var stackOwner: [Int] = []
    var fenceChar: UInt16 = 0
    var fenceLength = 0  // 0: not in a fence
    var lineStart = bom
    var line = 0
    while true {
      var lineEnd = lineStart
      while lineEnd < n && p[lineEnd] != 0x0A { lineEnd += 1 }
      let rawEnd = lineEnd > lineStart && p[lineEnd - 1] == 0x0D ? lineEnd - 1 : lineEnd
      defer {
        lineStart = lineEnd + 1
        line += 1
      }

      if line <= lastFrontmatterLine {
        // Frontmatter: YAML, not tasks.
      } else if fenceLength > 0 {
        if let close = fence(p, lineStart, rawEnd, closing: true), close.char == fenceChar,
          close.length >= fenceLength
        {
          fenceLength = 0
        }
      } else if let open = fence(p, lineStart, rawEnd, closing: false) {
        fenceChar = open.char
        fenceLength = open.length
      } else if !jsTrim(p, lineStart..<rawEnd).isEmpty {
        var wsEnd = lineStart
        var indent = 0
        while wsEnd < rawEnd && isBlank(p[wsEnd]) {
          indent += p[wsEnd] == 0x09 ? 4 : 1
          wsEnd += 1
        }
        // Any line (list item or paragraph) closes every open item at the same or deeper indent.
        while let top = stackIndent.last, top >= indent {
          stackIndent.removeLast()
          stackOwner.removeLast()
        }
        let owner = stackOwner.last ?? -1

        let agentMarker = AgentText.findMarker(p, lineStart, rawEnd)
        if let match = matchTaskLine(p, wsEnd, rawEnd, checkNewlines: false) {
          let textRange = jsTrim(
            p, match.bodyStart..<max(match.bodyStart, agentMarker?.from ?? rawEnd))
          var links: [String] = []
          if mayContainLink(p, textRange) {
            WikiLinks.scan(p, textRange) { links.append(String(utf16: p, $0.target)) }
          }
          tasks.append(
            ParsedTask(
              line: line, indent: indent, depth: stackIndent.count,
              marker: shortString(p, wsEnd..<match.markerEnd),
              statusChar: shortString(p, match.statusIndex..<(match.statusIndex + 1)),
              status: TaskStatus(unit: p[match.statusIndex]), text: String(utf16: p, textRange),
              raw: String(utf16: p, lineStart..<rawEnd), from: lineStart, to: rawEnd,
              textFrom: match.bodyStart, parentLine: owner >= 0 ? tasks[owner].line : nil,
              notes: [],
              links: links, agent: agentMarker != nil))
          stackIndent.append(indent)
          stackOwner.append(tasks.count - 1)
        } else {
          // A non-task line nested under a task (sub-bullet or continuation) is agent context.
          if owner >= 0 {
            tasks[owner].notes.append(
              noteText(p, jsTrim(p, lineStart..<(agentMarker?.from ?? rawEnd))))
          }
          if let markerEnd = matchMarker(p, wsEnd, rawEnd), markerEnd < rawEnd,
            isBlank(p[markerEnd])
          {
            stackIndent.append(indent)
            stackOwner.append(owner)
          }
        }
      }
      if lineEnd >= n { break }
    }
    return tasks
  }

  private static let asciiStrings: [String] = (0..<128).map { String(UnicodeScalar(UInt8($0))) }

  /// A marker or status character: single ASCII characters come from a table.
  private static func shortString(_ p: UnsafePointer<UInt16>, _ range: Range<Int>) -> String {
    if range.count == 1, p[range.lowerBound] < 0x80 {
      return asciiStrings[Int(p[range.lowerBound])]
    }
    return String(utf16: p, range)
  }

  /// Whether `[[` occurs in the range (most task texts have no link).
  private static func mayContainLink(_ p: UnsafePointer<UInt16>, _ range: Range<Int>) -> Bool {
    var i = range.lowerBound + 1
    while i < range.upperBound {
      if p[i] == 0x5B && p[i - 1] == 0x5B { return true }
      i += 1
    }
    return false
  }

  /// Index of the line closing a frontmatter block that opens on the first line, or -1.
  private static func frontmatterEnd(_ p: UnsafePointer<UInt16>, _ start: Int, _ n: Int) -> Int {
    var lineStart = start
    var lineEnd = lineStart
    while lineEnd < n && p[lineEnd] != 0x0A { lineEnd += 1 }
    guard isDelimiter(p, lineStart, lineEnd, allowDots: false) else { return -1 }
    var index = 0
    while lineEnd < n && index + 1 < 200 {
      index += 1
      lineStart = lineEnd + 1
      lineEnd = lineStart
      while lineEnd < n && p[lineEnd] != 0x0A { lineEnd += 1 }
      if isDelimiter(p, lineStart, lineEnd, allowDots: true) { return index }
    }
    return -1
  }

  /// `^---\s*$`, or also `^\.\.\.\s*$` when `allowDots`.
  private static func isDelimiter(
    _ p: UnsafePointer<UInt16>, _ start: Int, _ end: Int, allowDots: Bool
  ) -> Bool {
    guard end - start >= 3 else { return false }
    let c = p[start]
    guard c == 0x2D || (allowDots && c == 0x2E), p[start + 1] == c, p[start + 2] == c else {
      return false
    }
    for i in (start + 3)..<end where !isJSWhitespace(p[i]) { return false }
    return true
  }

  /// A fence line: blanks, then 3+ backticks or tildes. An opener's backtick info string can't
  /// contain a backtick; a closer has nothing but blanks after the run.
  private static func fence(
    _ p: UnsafePointer<UInt16>, _ start: Int, _ end: Int, closing: Bool
  ) -> (char: UInt16, length: Int)? {
    var i = start
    while i < end && isBlank(p[i]) { i += 1 }
    guard i < end, p[i] == 0x60 || p[i] == 0x7E else { return nil }
    let c = p[i]
    var length = 0
    while i + length < end && p[i + length] == c { length += 1 }
    guard length >= 3 else { return nil }
    for k in (i + length)..<end {
      if closing ? !isBlank(p[k]) : (c == 0x60 && p[k] == 0x60) { return nil }
    }
    return (c, length)
  }

  struct TaskLineMatch {
    var markerEnd: Int
    var statusIndex: Int
    /// Where the text begins (after the blanks following `]`), or the line end if none.
    var bodyStart: Int
  }

  /// `TASK_RE` on the code units `start..<end`, where `start` is past the leading blanks or at
  /// the line start. Lines inside a document never contain `\n`; arbitrary strings might.
  static func matchTaskLine(
    _ p: UnsafePointer<UInt16>, _ start: Int, _ end: Int, checkNewlines: Bool
  ) -> TaskLineMatch? {
    var i = start
    while i < end && isBlank(p[i]) { i += 1 }
    guard let markerEnd = matchMarker(p, i, end) else { return nil }
    var j = markerEnd
    while j < end && isBlank(p[j]) { j += 1 }
    guard j > markerEnd, j + 2 < end, p[j] == 0x5B, p[j + 2] == 0x5D, p[j + 1] != 0x0A else {
      return nil
    }
    let afterBox = j + 3
    if afterBox == end {
      return TaskLineMatch(markerEnd: markerEnd, statusIndex: j + 1, bodyStart: end)
    }
    guard isBlank(p[afterBox]) else { return nil }
    var body = afterBox
    while body < end && isBlank(p[body]) { body += 1 }
    if checkNewlines {
      for k in body..<end where p[k] == 0x0A { return nil }
    }
    return TaskLineMatch(markerEnd: markerEnd, statusIndex: j + 1, bodyStart: body)
  }

  /// `[-*+]|\d{1,9}[.)]` at `i`: the index after the marker.
  private static func matchMarker(_ p: UnsafePointer<UInt16>, _ i: Int, _ end: Int) -> Int? {
    guard i < end else { return nil }
    let c = p[i]
    if c == 0x2D || c == 0x2A || c == 0x2B { return i + 1 }
    var digits = 0
    while i + digits < end && isASCIIDigit(p[i + digits]) { digits += 1 }
    guard digits >= 1, digits <= 9, i + digits < end, p[i + digits] == 0x2E || p[i + digits] == 0x29
    else {
      return nil
    }
    return i + digits + 1
  }

  /// A trimmed note line without its list marker: `raw.trim().replace(/^(marker)\s+/, "")`.
  private static func noteText(_ p: UnsafePointer<UInt16>, _ trimmed: Range<Int>) -> String {
    if let markerEnd = matchMarker(p, trimmed.lowerBound, trimmed.upperBound),
      markerEnd < trimmed.upperBound, isJSWhitespace(p[markerEnd])
    {
      var start = markerEnd
      while start < trimmed.upperBound && isJSWhitespace(p[start]) { start += 1 }
      return String(utf16: p, start..<trimmed.upperBound)
    }
    return String(utf16: p, trimmed)
  }

  private static func replaceStatus(
    _ p: UnsafePointer<UInt16>, _ n: Int, _ match: TaskLineMatch, with statusChar: String
  ) -> String {
    String(utf16: p, 0..<match.statusIndex) + statusChar
      + String(utf16: p, (match.statusIndex + 1)..<n)
  }
}

extension TaskStatus {
  /// `statusFromChar` for a single code unit.
  init(unit: UInt16) {
    switch unit {
    case 0x20: self = .open
    case 0x78, 0x58: self = .done
    case 0x2F: self = .inProgress
    case 0x2D: self = .cancelled
    case 0x3E, 0x3C: self = .deferred
    default: self = .other
    }
  }
}
