import Foundation

/// List editing, like Obsidian: Enter continues lists, tasks and blockquotes (and ends a list on an
/// empty item), Backspace at the start of an item's text removes its markup, Tab / Shift-Tab indent
/// and outdent list items.
enum ListCommands {
  /// Enter. Returns nil to let the text view insert a plain newline (plain text, code, a selection,
  /// a caret before the list marker).
  static func newline(in text: NSString, selection: [NSRange], isLiteralLine: (Int) -> Bool)
    -> TextEdit?
  {
    guard selection.count == 1, let caret = selection.first, caret.length == 0 else { return nil }
    let lines = TextLines(text)
    let line = lines.line(containing: caret.location)
    guard !isLiteralLine(line.location) else { return nil }
    let s = lines.units(line)
    let prefix = LinePrefix.parse(s)
    let column = caret.location - line.location

    if let marker = prefix.marker {
      guard column >= marker.end + (prefix.markerSpace.length > 0 ? 1 : 0) else { return nil }
      let contentIsBlank = s[prefix.contentStart...].allSatisfy(CharClass.isLineBlank)
      if contentIsBlank, column >= (prefix.box?.end ?? marker.end) {
        return endItem(line: line, prefix: prefix, lines: lines)
      }
      var from = caret.location
      while from > line.location + marker.end, CharClass.isSpaceOrTab(text.character(at: from - 1))
      { from -= 1 }
      let space =
        prefix.markerSpace.length > 0
        ? lines.string(prefix.markerSpace.shifted(by: line.location)) : " "
      let keepsBox = prefix.box.map { column >= $0.end } ?? false
      let continuation =
        "\n" + lines.string(NSRange(line.location, line.location + prefix.indentEnd))
        + nextMarker(prefix, s) + space + (keepsBox ? "[ ] " : "")
      var replacements = [
        TextEdit.Replacement(range: NSRange(from, caret.location), text: continuation)
      ]
      if let ordered = prefix.ordered {
        replacements += renumbering(
          after: line, from: ordered.number + 1, prefix: prefix, lines: lines)
      }
      let caretAfter = from + (continuation as NSString).length
      return TextEdit(
        replacements: replacements, selection: [NSRange(location: caretAfter, length: 0)])
    }

    if prefix.quoteDepth > 0 {
      guard column >= prefix.quoteEnd else { return nil }
      var from = caret.location
      while from > line.location, CharClass.isSpaceOrTab(text.character(at: from - 1)) { from -= 1 }
      let quote = lines.string(NSRange(line.location, line.location + prefix.quoteEnd))
      let continuation = "\n" + quote
      return TextEdit(
        replacements: [
          TextEdit.Replacement(range: NSRange(from, caret.location), text: continuation)
        ],
        selection: [NSRange(location: from + (continuation as NSString).length, length: 0)])
    }
    return nil
  }

  /// Enter on an empty item: outdent a nested item under its parent, otherwise remove the list
  /// markup (keeping a blockquote prefix), which ends the list.
  private static func endItem(line: NSRange, prefix: LinePrefix, lines: TextLines) -> TextEdit {
    if prefix.indentEnd > prefix.quoteEnd,
      let parent = parentItem(of: line, prefix: prefix, lines: lines)
    {
      let parentUnits = lines.units(parent)
      let parentPrefix = LinePrefix.parse(parentUnits)
      let space =
        parentPrefix.markerSpace.length > 0
        ? lines.string(parentPrefix.markerSpace.shifted(by: parent.location)) : " "
      let replacement =
        lines.string(NSRange(line.location, line.location + prefix.quoteEnd))
        + lines.string(
          NSRange(parent.location + parentPrefix.quoteEnd, parent.location + parentPrefix.indentEnd)
        )
        + nextMarker(parentPrefix, parentUnits) + space
      return TextEdit(
        replacements: [TextEdit.Replacement(range: line, text: replacement)],
        selection: [NSRange(location: line.location + (replacement as NSString).length, length: 0)])
    }
    let removed = NSRange(line.location + prefix.quoteEnd, line.end)
    return TextEdit(
      replacements: [TextEdit.Replacement(range: removed, text: "")],
      selection: [NSRange(location: removed.location, length: 0)])
  }

  /// The nearest list item above with a smaller indentation (same quote depth), scanning at most a
  /// few hundred lines and stopping at a less-indented non-list line.
  private static func parentItem(of line: NSRange, prefix: LinePrefix, lines: TextLines) -> NSRange?
  {
    let s = lines.units(line)
    let width = indentWidth(s, prefix.quoteEnd, prefix.indentEnd)
    var current = line
    for _ in 0..<500 {
      guard let previous = lines.line(before: current) else { return nil }
      current = previous
      let units = lines.units(previous)
      if MarkdownBlockRules.isBlank(units) { continue }
      let candidate = LinePrefix.parse(units)
      guard candidate.quoteDepth == prefix.quoteDepth else { return nil }
      let candidateWidth = indentWidth(units, candidate.quoteEnd, candidate.indentEnd)
      if candidateWidth < width {
        return candidate.isListItem ? previous : nil
      }
    }
    return nil
  }

