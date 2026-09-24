// Ported from `SelectionRange` / `EditorSelection` of @codemirror/state 6.7.6 (MIT, © Marijn
// Haverbeke and others): offset ranges, normalized (sorted, overlaps merged) like CodeMirror 6.

/// A selection range in document offsets.
struct SelRange: Equatable {
  var from: Int
  var to: Int
  /// -1: associated with the character before, 1: after, 0: none.
  var assoc: Int
  /// Head before anchor.
  var inverted: Bool
  var goalColumn: Double?

  var anchor: Int { inverted ? to : from }
  var head: Int { inverted ? from : to }
  var isEmpty: Bool { from == to }

  /// `EditorSelection.cursor(pos, assoc, bidiLevel, goalColumn)`.
  static func cursor(_ pos: Int, assoc: Int = 0, goalColumn: Double? = nil) -> SelRange {
    SelRange(from: pos, to: pos, assoc: assoc, inverted: false, goalColumn: goalColumn)
  }

  /// `EditorSelection.range(anchor, head, goalColumn, bidiLevel, assoc)`.
  static func range(_ anchor: Int, _ head: Int, goalColumn: Double? = nil, assoc: Int = 0) -> SelRange {
    var assoc = assoc
    if assoc == 0 && anchor != head { assoc = head < anchor ? 1 : -1 }
    return head < anchor
      ? SelRange(from: head, to: anchor, assoc: assoc, inverted: true, goalColumn: goalColumn)
      : SelRange(from: anchor, to: head, assoc: assoc, inverted: false, goalColumn: goalColumn)
  }

  /// `map(change, assoc)`.
  func map(_ change: ChangeSet, assoc: Int = -1) -> SelRange {
    let newFrom: Int, newTo: Int
    if isEmpty {
      newFrom = change.map(from, assoc: assoc)
      newTo = newFrom
    } else {
      newFrom = change.map(from, assoc: 1)
      newTo = change.map(to, assoc: -1)
    }
    if newFrom == from && newTo == to { return self }
    return SelRange(from: newFrom, to: newTo, assoc: self.assoc, inverted: inverted, goalColumn: goalColumn)
  }

  /// `eq(other, includeAssoc)`.
  func eq(_ other: SelRange, includeAssoc: Bool = false) -> Bool {
    anchor == other.anchor && head == other.head && goalColumn == other.goalColumn
      && (!includeAssoc || !isEmpty || assoc == other.assoc)
  }
}

/// One or more selection ranges, sorted and not overlapping, with a main range.
struct EditorSelection: Equatable {
  var ranges: [SelRange]
  var mainIndex: Int

  var main: SelRange { ranges[mainIndex] }

  static func single(_ anchor: Int, _ head: Int? = nil) -> EditorSelection {
    EditorSelection(ranges: [.range(anchor, head ?? anchor)], mainIndex: 0)
  }

  /// `EditorSelection.create(ranges, mainIndex)`: sorts and merges when needed.
  static func create(_ ranges: [SelRange], mainIndex: Int = 0) -> EditorSelection {
    precondition(!ranges.isEmpty, "A selection needs at least one range")
    var pos = 0
    for range in ranges {
      if range.isEmpty ? range.from <= pos : range.from < pos {
        return normalized(ranges, mainIndex: mainIndex)
      }
      pos = range.to
    }
    return EditorSelection(ranges: ranges, mainIndex: mainIndex)
  }

  private static func normalized(_ input: [SelRange], mainIndex: Int) -> EditorSelection {
    // A stable sort by `from`, tracking where the main range goes.
    var indexed = input.enumerated().map { ($0.offset, $0.element) }
    indexed.sort { $0.1.from < $1.1.from || ($0.1.from == $1.1.from && $0.0 < $1.0) }
    var ranges = indexed.map(\.1)
    var main = indexed.firstIndex { $0.0 == mainIndex } ?? 0
    var i = 1
    while i < ranges.count {
      let range = ranges[i], prev = ranges[i - 1]
      if range.isEmpty ? range.from <= prev.to : range.from < prev.to {
        let from = prev.from, to = max(range.to, prev.to)
        if i <= main { main -= 1 }
        i -= 1
        ranges.replaceSubrange(i...(i + 1), with: [range.anchor > range.head ? .range(to, from) : .range(from, to)])
      }
      i += 1
    }
    return EditorSelection(ranges: ranges, mainIndex: main)
  }

  /// `map(change, assoc)`.
  func map(_ change: ChangeSet, assoc: Int = -1) -> EditorSelection {
    if change.isEmpty { return self }
    return .create(ranges.map { $0.map(change, assoc: assoc) }, mainIndex: mainIndex)
  }

  func eq(_ other: EditorSelection, includeAssoc: Bool = false) -> Bool {
    guard ranges.count == other.ranges.count, mainIndex == other.mainIndex else { return false }
    for (a, b) in zip(ranges, other.ranges) where !a.eq(b, includeAssoc: includeAssoc) { return false }
    return true
  }

  func asSingle() -> EditorSelection {
    ranges.count == 1 ? self : EditorSelection(ranges: [main], mainIndex: 0)
  }
}
