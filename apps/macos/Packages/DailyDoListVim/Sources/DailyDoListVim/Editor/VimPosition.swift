// Ported from `Pos` of @replit/codemirror-vim 6.4.0 and `offsetCursor` of vim.js
// (@replit/codemirror-vim-core 0.1.0; MIT, © Marijn Haverbeke and others).

/// A position in the document: a 0-based line and a column in UTF-16 code units.
///
/// `ch == VimPosition.endOfLine` stands for JavaScript's `Infinity` (vim.js uses it for "the end
/// of the line", e.g. after `$`), and positions are clamped like CodeMirror clamps them.
public struct VimPosition: Hashable, Sendable, CustomStringConvertible {
  public var line: Int
  public var ch: Int

  /// JavaScript's `Infinity` as a column.
  public static let endOfLine = Int.max

  public init(line: Int, ch: Int) {
    self.line = line
    self.ch = ch
  }

  public var description: String { "(\(line), \(ch == Self.endOfLine ? "∞" : String(ch)))" }
}

/// A selection range as positions: `anchor` stays put, `head` moves.
public struct VimRange: Hashable, Sendable {
  public var anchor: VimPosition
  public var head: VimPosition

  public init(anchor: VimPosition, head: VimPosition) {
    self.anchor = anchor
    self.head = head
  }

  public init(cursor: VimPosition) {
    self.init(anchor: cursor, head: cursor)
  }

  public var isEmpty: Bool { anchor == head }
}

typealias Pos = VimPosition

extension VimPosition {
  init(_ line: Int, _ ch: Int) {
    self.init(line: line, ch: ch)
  }

  /// `ch + delta` with JavaScript's Infinity arithmetic (`Infinity - 1` is still Infinity).
  func offsetting(_ lines: Int, _ chars: Int) -> VimPosition {
    VimPosition(line: line + lines, ch: ch == Self.endOfLine ? ch : ch + chars)
  }
}

/// `Infinity + n`, `n + Infinity` and friends for columns.
@inline(__always) func chAdd(_ ch: Int, _ delta: Int) -> Int {
  ch == VimPosition.endOfLine || delta == VimPosition.endOfLine ? VimPosition.endOfLine : ch + delta
}
