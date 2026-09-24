import AppKit

/// Block context and kind the highlighter tracks for every line.
struct LineState: Equatable, Sendable {
  /// Block state entering the line.
  var entry: BlockState
  var kind: LineKind
}

/// Incremental syntax highlighter. Owns the line index and a per-line block state (inside a fence or
/// not); on each edit it re-tokenizes only the edited lines, then continues forward only while the
/// state entering the next line differs from before (opening or closing a fence restyles until the
/// states re-synchronize). Attributes are written into the text storage inside the storage's own
/// editing session; `lastRestyledRange` tells the caller which characters changed style.
@MainActor
final class MarkdownHighlighter {
  private let storage: NSTextStorage
  private(set) var theme: EditorTheme
  /// Whether live preview draws list prefixes (checkbox and bullet slots): decides the indent of
  /// wrapped list lines. Change it through `restyleAll(livePreview:)`.
  private(set) var livePreview = true
  private(set) var lineIndex = LineIndex()
  private(set) var lines: [LineState] = [LineState(entry: .normal, kind: .blank)]
  /// Line closing the YAML frontmatter, if the document has one.
  private(set) var frontmatterEnd: Int?
  /// Lines tokenized by the most recent restyle (for tests and diagnostics).
  private(set) var lastRestyledLineCount = 0
  /// Characters (whole lines) whose attributes the most recent restyle rewrote.
  private(set) var lastRestyledRange = NSRange(location: 0, length: 0)

  init(storage: NSTextStorage, theme: EditorTheme) {
    self.storage = storage
    self.theme = theme
  }

  /// Rebuilds everything from the current text, e.g. after a theme change. Batches the attribute
  /// changes in one editing session.
  func restyleAll(theme newTheme: EditorTheme? = nil, livePreview newLivePreview: Bool? = nil) {
    if let newTheme { theme = newTheme }
    if let newLivePreview { livePreview = newLivePreview }
    let text = storage.mutableString
    lineIndex.rebuild(text)
    lines = Array(repeating: LineState(entry: .normal, kind: .blank), count: lineIndex.count)
    frontmatterEnd = computeFrontmatterEnd(text)
    storage.beginEditing()
    restyle(from: 0, through: lines.count - 1, text: text)
    storage.endEditing()
  }

  /// Processes a character edit (`editedRange` in new coordinates), from the text storage's
  /// `didProcessEditing`.
  @discardableResult
  func textDidChange(in editedRange: NSRange, changeInLength delta: Int) -> LineIndex.Change {
    let text = storage.mutableString
    let oldLength = editedRange.length - delta
    let change = lineIndex.applyEdit(
      location: editedRange.location, oldLength: oldLength, newLength: editedRange.length, text: text)
    let inserted = change.newLastLine - change.firstLine
    lines.replaceSubrange(
      (change.firstLine + 1)..<(change.oldLastLine + 1),
      with: repeatElement(LineState(entry: .normal, kind: .blank), count: inserted))
    var from = change.firstLine
    var through = change.newLastLine
    if change.firstLine < MarkdownTokenizer.frontmatterMaxLines {
      let old = frontmatterEnd
      frontmatterEnd = computeFrontmatterEnd(text)
      if frontmatterEnd != old {
        from = 0
        let mappedOld = old.map {
          $0 > change.oldLastLine ? $0 + change.newLastLine - change.oldLastLine : min($0, change.newLastLine)
        }
        through = max(through, mappedOld ?? 0, frontmatterEnd ?? 0)
      }
    }
    restyle(from: from, through: min(through, lines.count - 1), text: text)
    return change
  }

  func kind(ofLine line: Int) -> LineKind {
    lines.indices.contains(line) ? lines[line].kind : .blank
  }

  /// Code, fences and frontmatter: no list editing there.
  func isLiteralLine(_ line: Int) -> Bool {
    kind(ofLine: line).isLiteral
  }

  private func restyle(from start: Int, through end: Int, text: NSString) {
    let length = text.length
    var line = start
    var state: BlockState = start == 0 ? .normal : lines[start].entry
    var count = 0
    let first = lineIndex.start(ofLine: start)
    while line < lines.count {
      let content = lineIndex.contentRange(ofLine: line, textLength: length)
      let units = text.utf16Units(in: content)
      let (tokens, next) = MarkdownTokenizer.tokenizeLine(units, state: state, frontmatter: frontmatterRole(ofLine: line))
      apply(tokens, units: units, content: content, hasNewline: line + 1 < lines.count)
      lines[line] = LineState(entry: state, kind: tokens.kind)
      count += 1
      line += 1
      if line < lines.count {
        if line > end, lines[line].entry == next { break }
        lines[line].entry = next
      }
      state = next
    }
    lastRestyledLineCount = count
    let end = line < lines.count ? lineIndex.start(ofLine: line) : length
    lastRestyledRange = NSRange(first, max(first, end))
  }

  private func apply(_ tokens: LineTokens, units: [UInt16], content: NSRange, hasNewline: Bool) {
    let block = BlockStyle(tokens.kind)
    let depth = tokens.quoteDepth
    let hanging = tokens.listPrefix == nil ? 0 : theme.hangingIndent(for: tokens, units: units, livePreview: livePreview)
    var position = content.location
    for segment in StyleSegments.build(tokens, length: content.length) {
      let key = StyleKey(
        block: block, quoteDepth: depth, inline: segment.style, marker: segment.marker, hangingIndent: hanging)
      storage.setAttributes(theme.attributes(for: key), range: NSRange(location: position, length: segment.length))
      position += segment.length
    }
    if hasNewline {
      storage.setAttributes(
        theme.attributes(for: StyleKey(block: block, quoteDepth: depth, hangingIndent: hanging)),
        range: NSRange(location: position, length: 1))
    }
    for link in tokens.links {
      storage.addAttribute(.ddlLink, value: LinkAttribute(link.target), range: link.range.shifted(by: content.location))
    }
  }

  private func frontmatterRole(ofLine line: Int) -> FrontmatterRole? {
    guard let end = frontmatterEnd, line <= end else { return nil }
    return line == 0 || line == end ? .delimiter : .content
  }

  private func computeFrontmatterEnd(_ text: NSString) -> Int? {
    let length = text.length
    return MarkdownTokenizer.frontmatterEnd(lineCount: lineIndex.count) { line in
      text.utf16Units(in: lineIndex.contentRange(ofLine: line, textLength: length))
    }
  }
}
