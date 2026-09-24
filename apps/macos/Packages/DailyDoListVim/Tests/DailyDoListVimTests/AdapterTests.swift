import Testing

@testable import DailyDoListVim

/// The CodeMirror 6 semantics the adapter reimplements: change sets, selection normalization,
/// bookmarks, the search cursor and replace-mode overwriting.
@MainActor
@Suite struct AdapterTests {
  private func apply(_ changes: ChangeSet, to text: String) -> String {
    var units = Array(text.utf16)
    var list: [(Int, Int, VimText)] = []
    changes.iterChanges { fromA, toA, _, _, inserted in list.append((fromA, toA, inserted)) }
    for (from, to, inserted) in list.reversed() {
      units.replaceSubrange(from..<to, with: inserted.units)
    }
    return String(decoding: units, as: UTF16.self)
  }

  // MARK: ChangeSet

  @Test func changeSpecsUseStartOffsetsInAnyOrder() throws {
    let replace = try ChangeSet.of([.init(from: 1, to: 3, insert: "XY")], length: 5)
    #expect(apply(replace, to: "abcde") == "aXYde")
    let unsorted = try ChangeSet.of(
      [.init(from: 4, insert: "!"), .init(from: 0, insert: "^")], length: 5)
    #expect(apply(unsorted, to: "abcde") == "^abcd!e")
    #expect(unsorted.newLength == 7)
  }

