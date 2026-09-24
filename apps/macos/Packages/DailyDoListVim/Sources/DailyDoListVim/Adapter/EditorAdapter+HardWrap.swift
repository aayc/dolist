// Ported from `hardWrap` of @replit/codemirror-vim 6.4.0 (MIT, © Marijn Haverbeke and others),
// which implements `gq` / `gw`.

extension EditorAdapter {
  private static let spaceAfterRegex = try! JSRegExp("^(?:(\\s+)|(\\S+)(\\s+))")
  private static let spaceBeforeRegex = try! JSRegExp("(?:(\\s+)|(\\s+)(\\S+))$")

  /// `hardWrap({from, to})`: wraps lines longer than `textwidth` (80) at spaces and joins short
  /// ones; returns the row after the last wrapped line.
  func hardWrap(from: Int, to: Int) throws -> Int {
    let max = textwidth.flatMap { $0 == 0 ? nil : $0 } ?? 80
    var row = min(from, to)
    var endRow = Swift.max(from, to)
    while row <= endRow {
      let line = getLine(row)
      if line.length > max {
        if let space = Self.findSpace(line, max, 5) {
          let indentation = line.slice(0, line.leadingWhitespaceCount())
          try replaceRange(VimText("\n") + indentation, Pos(row, space.start), Pos(row, space.end))
        }
        endRow += 1
      } else if line.hasNonWhitespace && row != endRow {
        let nextLine = getLine(row + 1)
        if !nextLine.isEmpty && nextLine.hasNonWhitespace {
          let trimmedLine = line.trimEnd()
          let trimmedNextLine = nextLine.trimStart()
          let mergedLine = trimmedLine + " " + trimmedNextLine
          let space = Self.findSpace(mergedLine, max, 5)
          if (space != nil && space!.start > trimmedLine.length) || mergedLine.length < max {
            try replaceRange(" ", Pos(row, trimmedLine.length), Pos(row + 1, nextLine.length - trimmedNextLine.length))
            row -= 1
            endRow -= 1
          } else if trimmedLine.length < line.length {
            try replaceRange("", Pos(row, trimmedLine.length), Pos(row, line.length))
          }
        }
      }
      row += 1
    }
    return row
  }

  private static func findSpace(_ line: VimText, _ max: Int, _ min: Int) -> (start: Int, end: Int)? {
    if line.length < max { return nil }
    let before = line.slice(0, max)
    let after = line.slice(max)
    let spaceAfter = spaceAfterRegex.firstMatch(in: after)
    let spaceBefore = spaceBeforeRegex.firstMatch(in: before)
    var start = 0
    var end = 0
    if let spaceBefore, spaceBefore[2] == nil {
      start = max - (spaceBefore[1]?.length ?? 0)
      end = max
    }
    if let spaceAfter, spaceAfter[2] == nil {
      if start == 0 { start = max }
      end = max + (spaceAfter[1]?.length ?? 0)
    }
    if start != 0 { return (start, end) }
    if let spaceBefore, let run = spaceBefore[2], spaceBefore.index > min {
      return (spaceBefore.index, spaceBefore.index + run.length)
    }
    if let spaceAfter, let word = spaceAfter[2] {
      start = max + word.length
      return (start, start + (spaceAfter[3]?.length ?? 0))
    }
    return nil
  }

  // MARK: Search highlighting

  /// `addOverlay({query})`: highlights `query`'s matches unless CodeMirror's search can't compile
  /// it; returns whether it did.
  @discardableResult
  func addOverlay(_ query: JSRegExp) -> Bool {
    guard (try? JSRegExp(query.source, flags: "gmu")) != nil else { return false }
    let highlight = VimSearchHighlight(adapter: self, query: query)
    searchHighlight = highlight
    host.vimShowSearchHighlight(highlight)
    return true
  }

  /// `removeOverlay()`: clears vim's search highlight (whatever overlay is passed).
  func removeOverlay() {
    guard searchHighlight != nil else { return }
    searchHighlight = nil
    host.vimShowSearchHighlight(nil)
  }
}

/// The search vim highlights (after `/`, `*`, `n`…, until `:nohlsearch`): the host marks the
/// matches in the visible lines.
@MainActor
public final class VimSearchHighlight {
  unowned let adapter: EditorAdapter
  let query: JSRegExp

  init(adapter: EditorAdapter, query: JSRegExp) {
    self.adapter = adapter
    self.query = query
  }

  /// The JavaScript pattern (`RegExp.source`).
  public var source: String { query.source.string }
  public var isCaseSensitive: Bool { !query.ignoreCase }

  /// The matches overlapping `from..<to` (document offsets), as CodeMirror's search highlighter
  /// finds them (scanning 250 characters beyond both ends).
  public func matches(from: Int, to: Int) -> [Range<Int>] {
    guard let regex = try? JSRegExp(query.source, flags: "gmu" + (query.ignoreCase ? "i" : "")) else { return [] }
    let length = adapter.docLength
    var cursor = RegExpCursor(adapter, regex: regex, source: query.source, from: max(0, from - 250), to: min(to + 250, length))
    var result: [Range<Int>] = []
    while let m = cursor.next() { result.append(m.from..<m.to) }
    return result
  }
}
