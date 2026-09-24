// Reproduces what the web app's CodeMirror 6 editor does for vim (MIT, © Marijn Haverbeke and
// others): documents and selections like @codemirror/state 6.7.6, the undo history of
// @codemirror/commands 6.11.1, and scrolling like `scrollRectIntoView` of @codemirror/view 6.43.13.

import Foundation

/// An in-memory editor that behaves like the web app's CodeMirror 6 editor without a language:
/// document and selection semantics, CodeMirror's undo history (grouping included), and the fixed
/// viewport the vim vectors were recorded in (20 px lines, 400 px high, no wrapping, no padding).
///
/// It is the test double of the package, the host the vectors are replayed against, and a
/// reference for implementing `VimEditor` on a real text view.
@MainActor
public final class VimTextBuffer: VimEditor {
  // MARK: Document

  private var lines: [VimText]
  /// Line start offsets, valid for `lines[0..<validStarts]`.
  private var starts: [Int] = [0]
  private var validStarts = 1
  public private(set) var vimLength: Int

  // MARK: State

  private var selection: EditorSelection
  private var history = UndoHistory()
  /// The time of a transaction in milliseconds (CodeMirror uses `Date.now()`; undo grouping joins
  /// edits less than 500 ms apart).
  public var clock: () -> Double = { Date().timeIntervalSince1970 * 1000 }

  public var tabSize: Int
  public var indentUnit: String
  public var isReadOnly = false

  // MARK: Layout

  public var lineHeight: Double = 20
  /// The height of the glyph box, centered in the line.
  public var textHeight: Double = 18
  public var clientHeight: Double = 400
  public var clientWidth: Double = 900
  /// The advance of one character (monospace; tabs advance to the next tab stop). The default is
  /// what the vectors' oracle measures for its 16 px monospace font (Chromium on macOS).
  public var charWidth: Double = 9.6015625
  public private(set) var scrollTop: Double = 0
  public private(set) var scrollLeft: Double = 0
  private var pendingScroll: SelRange?

  // MARK: Interface

  /// The panel on display.
  public private(set) var panel: VimPanel?
  /// Every notification shown, oldest first.
  public private(set) var notifications: [String] = []
  public private(set) var searchHighlight: VimSearchHighlight?
  public var onSave: (() -> Void)?
  /// Where native edits are reported (set by `attach(to:)`).
  public weak var session: VimSession?

  public convenience init(_ text: String = "", tabSize: Int = 4, indentUnit: String = "\t") {
    self.init(VimText(text), tabSize: tabSize, indentUnit: indentUnit)
  }

  /// A buffer holding `text` as UTF-16 code units (which may include lone surrogates).
  public init(_ text: VimText, tabSize: Int = 4, indentUnit: String = "\t") {
    lines = ChangeSet.normalizeLineBreaks(text).split(unit: 0x0A)
    vimLength = 0
    self.tabSize = tabSize
    self.indentUnit = indentUnit
    selection = .single(0)
    vimLength = lines.reduce(0) { $0 + $1.length } + lines.count - 1
  }

  /// Attaches `vim` to this buffer and remembers the session for native edits.
  @discardableResult
  public func attach(to vim: Vim) -> VimSession {
    let session = vim.attach(to: self)
    self.session = session
    return session
  }

  // MARK: Text access

  /// The document.
  public var text: String { vimText.string }

  public var vimText: VimText { lines.joined("\n") }

  public var lineCount: Int { lines.count }

  public func line(_ n: Int) -> VimText { lines[n] }

  public var vimLineCount: Int { lines.count }

  public func vimLine(_ line: Int) -> VimText { lines[line] }

  public func vimLineStart(_ line: Int) -> Int {
    ensureStarts(through: line)
    return starts[line]
  }

  public func vimLineNumber(at offset: Int) -> Int {
    // Extend the known line starts until they cover `offset`.
    while validStarts < lines.count,
      offset > starts[validStarts - 1] + lines[validStarts - 1].length
    {
      ensureStarts(through: validStarts)
    }
    var lo = 0
    var hi = validStarts - 1
    while lo < hi {
      let mid = (lo + hi + 1) >> 1
      if starts[mid] <= offset { lo = mid } else { hi = mid - 1 }
    }
    return lo
  }

