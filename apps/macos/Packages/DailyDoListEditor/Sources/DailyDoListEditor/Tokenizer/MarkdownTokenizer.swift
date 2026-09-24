import Foundation

/// Pure, AppKit-free markdown tokenizer. Block structure is decided line by line from a small
/// incoming state (inside a fenced code block or not), which is what lets the highlighter re-tokenize
/// only the lines an edit touches; inline syntax is tokenized per line by `InlineTokenizer`.
///
/// Block rules: ATX headings 1–6 (up to three leading spaces), fenced code (```` ``` ```` / `~~~`,
/// info string, an unterminated fence runs to the end), YAML frontmatter (`---` on the first line,
/// closed by `---`/`...` within 200 lines, like `@ddl/core`), nested blockquotes, lists (`-`, `*`,
/// `+`, `1.`, `1)`), task items with any status character, horizontal rules and blank lines. A
/// line ending with an agent marker (`AgentMarker`, outside code and frontmatter) is tokenized
/// without it and styled as the agent's text. Indented code blocks and setext headings are
/// deliberately not supported: an indented task must stay a task, and a line's style must not
/// depend on the next line.
enum MarkdownTokenizer {
  /// Frontmatter must close within this many lines (same limit as `@ddl/core`).
  static let frontmatterMaxLines = 200

  /// Tokenizes one line (UTF-16 units without the terminator) given the block state entering it.
  /// Returns line-relative tokens and the state entering the next line.
  static func tokenizeLine(
    _ s: [UInt16], state: BlockState, frontmatter: FrontmatterRole? = nil
  ) -> (tokens: LineTokens, next: BlockState) {
    if let frontmatter {
      return (
        LineTokens(kind: frontmatter == .delimiter ? .frontmatterDelimiter : .frontmatter), .normal
      )
    }
    if case .fence(let marker, let length) = state {
      if MarkdownBlockRules.isClosingFence(s, marker: marker, length: length) {
        return (LineTokens(kind: .codeFenceClose), .normal)
      }
      return (LineTokens(kind: .code), state)
    }
    if let fence = MarkdownBlockRules.openingFence(s) {
      return (LineTokens(kind: .codeFenceOpen), .fence(marker: fence.marker, length: fence.length))
    }
    if MarkdownBlockRules.isBlank(s) { return (LineTokens(kind: .blank), .normal) }
    guard let agent = AgentMarker.scan(s) else { return (tokenizeContent(s), .normal) }
    // The text before the marker is styled like any line; the whole text is the agent's.
    let body = agent.range.location
    var tokens = tokenizeContent(Array(s[..<body]))
    tokens.agent = agent
    tokens.markers.append(SyntaxMarker(range: agent.range, kind: .agent))
    if body > 0 { tokens.spans.append(StyledSpan(range: NSRange(0, body), style: .agent)) }
    return (tokens, .normal)
  }

  /// Tokens of a line that isn't code, frontmatter or blank.
  private static func tokenizeContent(_ s: [UInt16]) -> LineTokens {
    let prefix = LinePrefix.parse(s)
    var tokens = LineTokens(kind: .paragraph)
    tokens.quoteDepth = prefix.quoteDepth
    for marker in prefix.quoteMarkers {
      tokens.markers.append(SyntaxMarker(range: marker, kind: .quote))
    }
    let bodyStart = prefix.quoteEnd

    if MarkdownBlockRules.isHorizontalRule(s, from: bodyStart) {
      tokens.kind = .horizontalRule
      tokens.markers.append(SyntaxMarker(range: NSRange(bodyStart, s.count), kind: .horizontalRule))
      return tokens
    }
    if let heading = headingBounds(s, from: bodyStart) {
      tokens.kind = .heading(level: heading.level)
      tokens.markers.append(
        SyntaxMarker(range: NSRange(bodyStart, heading.contentStart), kind: .heading))
      if heading.contentEnd < s.count {
        tokens.markers.append(
          SyntaxMarker(range: NSRange(heading.contentEnd, s.count), kind: .heading))
      }
      appendInline(s, heading.contentStart, heading.contentEnd, to: &tokens)
      return tokens
    }
    if let marker = prefix.marker {
      tokens.kind = .listItem
      tokens.listMarker = marker
      tokens.listPrefix = ListPrefixLayout(
        indentStart: prefix.quoteEnd, markerStart: marker.location, markerEnd: marker.end,
        box: prefix.box,
        textStart: prefix.contentStart)
      if let box = prefix.box, let status = prefix.status {
        let replaced = prefix.ordered == nil ? NSRange(marker.location, box.end) : box
        let text = NSRange(prefix.contentStart, s.count)
        tokens.task = TaskToken(
          markerRange: replaced, boxRange: box, status: status, textRange: text)
        tokens.markers.append(SyntaxMarker(range: replaced, kind: .task))
        if prefix.ordered != nil {
          tokens.spans.append(StyledSpan(range: marker, style: .listNumber))
        }
        if text.length > 0 {
          if status == UTF16Unit.lowerX || status == UTF16Unit.upperX {
            tokens.spans.append(StyledSpan(range: text, style: .taskDone))
          } else if status == UTF16Unit.dash {
            tokens.spans.append(StyledSpan(range: text, style: .taskCancelled))
          }
        }
      } else if prefix.ordered != nil {
        tokens.spans.append(StyledSpan(range: marker, style: .listNumber))
      } else {
        tokens.markers.append(SyntaxMarker(range: marker, kind: .bullet))
      }
      appendInline(s, prefix.contentStart, s.count, to: &tokens)
      return tokens
    }
    appendInline(s, bodyStart, s.count, to: &tokens)
    return tokens
  }

