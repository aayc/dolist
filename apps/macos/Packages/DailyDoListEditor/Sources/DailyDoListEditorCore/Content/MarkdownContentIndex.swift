import Foundation

/// Incremental content blocks. Ordinary typing reparses changed lines only; a structural edit
/// rebuilds the adjacent table/quote region. Neither path scans unrelated document text.
package final class MarkdownContentIndex {
  package struct Table: Equatable {
    package var first: Int
    package var last: Int
    package var alignments: [MarkdownContentLine.Alignment]
  }
  package struct Callout: Equatable {
    package var first: Int
    package var last: Int
    package var depth: Int
  }
  package private(set) var lineIndex = LineIndex()
  package private(set) var lines: [MarkdownContentLine] = []
  package private(set) var tables: [Table] = []
  package private(set) var callouts: [Callout] = []
  package private(set) var lastParsedLineCount = 0
  package private(set) var changedLines = 0..<0
  package init() {}

  package func rebuild(_ text: NSString, literal: (Int) -> Bool) {
    lineIndex.rebuild(text)
    lines = (0..<lineIndex.count).map { parse($0, text: text, literal: literal) }
    tables.removeAll()
    callouts.removeAll()
    lastParsedLineCount = lines.count
    changedLines = 0..<lines.count
    scan(0..<lines.count)
  }

  package func applyEdit(
    location: Int, oldLength: Int, newLength: Int, text: NSString,
    restyledRange: NSRange, literal: (Int) -> Bool
  ) {
    let change = lineIndex.applyEdit(
      location: location, oldLength: oldLength, newLength: newLength, text: text)
    let old = Array(lines[change.firstLine...change.oldLastLine])
    let inserted = (change.firstLine...change.newLastLine).map {
      parse($0, text: text, literal: literal)
    }
    lines.replaceSubrange(change.firstLine...change.oldLastLine, with: inserted)
    lastParsedLineCount = inserted.count
    changedLines = change.firstLine..<(change.newLastLine + 1)
    let propagationEnd = lineIndex.line(
      containing: max(restyledRange.location, restyledRange.end - 1))
    if propagationEnd > change.newLastLine {
      for line in (change.newLastLine + 1)...min(propagationEnd, lines.count - 1) {
        lines[line] = parse(line, text: text, literal: literal)
        lastParsedLineCount += 1
      }
    }
    let shift = change.newLastLine - change.oldLastLine
    if shift == 0, propagationEnd <= change.newLastLine,
      old.map(\.structure) == inserted.map(\.structure)
    {
      return
    }
    var lower = max(0, change.firstLine - 1)
    var upper = min(lines.count, max(change.newLastLine, propagationEnd) + 2)
    for table in tables
    where table.last >= change.firstLine - 1 && table.first <= change.oldLastLine + 1 {
      lower = min(lower, table.first)
      upper = min(lines.count, max(upper, table.last + shift + 2))
    }
    for callout in callouts
    where callout.last >= change.firstLine - 1 && callout.first <= change.oldLastLine + 1 {
      lower = min(lower, callout.first)
      upper = min(lines.count, max(upper, callout.last + shift + 2))
    }
    // A blank quoted line is still inside its callout. Rebuild the whole neighboring
    // quote/paragraph region, including headers before such a line. Ordinary prose stays local.
    let potential = lines[lower..<upper].contains { $0.cells != nil || $0.quoteDepth > 0 }
    if potential {
      while lower > 0, !lines[lower - 1].boundary || lines[lower - 1].quoteDepth > 0 {
        lower -= 1
      }
      while upper < lines.count, !lines[upper].boundary || lines[upper].quoteDepth > 0 {
        upper += 1
      }
    }
    func mapped(_ value: Int) -> Int { value > change.oldLastLine ? value + shift : value }
    tables = tables.compactMap { table in
      guard table.last < change.firstLine || table.first > change.oldLastLine else { return nil }
      let first = mapped(table.first)
      let last = mapped(table.last)
      guard last < lower || first >= upper else { return nil }
      return Table(first: first, last: last, alignments: table.alignments)
    }
    callouts = callouts.compactMap { callout in
      guard callout.last < change.firstLine || callout.first > change.oldLastLine else {
        return nil
      }
      let first = mapped(callout.first)
      let last = mapped(callout.last)
      guard last < lower || first >= upper else { return nil }
      return Callout(first: first, last: last, depth: callout.depth)
    }
    changedLines = lower..<upper
    scan(changedLines)
  }

  private func parse(_ line: Int, text: NSString, literal: (Int) -> Bool) -> MarkdownContentLine {
    MarkdownContentLine.parse(
      text.substring(with: lineIndex.contentRange(ofLine: line, textLength: text.length)),
      literal: literal(line))
  }

  private func scan(_ range: Range<Int>) {
    var cursor = range.lowerBound
    while cursor < range.upperBound {
      let descriptor = lines[cursor]
      if cursor + 1 < lines.count, let cells = descriptor.cells,
        let alignments = lines[cursor + 1].delimiter, cells.count == alignments.count,
        descriptor.quoteDepth == lines[cursor + 1].quoteDepth, descriptor.delimiter == nil,
        descriptor.callout == nil
      {
        var last = cursor + 1
        while last + 1 < lines.count, !lines[last + 1].boundary,
          lines[last + 1].quoteDepth == descriptor.quoteDepth, lines[last + 1].callout == nil
        {
          last += 1
        }
        tables.append(Table(first: cursor, last: last, alignments: alignments))
        cursor = last + 1
      } else {
        cursor += 1
      }
    }
    for line in range {
      guard let header = lines[line].callout else { continue }
      var end = line
      while end + 1 < lines.count, lines[end + 1].quoteDepth >= header.depth {
        if let next = lines[end + 1].callout, next.depth == header.depth { break }
        end += 1
      }
      callouts.append(Callout(first: line, last: end, depth: header.depth))
    }
    tables.sort { $0.first < $1.first }
    callouts.sort { $0.first < $1.first }
  }

  package func table(at line: Int) -> Table? {
    tables.first { line >= $0.first && line <= $0.last }
  }
}
