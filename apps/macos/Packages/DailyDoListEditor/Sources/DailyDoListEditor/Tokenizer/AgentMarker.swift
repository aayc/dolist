import Foundation

/// The comment ending a line the agent wrote, `%%agent:<threadId>%%` (`%%agent%%` without a
/// thread), with the grammar of @ddl/core's `AGENT_MARKER_RE`
/// (`/%%agent(?::([A-Za-z0-9_-]{1,64}))?%%[ \t]*$/`, on UTF-16 code units).
struct AgentMarkerToken: Equatable, Sendable {
  /// The marker from the blanks before it to the end of the line.
  var range: NSRange
  /// The thread that wrote the line, when the marker names one.
  var threadId: String?

  func offset(by delta: Int) -> AgentMarkerToken {
    AgentMarkerToken(range: range.shifted(by: delta), threadId: threadId)
  }
}

enum AgentMarker {
  static let maxThreadIdLength = 64

  /// The marker ending the line `s` (its units without the terminator), if any. The closing `%%`
  /// must be the last non-blank units and ids can't contain `%` or `:`, so scanning back from the
  /// end finds the match JavaScript's leftmost search would.
  static func scan(_ s: [UInt16]) -> AgentMarkerToken? {
    var close = s.count
    while close > 0, CharClass.isSpaceOrTab(s[close - 1]) { close -= 1 }
    close -= 2
    guard close >= 7, s[close] == percent, s[close + 1] == percent else { return nil }
    var idStart = close
    while idStart > 0, isThreadIdUnit(s[idStart - 1]) { idStart -= 1 }
    let start: Int
    var threadId: String?
    if close - idStart == 5, idStart >= 2, matches(s, idStart - 2, keyword) {
      start = idStart - 2
    } else if (1...maxThreadIdLength).contains(close - idStart), idStart >= 8, s[idStart - 1] == UTF16Unit.colon,
      matches(s, idStart - 8, keyword)
    {
      start = idStart - 8
      threadId = String(utf16Units: s[idStart..<close])
    } else {
      return nil
    }
    var from = start
    while from > 0, CharClass.isSpaceOrTab(s[from - 1]) { from -= 1 }
    return AgentMarkerToken(range: NSRange(from, s.count), threadId: threadId)
  }

  private static let percent: UInt16 = 0x25
  /// `%%agent`
  private static let keyword: [UInt16] = Array("%%agent".utf16)

  private static func isThreadIdUnit(_ c: UInt16) -> Bool {
    CharClass.isASCIIAlphanumeric(c) || c == UTF16Unit.underscore || c == UTF16Unit.dash
  }

  private static func matches(_ s: [UInt16], _ index: Int, _ literal: [UInt16]) -> Bool {
    guard index >= 0, index + literal.count <= s.count else { return false }
    for offset in 0..<literal.count where s[index + offset] != literal[offset] { return false }
    return true
  }
}