  private func ensureStarts(through line: Int) {
    guard line >= validStarts else { return }
    if starts.count < lines.count {
      starts.append(contentsOf: repeatElement(0, count: lines.count - starts.count))
    }
    var i = validStarts
    while i <= line {
      starts[i] = starts[i - 1] + lines[i - 1].length + 1
      i += 1
    }
    validStarts = line + 1
  }

  private func position(_ offset: Int) -> (line: Int, ch: Int) {
    let line = vimLineNumber(at: offset)
    return (line, offset - vimLineStart(line))
  }

  private func slice(_ from: Int, _ to: Int) -> VimText {
    if from >= to { return VimText() }
    let a = position(from)
    let b = position(to)
    if a.line == b.line { return lines[a.line].slice(a.ch, b.ch) }
    var out = lines[a.line].slice(a.ch).units
    for l in (a.line + 1)..<b.line {
      out.append(0x0A)
      out.append(contentsOf: lines[l].units)
    }
    out.append(0x0A)
    out.append(contentsOf: lines[b.line].slice(0, b.ch).units)
    return VimText(units: out)
  }

  // MARK: Selection

  public var vimSelection: VimSelection {
    VimSelection(
      ranges: selection.ranges.map { .init(anchor: $0.anchor, head: $0.head) },
      mainIndex: selection.mainIndex)
  }

  /// The selection as positions.
  public var selections: [VimRange] {
    selection.ranges.map { VimRange(anchor: pos($0.anchor), head: pos($0.head)) }
  }

  public var primarySelectionIndex: Int { selection.mainIndex }

  private func pos(_ offset: Int) -> VimPosition {
    let p = position(offset)
    return VimPosition(line: p.line, ch: p.ch)
  }

  private func offset(_ p: VimPosition) -> Int {
    let line = min(max(p.line, 0), lines.count - 1)
    return vimLineStart(line) + min(max(p.ch, 0), lines[line].length)
  }

  // MARK: Transactions

  public func vimApply(_ transaction: VimTransaction) {
    let changes = transaction.changeSet ?? changeSet(for: transaction.changes)
    let before = selection
    let inverted = changes.isEmpty ? nil : changes.invert { self.slice($0, $1) }
    apply(changes)
    selection = EditorSelection(
      ranges: transaction.selection.ranges.map { SelRange.range($0.anchor, $0.head) },
      mainIndex: transaction.selection.mainIndex)
    history.record(
      changes: changes, inverted: inverted, startSelection: before,
      selectionSet: transaction.selectionIsExplicit, time: clock(),
      userEvent: transaction.userEvent)
    if !changes.isEmpty, let target = pendingScroll { pendingScroll = target.map(changes) }
    if transaction.scrollIntoView { pendingScroll = selection.main }
  }

  public func vimUndo() -> VimTransaction? { popHistory(undo: true) }

  public func vimRedo() -> VimTransaction? { popHistory(undo: false) }

  private func popHistory(undo: Bool) -> VimTransaction? {
    guard !isReadOnly, let popped = history.pop(undo: undo, currentSelection: selection) else {
      return nil
    }
    let before = selection
    let inverted = popped.changes.invert { self.slice($0, $1) }
    apply(popped.changes)
    selection = popped.selection ?? before.map(popped.changes)
    history.recordPop(
      undo: undo, rest: popped.rest, applied: popped.changes, inverted: inverted,
      remembered: popped.remembered, startSelection: before)
    pendingScroll = selection.main
    var list: [VimChange] = []
    popped.changes.iterChanges { fromA, toA, _, _, text in
      list.append(VimChange(from: fromA, to: toA, text: text))
    }
    var transaction = VimTransaction(
      changes: list, selection: vimSelection, userEvent: undo ? "undo" : "redo",
      scrollIntoView: true)
    transaction.changeSet = popped.changes
    return transaction
  }

  private func changeSet(for changes: [VimChange]) -> ChangeSet {
    (try? ChangeSet.of(
      changes.map { .init(from: $0.from, to: $0.to, insert: $0.text) }, length: vimLength))
      ?? .empty(vimLength)
  }

