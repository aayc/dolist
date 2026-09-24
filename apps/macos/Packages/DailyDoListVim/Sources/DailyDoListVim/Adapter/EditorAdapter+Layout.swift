// Ported from `findPosV`, `charCoords`, `coordsChar`, `getScrollInfo`, `scrollTo` and
// `scrollIntoView` of @replit/codemirror-vim 6.4.0, and `moveVertically` / `posAtCoords` of
// @codemirror/view 6.43.13 (MIT, © Marijn Haverbeke and others).

import Foundation

/// `getScrollInfo()`.
struct ScrollInfo {
  var left: Double
  var top: Double
  var height: Double
  var clientHeight: Double
  var clientWidth: Double
}

struct Coords {
  var left: Double
  var top: Double
  var bottom: Double
}

extension EditorAdapter {
  /// `charCoords(pos, mode)`: the box of `pos` relative to the content (zeros if unmeasurable).
  func charCoords(_ pos: Pos) -> Coords {
    let offset = indexFromPos(pos)
    guard let rect = host.vimCoords(at: offset, side: 1) else { return Coords(left: 0, top: 0, bottom: 0) }
    return Coords(left: rect.left, top: rect.top, bottom: rect.bottom)
  }

  /// `coordsChar(coords, mode)`: the position at a content point, through CodeMirror's precise
  /// `posAtCoords`. That treats an empty last line as outside the rendered viewport
  /// (`viewport.to <= block.from`) and returns null, which the adapter reads as offset 0: `L`
  /// with the empty last line at the bottom of the screen goes to the first line.
  func coordsChar(left: Double, top: Double) -> Pos {
    if top < 0 { return Pos(0, 0) }
    if top > host.vimViewport.contentHeight { return posFromIndex(docLength) }
    let offset = host.vimOffset(at: VimPoint(x: left, y: top))
    let last = host.vimLineCount - 1
    if host.vimLine(last).isEmpty && host.vimLineNumber(at: offset) == last { return Pos(0, 0) }
    return posFromIndex(offset)
  }

  func getScrollInfo() -> ScrollInfo {
    let viewport = host.vimViewport
    return ScrollInfo(
      left: viewport.scrollLeft, top: viewport.scrollTop, height: max(viewport.contentHeight, viewport.clientHeight),
      clientHeight: viewport.clientHeight, clientWidth: viewport.clientWidth)
  }

  /// `scrollTo(x, y)`: nil leaves an axis alone.
  func scrollTo(_ x: Double?, _ y: Double?) {
    host.vimScroll(top: y, left: x)
  }

  /// `scrollIntoView(pos, margin)`: the margin is ignored, like in the CodeMirror 6 adapter.
  func scrollIntoView(_ pos: Pos?) {
    host.vimScrollIntoView(pos.map { indexFromPos($0) })
  }

  /// A position returned by `findPosV`; `hitSide` when it couldn't move.
  struct PosV {
    var pos: Pos
    var hitSide = false
  }

  /// `findPosV(start, amount, unit, goalColumn)`: `amount` lines or pages up or down.
  func findPosV(_ start: Pos, _ amount: Double, page: Bool, goalColumn: Double?) -> PosV {
    let pixels = page ? host.vimViewport.clientHeight : 0
    let startOffset = indexFromPos(start)
    var range = SelRange.cursor(startOffset, assoc: 1, goalColumn: goalColumn)
    let count = Int(JSNumber.round(abs(amount)))
    for _ in 0..<max(0, count) {
      range = moveVertically(range, forward: amount > 0, distance: page ? pixels : nil)
    }
    var result = PosV(pos: posFromIndex(range.head))
    if (amount < 0 && range.head == 0 && goalColumn != 0 && start.line == 0 && start.ch != 0)
      || (amount > 0 && range.head == docLength && Double(result.pos.ch) != (goalColumn ?? .nan) && start.line == result.pos.line)
    {
      result.hitSide = true
    }
    return result
  }

  /// `EditorView.moveVertically(start, forward, distance)`.
  func moveVertically(_ start: SelRange, forward: Bool, distance: Double?) -> SelRange {
    let startPos = start.head
    let dir: Double = forward ? 1 : -1
    if startPos == (forward ? docLength : 0) { return .cursor(startPos, assoc: start.assoc) }
    var goal = start.goalColumn
    let side = start.assoc != 0 ? start.assoc : ((start.isEmpty ? forward : start.head == start.from) ? 1 : -1)
    let startY: Double
    if let coords = host.vimCoords(at: startPos, side: side) {
      if goal == nil { goal = coords.left }
      startY = forward ? coords.bottom : coords.top
    } else {
      let line = host.vimLineNumber(at: startPos)
      if goal == nil { goal = 0 }
      startY = host.vimLineTop(forward ? line + 1 : line)
    }
    // `textHeight >> 1` (at least 1, so the scan always advances).
    let halfText = Double(max(Int(host.vimTextHeight) >> 1, 1))
    let dist = distance ?? halfText
    let contentBottom = host.vimViewport.contentHeight
    var scan = 0.0
    while true {
      let y = startY + (dist + scan) * dir
      let pos = posAtCoords(x: goal!, y: y, scanY: dir)
      if forward ? y > contentBottom : y < 0 { return .cursor(pos.offset, assoc: pos.assoc) }
      let posCoords = host.vimCoords(at: pos.offset, side: pos.assoc)
      let mid = posCoords.map { ($0.top + $0.bottom) / 2 } ?? 0
      if posCoords == nil || (forward ? mid > startY : mid < startY) {
        return .cursor(pos.offset, assoc: pos.assoc, goalColumn: goal)
      }
      scan += halfText
    }
  }

  /// `posAtCoords(view, coords, false, scanY)` for unwrapped lines: the line at `y`, skipping on
  /// in the scan direction when `y` falls in the space between a line's text and its edge.
  private func posAtCoords(x: Double, y yIn: Double, scanY: Double) -> (offset: Int, assoc: Int) {
    var y = yIn
    let contentHeight = host.vimViewport.contentHeight
    var line: Int
    while true {
      if y < 0 { return (0, 1) }
      if y > contentHeight { return (docLength, -1) }
      line = host.vimLine(atY: y)
      let from = host.vimLineStart(line)
      let rect = host.vimCoords(at: scanY < 0 ? from : lineEnd(line), side: scanY > 0 ? -1 : 1)
      if let rect, scanY < 0 ? rect.top <= y : rect.bottom >= y { break }
      let halfLine = host.vimTextHeight / 2
      y = scanY > 0 ? host.vimLineTop(line + 1) + halfLine : host.vimLineTop(line) - halfLine
    }
    let from = host.vimLineStart(line), to = lineEnd(line)
    let offset = host.vimOffset(at: VimPoint(x: x, y: y))
    // The scan's association: after the character it hit (-1) or before it (1).
    let assoc: Int
    if offset == from {
      assoc = 1
    } else if offset == to {
      assoc = -1
    } else {
      assoc = x < (host.vimCoords(at: offset, side: 1)?.left ?? 0) ? -1 : 1
    }
    return (offset, assoc)
  }
}
