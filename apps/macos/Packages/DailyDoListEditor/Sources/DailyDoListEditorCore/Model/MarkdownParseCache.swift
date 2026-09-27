import Foundation

/// Block context and kind the highlighter tracks for every line.
package struct LineState: Equatable, Sendable {
  /// Block state entering the line.
  package var entry: BlockState
  package var kind: LineKind
}

/// The incremental parse state used by both native text systems. Styling is a consumer so the
/// tokenizer never imports AppKit/UIKit and cannot perform layout or mutate selection.
package final class MarkdownParseCache {
  package typealias Consumer = (LineTokens, [UInt16], NSRange, Bool) -> Void
  package init() {}
  package private(set) var lineIndex = LineIndex()
  package private(set) var lines: [LineState] = [LineState(entry: .normal, kind: .blank)]
  /// Line closing the YAML frontmatter, if the document has one.
  package private(set) var frontmatterEnd: Int?
  /// Lines tokenized by the most recent restyle (for tests and diagnostics).
  package private(set) var lastRestyledLineCount = 0
  /// Characters (whole lines) whose attributes the most recent restyle rewrote.
  package private(set) var lastRestyledRange = NSRange(location: 0, length: 0)
  /// Lines that are one drawing embed, ascending. Kept up to date by the same incremental passes.
  package private(set) var embedLines: [Int] = []
  /// Whether the most recent edit or restyle added, removed or moved an embed line.
  package private(set) var embedLinesChanged = false

  package func rebuild(_ text: NSString, consume: Consumer) {
    lineIndex.rebuild(text)
    lines = Array(repeating: LineState(entry: .normal, kind: .blank), count: lineIndex.count)
    frontmatterEnd = computeFrontmatterEnd(text)
    embedLines.removeAll()
    embedLinesChanged = true
    restyle(from: 0, through: lines.count - 1, text: text, consume: consume)
  }

  /// Processes a character edit (`editedRange` in new coordinates), from the text storage's
  /// `didProcessEditing`.
  @discardableResult
  package func textDidChange(
    in editedRange: NSRange, changeInLength delta: Int, text: NSString, consume: Consumer
  ) -> LineIndex.Change {
    let oldLength = editedRange.length - delta
    let change = lineIndex.applyEdit(
      location: editedRange.location, oldLength: oldLength, newLength: editedRange.length,
      text: text)
    let inserted = change.newLastLine - change.firstLine
    lines.replaceSubrange(
      (change.firstLine + 1)..<(change.oldLastLine + 1),
      with: repeatElement(LineState(entry: .normal, kind: .blank), count: inserted))
    embedLinesChanged = false
    if !embedLines.isEmpty, let last = embedLines.last, last >= change.firstLine {
      let shift = change.newLastLine - change.oldLastLine
      embedLines = embedLines.compactMap { line in
        if line < change.firstLine { return line }
        if line <= change.oldLastLine {
          embedLinesChanged = true
          return nil
        }
        if shift != 0 { embedLinesChanged = true }
        return line + shift
      }
    }
    var from = change.firstLine
    var through = change.newLastLine
    if change.firstLine < MarkdownTokenizer.frontmatterMaxLines {
      let old = frontmatterEnd
      frontmatterEnd = computeFrontmatterEnd(text)
      if frontmatterEnd != old {
        from = 0
        let mappedOld = old.map {
          $0 > change.oldLastLine
            ? $0 + change.newLastLine - change.oldLastLine : min($0, change.newLastLine)
        }
        through = max(through, mappedOld ?? 0, frontmatterEnd ?? 0)
      }
    }
    restyle(from: from, through: min(through, lines.count - 1), text: text, consume: consume)
    return change
  }

  package func kind(ofLine line: Int) -> LineKind {
    lines.indices.contains(line) ? lines[line].kind : .blank
  }

  /// Code, fences and frontmatter: no list editing there.
  package func isLiteralLine(_ line: Int) -> Bool {
    kind(ofLine: line).isLiteral
  }

  /// Reapply styling after a text system has finished its character-edit transaction.
  package func restyle(covering range: NSRange, text: NSString, consume: Consumer) {
    let bounded = range.clamped(to: text.length)
    restyle(
      from: lineIndex.line(containing: bounded.location),
      through: lineIndex.line(containing: bounded.end), text: text, consume: consume)
  }

  private func restyle(from start: Int, through end: Int, text: NSString, consume: Consumer) {
    let length = text.length
    var line = start
    var state: BlockState = start == 0 ? .normal : lines[start].entry
    var count = 0
    let first = lineIndex.start(ofLine: start)
    while line < lines.count {
      let content = lineIndex.contentRange(ofLine: line, textLength: length)
      let units = text.utf16Units(in: content)
      let (tokens, next) = MarkdownTokenizer.tokenizeLine(
        units, state: state, frontmatter: frontmatterRole(ofLine: line))
      consume(tokens, units, content, line + 1 < lines.count)
      lines[line] = LineState(entry: state, kind: tokens.kind)
      setEmbed(line, tokens.embed != nil)
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

  private func setEmbed(_ line: Int, _ isEmbed: Bool) {
    var low = 0
    var high = embedLines.count
    while low < high {
      let mid = (low + high) / 2
      if embedLines[mid] < line { low = mid + 1 } else { high = mid }
    }
    let present = low < embedLines.count && embedLines[low] == line
    if isEmbed, !present {
      embedLines.insert(line, at: low)
      embedLinesChanged = true
    } else if !isEmbed, present {
      embedLines.remove(at: low)
      embedLinesChanged = true
    }
  }

  package func isEmbedLine(_ line: Int) -> Bool {
    var low = 0
    var high = embedLines.count
    while low < high {
      let mid = (low + high) / 2
      if embedLines[mid] < line { low = mid + 1 } else { high = mid }
    }
    return low < embedLines.count && embedLines[low] == line
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