  /// ATX heading at `from`: up to three spaces, 1–6 `#`, then whitespace or the end of the line;
  /// an optional closing `#` sequence (preceded by whitespace) is syntax too.
  static func headingBounds(_ s: [UInt16], from: Int) -> (
    level: Int, contentStart: Int, contentEnd: Int
  )? {
    let n = s.count
    var p = from
    var spaces = 0
    while p < n, s[p] == UTF16Unit.space, spaces < 4 {
      p += 1
      spaces += 1
    }
    guard spaces <= 3, p < n, s[p] == UTF16Unit.hash else { return nil }
    var level = 0
    while p + level < n, s[p + level] == UTF16Unit.hash, level < 7 { level += 1 }
    let afterHashes = p + level
    guard level <= 6, afterHashes == n || CharClass.isLineBlank(s[afterHashes]) else { return nil }
    var contentStart = afterHashes
    while contentStart < n, CharClass.isLineBlank(s[contentStart]) { contentStart += 1 }
    var end = n
    while end > contentStart, CharClass.isLineBlank(s[end - 1]) { end -= 1 }
    var hashes = end
    while hashes > contentStart, s[hashes - 1] == UTF16Unit.hash { hashes -= 1 }
    var contentEnd = n
    if hashes < end, hashes == contentStart || CharClass.isSpaceOrTab(s[hashes - 1]) {
      var closeStart = hashes
      while closeStart > contentStart, CharClass.isSpaceOrTab(s[closeStart - 1]) { closeStart -= 1 }
      contentEnd = closeStart
    }
    return (level, contentStart, max(contentStart, contentEnd))
  }

  private static func appendInline(
    _ s: [UInt16], _ from: Int, _ to: Int, to tokens: inout LineTokens
  ) {
    guard to > from else { return }
    var inline = InlineTokenizer(s, from: from, to: to)
    inline.run()
    tokens.spans.append(contentsOf: inline.spans)
    tokens.markers.append(contentsOf: inline.markers)
    tokens.links.append(contentsOf: inline.links)
    tokens.tags.append(contentsOf: inline.tags)
  }

  /// Index of the line closing a frontmatter block that opens on line 0, or nil.
  static func frontmatterEnd(lineCount: Int, line: (Int) -> [UInt16]) -> Int? {
    guard lineCount >= 2, MarkdownBlockRules.isFrontmatterOpen(line(0)) else { return nil }
    for index in 1..<min(lineCount, frontmatterMaxLines)
    where MarkdownBlockRules.isFrontmatterClose(line(index)) {
      return index
    }
    return nil
  }

  /// One tokenized line of a document, with document offsets.
  struct Line: Equatable, Sendable {
    /// The line's content range (without the `\n`).
    var range: NSRange
    /// Block state entering the line.
    var state: BlockState
    var tokens: LineTokens
  }

  /// Tokenizes a whole document. Lines are separated by `\n` only (like `@ddl/core`); ranges are
  /// UTF-16 document offsets.
  static func tokenize(_ text: String) -> [Line] {
    let units = Array(text.utf16)
    var starts = [0]
    for (i, c) in units.enumerated() where c == UTF16Unit.newline { starts.append(i + 1) }
    let lineRanges = starts.enumerated().map { index, start in
      let end = index + 1 < starts.count ? starts[index + 1] - 1 : units.count
      return NSRange(start, end)
    }
    let lineUnits: (Int) -> [UInt16] = {
      Array(units[lineRanges[$0].location..<lineRanges[$0].end])
    }
    let frontmatterEnd = frontmatterEnd(lineCount: lineRanges.count, line: lineUnits)
    var state = BlockState.normal
    var lines: [Line] = []
    lines.reserveCapacity(lineRanges.count)
    for (index, range) in lineRanges.enumerated() {
      let role: FrontmatterRole? =
        frontmatterEnd.map {
          index == 0 || index == $0 ? .delimiter : (index < $0 ? .content : nil)
        } ?? nil
      let (tokens, next) = tokenizeLine(lineUnits(index), state: state, frontmatter: role)
      lines.append(Line(range: range, state: state, tokens: tokens.offset(by: range.location)))
      state = next
    }
    return lines
  }
}