  /// Applies `changes` to the lines, last change first.
  private func apply(_ changes: ChangeSet) {
    var list: [(Int, Int, VimText)] = []
    changes.iterChanges { fromA, toA, _, _, text in list.append((fromA, toA, text)) }
    for (from, to, text) in list.reversed() {
      let a = position(from)
      let b = position(to)
      let inserted = text.split(unit: 0x0A)
      var replacement = inserted
      replacement[0] = lines[a.line].slice(0, a.ch) + replacement[0]
      replacement[replacement.count - 1] =
        replacement[replacement.count - 1] + lines[b.line].slice(b.ch)
      lines.replaceSubrange(a.line...b.line, with: replacement)
      validStarts = min(validStarts, a.line + 1)
      vimLength += text.length - (to - from)
    }
    if starts.count > lines.count { starts.removeLast(starts.count - lines.count) }
  }

  // MARK: Configuration

  public var vimTabSize: Int { tabSize }
  public var vimIndentUnit: String { indentUnit }
  public var vimIsReadOnly: Bool { isReadOnly }

  // MARK: Layout

  public var vimLineHeight: Double { lineHeight }
  public var vimTextHeight: Double { textHeight }

  public var vimViewport: VimViewport {
    VimViewport(
      scrollTop: scrollTop, scrollLeft: scrollLeft, clientHeight: clientHeight,
      clientWidth: clientWidth, contentHeight: contentHeight)
  }

  private var contentHeight: Double { Double(lines.count) * lineHeight }

  private var maxScrollTop: Double { max(0, contentHeight - clientHeight) }

  public func vimScroll(top: Double?, left: Double?) {
    if let top { scrollTop = min(max(0, top), maxScrollTop) }
    if let left { scrollLeft = max(0, left) }
  }

  public func vimScrollIntoView(_ offset: Int?) {
    pendingScroll = offset.map { SelRange.cursor($0) } ?? selection.main
  }

  /// Sets the first visible line (the vectors' `scrollTop`).
  public func scroll(toLine line: Int) {
    vimScroll(top: Double(line) * lineHeight, left: nil)
  }

  /// The first visible line (rounded like the vectors).
  public var firstVisibleLine: Int { Int((scrollTop / lineHeight).rounded()) }

  /// Applies a pending scroll request, like CodeMirror's measure phase (the replay calls this
  /// after every key).
  public func measure() {
    // Like a scroll container whose content got shorter.
    scrollTop = min(scrollTop, maxScrollTop)
    guard let target = pendingScroll else { return }
    pendingScroll = nil
    scrollRangeIntoView(target)
  }

  /// `docView.scrollIntoView` + `scrollRectIntoView` with `y: "nearest"` and a 5 px margin.
  private func scrollRangeIntoView(_ range: SelRange) {
    guard var rect = vimCoords(at: min(range.head, vimLength), side: 1) else { return }
    if !range.isEmpty, let other = vimCoords(at: min(range.anchor, vimLength), side: 1) {
      rect = VimRect(
        left: min(rect.left, other.left), top: min(rect.top, other.top),
        right: max(rect.right, other.right), bottom: max(rect.bottom, other.bottom))
    }
    guard contentHeight > clientHeight else { return }
    let side = range.head < range.anchor ? -1 : 1
    let yMargin = 5.0
    let top = rect.top - scrollTop
    let bottom = rect.bottom - scrollTop
    var moveY = 0.0
    if top < yMargin {
      moveY = top - yMargin
      if side > 0 && bottom > clientHeight + moveY { moveY = bottom - clientHeight + yMargin }
    } else if bottom > clientHeight - yMargin {
      moveY = bottom - clientHeight + yMargin
      if side < 0 && top - moveY < 0 { moveY = top - yMargin }
    }
    if moveY != 0 { vimScroll(top: scrollTop + moveY, left: nil) }
  }

  public func vimCoords(at offset: Int, side: Int) -> VimRect? {
    let p = position(min(max(offset, 0), vimLength))
    let left = x(of: p.ch, in: lines[p.line])
    let top = Double(p.line) * lineHeight + (lineHeight - textHeight) / 2
    return VimRect(left: left, top: top, right: left, bottom: top + textHeight)
  }

