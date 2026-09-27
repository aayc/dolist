import Foundation

/// Pure source-relative parsing for GFM table rows and Obsidian callout headers. Presentation
/// never writes these values back: the original markdown remains the editable document.
package struct MarkdownContentLine: Equatable, Sendable {
  package enum Alignment: Equatable, Sendable { case left, center, right }
  package struct Cell: Equatable, Sendable {
    package var source: String
    package var range: NSRange
    package init(source: String, range: NSRange) {
      self.source = source
      self.range = range
    }
  }
  package struct Callout: Equatable, Sendable {
    package var type: String
    package var title: String
    package var fold: Bool?
    package var depth: Int
    package var titleRange: NSRange

    package var family: String {
      switch type.lowercased() {
      case "abstract", "summary", "tldr": "abstract"
      case "tip", "hint", "important": "tip"
      case "success", "check", "done": "success"
      case "question", "help", "faq": "question"
      case "warning", "caution", "attention": "warning"
      case "failure", "fail", "missing": "failure"
      case "danger", "error": "danger"
      case "quote", "cite": "quote"
      case "info", "todo", "bug", "example": type.lowercased()
      default: "note"
      }
    }
  }

  package var agent: AgentMarkerToken?
  package var cells: [Cell]?
  package var delimiter: [Alignment]?
  package var callout: Callout?
  package var quoteDepth: Int
  package var boundary: Bool
  package var bodyStart: Int

  package static func parse(_ source: String, literal: Bool) -> MarkdownContentLine {
    let original = Array(source.utf16)
    let agent = literal ? nil : AgentMarker.scan(original)
    let units = agent.map { Array(original[..<$0.range.location]) } ?? original
    let prefix = LinePrefix.parse(units)
    let body = prefix.quoteEnd
    let trimmed = String(decoding: units[body...], as: UTF16.self).trimmingCharacters(
      in: .whitespaces)
    let boundary =
      literal || trimmed.isEmpty || prefix.isListItem
      || MarkdownTokenizer.headingBounds(units, from: body) != nil
      || MarkdownBlockRules.isHorizontalRule(units, from: body)
      || trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~")
    var result = MarkdownContentLine(
      agent: agent,
      quoteDepth: prefix.quoteDepth, boundary: boundary, bodyStart: body)
    guard !literal else { return result }
    result.callout = calloutHeader(units, prefix: prefix)
    guard !boundary else { return result }
    result.cells = row(units, from: body)
    if let cells = result.cells, !cells.isEmpty {
      let alignments = cells.compactMap { cell -> Alignment? in
        let value = cell.source.trimmingCharacters(in: .whitespaces)
        let withoutColons = value.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
        guard !withoutColons.isEmpty, withoutColons.allSatisfy({ $0 == "-" }),
          value.filter({ $0 == ":" }).count <= 2,
          !value.dropFirst().dropLast().contains(":")
        else { return nil }
        if value.hasPrefix(":"), value.hasSuffix(":") { return .center }
        return value.hasSuffix(":") ? .right : .left
      }
      if alignments.count == cells.count { result.delimiter = alignments }
    }
    return result
  }

  /// Escaped pipes stay in their cell, including inside code spans, matching Lezer's GFM table
  /// scanner. A bare pipe in a code span is still a delimiter in the GFM grammar.
  private static func row(_ units: [UInt16], from start: Int) -> [Cell]? {
    var separators: [Int] = []
    var escaped = false
    for index in start..<units.count {
      let unit = units[index]
      if unit == 124, !escaped { separators.append(index) }
      escaped = !escaped && unit == 92
    }
    guard !separators.isEmpty else { return nil }
    var edges = [start - 1] + separators + [units.count]
    if units[start..<separators[0]].allSatisfy(CharClass.isSpaceOrTab) { edges.removeFirst() }
    if let last = separators.last, units[(last + 1)...].allSatisfy(CharClass.isSpaceOrTab) {
      edges.removeLast()
    }
    guard edges.count >= 2 else { return nil }
    return zip(edges, edges.dropFirst()).map { left, right in
      var lower = left + 1
      var upper = right
      while lower < upper, CharClass.isSpaceOrTab(units[lower]) { lower += 1 }
      while upper > lower, CharClass.isSpaceOrTab(units[upper - 1]) { upper -= 1 }
      return Cell(
        source: String(decoding: units[lower..<upper], as: UTF16.self), range: NSRange(lower, upper)
      )
    }
  }

  private static func calloutHeader(_ units: [UInt16], prefix: LinePrefix) -> Callout? {
    guard prefix.quoteDepth > 0 else { return nil }
    var start = prefix.quoteEnd
    while start < units.count, CharClass.isSpaceOrTab(units[start]) { start += 1 }
    guard start + 3 < units.count, units[start] == 91, units[start + 1] == 33,
      let close = units[(start + 2)...].firstIndex(of: 93), close > start + 2
    else { return nil }
    let rawType = String(decoding: units[(start + 2)..<close], as: UTF16.self)
    // Metadata after a pipe is preserved in source; it doesn't change standard type styling.
    let type = rawType.split(separator: "|", maxSplits: 1).first.map(String.init) ?? rawType
    guard !type.isEmpty,
      type.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) || $0 == "-" })
    else { return nil }
    var position = close + 1
    var fold: Bool?
    if position < units.count, units[position] == 43 || units[position] == 45 {
      fold = units[position] == 45
      position += 1
    }
    while position < units.count, CharClass.isSpaceOrTab(units[position]) { position += 1 }
    let title = String(decoding: units[position...], as: UTF16.self)
    return Callout(
      type: type, title: title.isEmpty ? type.capitalized : title, fold: fold,
      depth: prefix.quoteDepth, titleRange: NSRange(position, units.count))
  }

  /// Ordinary cell text changes leave block membership intact, so typing reparses one line.
  package var structure: Structure {
    Structure(
      boundary: boundary, quoteDepth: quoteDepth, cellCount: cells?.count,
      delimiter: delimiter, calloutDepth: callout?.depth, calloutFold: callout?.fold)
  }
  package struct Structure: Equatable {
    var boundary: Bool
    var quoteDepth: Int
    var cellCount: Int?
    var delimiter: [Alignment]?
    var calloutDepth: Int?
    var calloutFold: Bool?
  }
}