  private static func indentWidth(_ s: [UInt16], _ from: Int, _ to: Int) -> Int {
    var width = 0
    for i in from..<max(from, to) { width += s[i] == UTF16Unit.tab ? 4 : 1 }
    return width
  }

  private static func nextMarker(_ prefix: LinePrefix, _ s: [UInt16]) -> String {
    if let ordered = prefix.ordered {
      return String(ordered.number + 1) + String(utf16Units: [ordered.delimiter][...])
    }
    return String(utf16Units: [prefix.bullet ?? UTF16Unit.dash][...])
  }

  /// Renumbers the ordered siblings following `line` so they continue from `number`.
  private static func renumbering(
    after line: NSRange, from number: Int, prefix: LinePrefix, lines: TextLines
  ) -> [TextEdit.Replacement] {
    guard let ordered = prefix.ordered else { return [] }
    let s = lines.units(line)
    let width = indentWidth(s, prefix.quoteEnd, prefix.indentEnd)
    var expected = number + 1
    var replacements: [TextEdit.Replacement] = []
    var current = line
    for _ in 0..<1000 {
      guard let next = lines.line(after: current) else { break }
      current = next
      let units = lines.units(next)
      if MarkdownBlockRules.isBlank(units) { break }
      let candidate = LinePrefix.parse(units)
      guard candidate.quoteDepth == prefix.quoteDepth else { break }
      let candidateWidth = indentWidth(units, candidate.quoteEnd, candidate.indentEnd)
      if candidateWidth > width { continue }
      guard candidateWidth == width, let sibling = candidate.ordered, let marker = candidate.marker,
        sibling.delimiter == ordered.delimiter, sibling.number < expected
      else { break }
      let digits = NSRange(marker.location, marker.end - 1).shifted(by: next.location)
      replacements.append(TextEdit.Replacement(range: digits, text: String(expected)))
      expected += 1
    }
    return replacements
  }

  /// Backspace right at the start of an item's text removes the list markup (the whole task prefix
  /// at once) or the innermost blockquote marker.
  static func deleteMarkupBackward(
    in text: NSString, selection: [NSRange], isLiteralLine: (Int) -> Bool
  ) -> TextEdit? {
    guard selection.count == 1, let caret = selection.first, caret.length == 0 else { return nil }
    let lines = TextLines(text)
    let line = lines.line(containing: caret.location)
    guard !isLiteralLine(line.location) else { return nil }
    let prefix = LinePrefix.parse(lines.units(line))
    let column = caret.location - line.location
    guard column > 0 else { return nil }
    if let marker = prefix.marker, column == prefix.contentStart {
      let removed = NSRange(line.location + marker.location, caret.location)
      return TextEdit(
        replacements: [TextEdit.Replacement(range: removed, text: "")],
        selection: [NSRange(location: removed.location, length: 0)])
    }
    if prefix.marker == nil, let last = prefix.quoteMarkers.last, column == prefix.quoteEnd {
      let removed = last.shifted(by: line.location)
      return TextEdit(
        replacements: [TextEdit.Replacement(range: removed, text: "")],
        selection: [NSRange(location: removed.location, length: 0)])
    }
    return nil
  }

  /// Tab: indents the selected lines when one of them is a list item (or when text is selected).
  /// Nil means "insert a tab at the caret" (the text view's own Tab, which keeps typing undo
  /// coalescing).
  static func indent(in text: NSString, selection: [NSRange]) -> TextEdit? {
    let lines = TextLines(text)
    let selected = lines.selectedLines(selection)
    let hasListItem = selected.contains { LinePrefix.parse(lines.units($0)).isListItem }
    guard hasListItem || selection.contains(where: { $0.length > 0 }) else { return nil }
    let replacements = selected.map { line in
      let prefix = LinePrefix.parse(lines.units(line))
      return TextEdit.Replacement(
        range: NSRange(location: line.location + prefix.quoteEnd, length: 0), text: "\t")
    }
    return withMappedSelection(replacements, selection)
  }

  /// Shift-Tab: removes one level of indentation (a tab or up to four spaces) from the selected lines.
  static func outdent(in text: NSString, selection: [NSRange]) -> TextEdit {
    let lines = TextLines(text)
    var replacements: [TextEdit.Replacement] = []
    for line in lines.selectedLines(selection) {
      let s = lines.units(line)
      let prefix = LinePrefix.parse(s)
      let start = prefix.quoteEnd
      var end = start
      if end < s.count, s[end] == UTF16Unit.tab {
        end += 1
      } else {
        while end < s.count, end - start < 4, s[end] == UTF16Unit.space { end += 1 }
      }
      if end > start {
        replacements.append(
          TextEdit.Replacement(range: NSRange(start, end).shifted(by: line.location), text: ""))
      }
    }
    return withMappedSelection(replacements, selection)
  }

  static func withMappedSelection(_ replacements: [TextEdit.Replacement], _ selection: [NSRange])
    -> TextEdit
  {
    var edit = TextEdit(replacements: replacements, selection: [])
    edit.selection = selection.map { range in
      let start = edit.map(range.location, forward: true)
      let end = range.length == 0 ? start : edit.map(range.end, forward: true)
      return NSRange(start, max(start, end))
    }
    return edit
  }
}