  public func vimOffset(at point: VimPoint) -> Int {
    let line = min(max(Int((point.y / lineHeight).rounded(.down)), 0), lines.count - 1)
    let text = lines[line]
    let start = vimLineStart(line)
    if point.x <= 0 { return start }
    var i = 0
    var left = 0.0
    while i < text.length {
      var next = i + 1
      if isHighSurrogate(text[i]), next < text.length, isLowSurrogate(text[next]) { next += 1 }
      while next < text.length, ClusterBreak.isExtendingChar(UInt32(text[next])) { next += 1 }
      let right = x(of: next, in: text)
      if point.x < right { return start + (point.x > (left + right) / 2 ? next : i) }
      left = right
      i = next
    }
    return start + text.length
  }

  /// The x position of column `ch` on a line of monospace text.
  private func x(of ch: Int, in text: VimText) -> Double {
    var x = 0.0
    var i = 0
    let end = min(ch, text.length)
    while i < end {
      let u = text[i]
      if u == 0x09 {
        let tab = Double(tabSize) * charWidth
        x = ((x / tab).rounded(.down) + 1) * tab
      } else if !(isLowSurrogate(u) && i > 0 && isHighSurrogate(text[i - 1]))
        && !ClusterBreak.isExtendingChar(UInt32(u))
      {
        x += charWidth
      }
      i += 1
    }
    return x
  }

  // MARK: Interface

  public func vimShowPanel(_ panel: VimPanel?) {
    self.panel = panel
    if let panel, panel.kind == .message { notifications.append(panel.text) }
  }

  public func vimShowSearchHighlight(_ highlight: VimSearchHighlight?) {
    searchHighlight = highlight
  }

  public func vimFocus() {}

  public func vimSave() { onSave?() }

  // MARK: Native editing

  /// What a plain text view does with a key vim left to it in insert mode (the vectors' native
  /// edits): a character (or `<Space>`) replaces every selection, `<CR>` inserts a line break and
  /// `<Tab>` a tab (no auto-indent); `<BS>` / `<Del>` delete each selection or the grapheme cluster
  /// before/after each cursor. The edit is typing (`input.type`) or deletion in the undo history,
  /// scrolls the cursor into view and is reported to the attached session. Returns false for
  /// other keys.
  @discardableResult
  public func performNativeEdit(for key: String) -> Bool {
    guard let session, !isReadOnly else { return false }
    let event = DOMKeyEvent(vimKey: key)
    let edit: (ChangeSet, EditorSelection)
    let userEvent: String
    if let text = event.insertedText {
      edit = session.cm.selectionReplacement(text)
      userEvent = "input.type"
    } else if key == "<BS>" || key == "<Del>" {
      edit = session.cm.graphemeDeletion(forward: key == "<Del>")
      userEvent = key == "<Del>" ? "delete.forward" : "delete.backward"
    } else {
      return false
    }
    let (changes, newSelection) = edit
    let before = selection
    let inverted = changes.isEmpty ? nil : changes.invert { self.slice($0, $1) }
    apply(changes)
    selection = newSelection
    history.record(
      changes: changes, inverted: inverted, startSelection: before, selectionSet: true,
      time: clock(), userEvent: userEvent)
    pendingScroll = selection.main
    var list: [VimChange] = []
    changes.iterChanges { fromA, toA, _, _, text in
      list.append(VimChange(from: fromA, to: toA, text: text))
    }
    var transaction = VimTransaction(
      changes: list, selection: vimSelection, userEvent: userEvent, scrollIntoView: true)
    transaction.changeSet = changes
    session.editorDidChange(transaction)
    return true
  }

  // MARK: Convenience for tests and hosts

  /// Replaces the document and puts the cursor at the start (history kept).
  public func setText(_ text: String) {
    session?.cm.setValue(VimText(text))
      ?? vimApply(
        VimTransaction(
          changes: [VimChange(from: 0, to: vimLength, text: VimText(text))], selection: .cursor(0)))
  }

  /// Sets the selection (outside vim, like a mouse selection) and tells vim.
  public func select(_ ranges: [VimRange], primary: Int = 0) {
    if let session {
      session.cm.setSelections(ranges, primary)
    } else {
      selection = EditorSelection.create(
        ranges.map { SelRange.range(offset($0.anchor), offset($0.head)) }, mainIndex: primary)
    }
  }

  public func setCursor(line: Int, ch: Int) {
    select([VimRange(cursor: VimPosition(line: line, ch: ch))])
  }

  /// The main cursor.
  public var cursor: VimPosition { pos(selection.main.head) }
}