  @Test func changeSpecsAreValidated() {
    #expect {
      try ChangeSet.of([.init(from: 3, to: 2)], length: 5)
    } throws: { error in
      JSException.from(error).description
        == "RangeError: Invalid change range 3 to 2 (in doc of length 5)"
    }
  }

  @Test func insertedLineBreaksAreNormalized() throws {
    let changes = try ChangeSet.of([.init(from: 0, insert: "a\r\nb\rc")], length: 0)
    #expect(apply(changes, to: "") == "a\nb\nc")
  }

  @Test func positionsMapThroughChanges() throws {
    let insert = try ChangeSet.of([.init(from: 2, insert: "XX")], length: 5)
    #expect(insert.mapPos(2, assoc: -1) == 2)
    #expect(insert.mapPos(2, assoc: 1) == 4)
    #expect(insert.mapPos(3) == 5)
    let delete = try ChangeSet.of([.init(from: 1, to: 3)], length: 5)
    #expect(delete.mapPos(2) == 1)
    #expect(delete.mapPos(2, mode: .trackDel) == nil)
    #expect(delete.mapPos(1, mode: .trackDel) == 1)
    #expect(delete.mapPos(3, mode: .trackDel) == 1)
  }

  @Test func invertComposeAndMap() throws {
    let original = "abcde"
    let a = try ChangeSet.of([.init(from: 1, to: 3, insert: "XY")], length: 5)
    let inverse = a.invert { from, to in VimText(original).slice(from, to) }
    #expect(apply(inverse, to: apply(a, to: original)) == original)
    let b = try ChangeSet.of([.init(from: 5, insert: "!")], length: 5)
    #expect(apply(a.compose(b), to: original) == "aXYde!")
    // Concurrent changes: `Y` at 3, mapped over `X` inserted at 1.
    let x = try ChangeSet.of([.init(from: 1, insert: "X")], length: 5)
    let y = try ChangeSet.of([.init(from: 3, insert: "Y")], length: 5)
    #expect(apply(y.map(x), to: apply(x, to: original)) == "aXbcYde")
  }

  // MARK: Selections

  @Test func selectionsAreSortedAndMerged() {
    let selection = EditorSelection.create([.range(2, 4), .range(1, 3), .cursor(5)], mainIndex: 2)
    #expect(selection.ranges.map { [$0.anchor, $0.head] } == [[1, 4], [5, 5]])
    #expect(selection.mainIndex == 1)
    // A cursor at the end of a range merges into it; direction follows the later range.
    let touching = EditorSelection.create([.range(4, 1), .cursor(4)])
    #expect(touching.ranges.map { [$0.anchor, $0.head] } == [[1, 4]])
    let backward = EditorSelection.create([.range(0, 3), .range(5, 2)])
    #expect(backward.ranges.map { [$0.anchor, $0.head] } == [[5, 0]])
  }

  @Test func hostSelectionsAreNormalizedLikeCodeMirror() {
    let t = VimTester("abcdef\nghi")
    t.buffer.select([
      VimRange(anchor: VimPosition(line: 0, ch: 1), head: VimPosition(line: 0, ch: 3)),
      VimRange(anchor: VimPosition(line: 0, ch: 2), head: VimPosition(line: 0, ch: 5)),
    ])
    #expect(t.selection == [[0, 1, 0, 5]])
    #expect(t.mode == .visual)
  }

  // MARK: Bookmarks

  @Test func bookmarksFollowEdits() throws {
    let t = VimTester("abcdef")
    let before = t.cm.setBookmark(VimPosition(line: 0, ch: 2))
    let after = t.cm.setBookmark(VimPosition(line: 0, ch: 2), insertLeft: true)
    try t.cm.replaceRange("XX", VimPosition(line: 0, ch: 2))
    #expect(before.find() == VimPosition(line: 0, ch: 2))
    #expect(after.find() == VimPosition(line: 0, ch: 4))
    try t.cm.replaceRange("", VimPosition(line: 0, ch: 0), VimPosition(line: 0, ch: 1))
    #expect(before.find() == VimPosition(line: 0, ch: 1))
    // Deleting across a bookmark removes it.
    try t.cm.replaceRange("", VimPosition(line: 0, ch: 0), VimPosition(line: 0, ch: 5))
    #expect(after.find() == nil)
    before.clear()
    #expect(before.find() == nil)
  }

  @Test func bookmarksTrackLineInsertions() throws {
    let t = VimTester("one\ntwo")
    let mark = t.cm.setBookmark(VimPosition(line: 1, ch: 1))
    try t.cm.replaceRange("zero\n", VimPosition(line: 0, ch: 0))
    #expect(mark.find() == VimPosition(line: 2, ch: 1))
  }

  // MARK: Search cursor

  @Test func searchCursorFindsMatchesAcrossLines() throws {
    let t = VimTester("ab\ncd\nab")
    let query = try JSRegExp(VimText("b\\nc"), flags: "m")
    let cursor = t.cm.getSearchCursor(query, VimPosition(line: 0, ch: 0))
    #expect(try cursor.findNext() != nil)
    #expect(cursor.from() == VimPosition(line: 0, ch: 1))
    #expect(cursor.to() == VimPosition(line: 1, ch: 1))
    #expect(try cursor.findNext() == nil)
  }

  @Test func searchCursorGoesBothWays() throws {
    let t = VimTester("a1 a2\na3")
    let query = try JSRegExp(VimText("a\\d"), flags: "m")
    let cursor = t.cm.getSearchCursor(query, VimPosition(line: 1, ch: 2))
    var found: [VimPosition] = []
    while try cursor.findPrevious() != nil, let from = cursor.from() { found.append(from) }
    #expect(
      found == [
        VimPosition(line: 1, ch: 0), VimPosition(line: 0, ch: 3), VimPosition(line: 0, ch: 0),
      ])
  }

  @Test func searchCursorEscapesBracesAndUsesUnicodeMode() throws {
    let t = VimTester("x{2} 😀")
    // "x{2" is a literal without the u flag; the cursor recompiles the source in unicode mode,
    // where a brace that doesn't form a quantifier is a syntax error unless escaped.
    let braces = t.cm.getSearchCursor(
      try JSRegExp(VimText("x{2"), flags: "m"), VimPosition(line: 0, ch: 0))
    #expect(try braces.findNext() != nil)
    #expect(braces.from() == VimPosition(line: 0, ch: 0))
    #expect(braces.to() == VimPosition(line: 0, ch: 3))
    let astral = t.cm.getSearchCursor(
      try JSRegExp(VimText("."), flags: "m"), VimPosition(line: 0, ch: 5))
    #expect(try astral.findNext() != nil)
    #expect(astral.to() == VimPosition(line: 0, ch: 7))
  }

  // MARK: Replace mode

  @Test func overwriteReplacesTheNextCharacterExceptLineBreaks() {
    let t = VimTester("abc\nde", cursor: (0, 1))
    t.cm.overWriteSelection("Z")
    #expect(t.text == "aZc\nde")
    #expect(t.selection == [[0, 2]])
    t.buffer.setCursor(line: 0, ch: 3)
    t.cm.overWriteSelection("Y")
    #expect(t.text == "aZcY\nde")
    t.buffer.setCursor(line: 1, ch: 2)
    t.cm.overWriteSelection("!")
    #expect(t.text == "aZcY\nde!")
  }
}
