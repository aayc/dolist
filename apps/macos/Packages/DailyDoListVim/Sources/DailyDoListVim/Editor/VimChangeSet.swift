/// Document changes in CodeMirror's representation (`ChangeSet` of @codemirror/state), for hosts
/// that keep their own undo history or report edits made of several steps: compose steps into
/// one set in the offsets of the first document, invert a set against the text it replaced, map
/// positions through it.
///
/// Inserted text is taken as it is (line breaks aren't normalized), so a host can describe what
/// its text storage did exactly.
public struct VimChangeSet: Sendable {
  var base: ChangeSet

  init(_ base: ChangeSet) {
    self.base = base
  }

  /// The replacements `changes` (offsets in a document of `length`, sorted, not overlapping).
  public init(changes: [VimChange], length: Int) throws {
    base = try ChangeSet.of(
      changes.map { .init(from: $0.from, to: $0.to, insert: $0.text) }, length: length, normalizingLineBreaks: false)
  }

  /// No change to a document of `length`.
  public static func empty(length: Int) -> VimChangeSet { VimChangeSet(.empty(length)) }

  /// The length of the document before the changes.
  public var length: Int { base.length }
  /// The length of the document after the changes.
  public var newLength: Int { base.newLength }
  public var isEmpty: Bool { base.isEmpty }

  /// The replacements, in offsets of the document before the changes (adjacent ones joined).
  public var changes: [VimChange] {
    var list: [VimChange] = []
    base.iterChanges { fromA, toA, _, _, text in list.append(VimChange(from: fromA, to: toA, text: text)) }
    return list
  }

  /// A changed range in both documents: `fromA..<toA` before, `fromB..<toB` after the changes.
  public struct ChangedRange: Hashable, Sendable {
    public var fromA: Int
    public var toA: Int
    public var fromB: Int
    public var toB: Int
  }

  public var changedRanges: [ChangedRange] {
    var list: [ChangedRange] = []
    base.iterChangedRanges { fromA, toA, fromB, toB in list.append(ChangedRange(fromA: fromA, toA: toA, fromB: fromB, toB: toB)) }
    return list
  }

  /// These changes followed by `next` (which starts in the document these changes produce).
  public func composed(with next: VimChangeSet) -> VimChangeSet {
    VimChangeSet(base.compose(next.base))
  }

  /// The changes that undo these ones. `original(from, to)` reads the document before the
  /// changes (the text they replaced).
  public func inverted(original: (_ from: Int, _ to: Int) -> VimText) -> VimChangeSet {
    VimChangeSet(base.invert(original))
  }

  /// Where `position` (before the changes) ends up. `assoc` < 0 keeps a position at an insertion
  /// before the inserted text, > 0 moves it after.
  public func mapPosition(_ position: Int, assoc: Int = -1) -> Int {
    base.map(min(max(position, 0), base.length), assoc: assoc)
  }

  /// `selection` mapped through the changes like CodeMirror maps a selection: a cursor with
  /// `assoc`, a range's ends inward.
  public func mapSelection(_ selection: VimSelection, assoc: Int = -1) -> VimSelection {
    VimSelection(
      ranges: selection.ranges.map { range in
        if range.isEmpty {
          let cursor = mapPosition(range.head, assoc: assoc)
          return .init(cursor: cursor)
        }
        let from = mapPosition(range.from, assoc: 1)
        let to = mapPosition(range.to, assoc: -1)
        return range.anchor <= range.head ? .init(anchor: from, head: to) : .init(anchor: to, head: from)
      },
      mainIndex: selection.mainIndex)
  }
}

extension VimTransaction {
  /// A transaction of `changes` exactly as given (inserted line breaks aren't normalized), for a
  /// host reporting its own edits (`VimSession.editorDidChange`) or what an undo applied.
  public init(changeSet changes: VimChangeSet, selection: VimSelection, userEvent: String? = nil, scrollIntoView: Bool = false) {
    self.init(changes: changes.changes, selection: selection, userEvent: userEvent, scrollIntoView: scrollIntoView)
    changeSet = changes.base
  }
}
