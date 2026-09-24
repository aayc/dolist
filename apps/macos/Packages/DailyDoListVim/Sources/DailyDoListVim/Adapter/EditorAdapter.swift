// Ported from class `CodeMirror` of @replit/codemirror-vim 6.4.0 (dist/index.js; MIT, © Marijn
// Haverbeke and others): the CodeMirror 5 editor API vim.js calls, implemented on CodeMirror 6.
// Here it is implemented on `VimEditor`, with CodeMirror 6's transaction semantics (selection
// mapping and normalization, change batching per operation, bookmarks) ported alongside.

/// The identity of an event handler (vim.js registers and removes functions).
@MainActor
final class HandlerToken {}

/// An event vim.js listens to or signals on the editor.
enum EditorEvent: Hashable {
  case change
  case cursorActivity
  case vimModeChange
  case vimCommandDone
  case vimKeypress
  case dialog
}

/// What a signaled event carries.
enum EditorEventPayload {
  case change(ChangeObj)
  case none
  case modeChange(mode: String, subMode: String?)
  case commandDone(String?)
  case keypress(String)
}

/// A change as vim.js's `onChange` sees it: the inserted lines, chained with `next`.
@MainActor
final class ChangeObj {
  let text: [VimText]
  var next: ChangeObj?

  init(text: [VimText]) {
    self.text = text
  }
}

/// The adapter's `curOp`: changes and selection changes batched until the operation ends.
@MainActor
final class CurOp {
  /// `$d`, the nesting depth; nil for an operation started implicitly by a transaction.
  var depth: Int?
  var isVimOp = false
  var change: ChangeObj?
  var lastChange: ChangeObj?
  var changeHandlers: [(HandlerToken, (EditorEventPayload) -> Void)]?
  var cursorActivity = false
  var cursorActivityHandlers: [(HandlerToken, (EditorEventPayload) -> Void)]?
  /// `$changeStart`: the smallest changed position (in the new document).
  var changeStart: Int?

  init(depth: Int? = nil) {
    self.depth = depth
  }
}

/// A handle from `getLineHandle`.
struct LineHandle {
  let row: Int
  let index: Int
}

@MainActor
final class EditorAdapter {
  unowned let host: any VimEditor
  weak var session: VimSession?

  // MARK: cm.state

  var vim: VimState?
  var overwrite = false
  var closeVimNotification: (() -> Void)?
  var keyMap: String?
  var textwidth: Int?
  var dialog: VimPanel?
  var currentNotificationClose: (() -> Void)?
  /// The prompt keys go to: the last one opened, until it closes.
  var activePrompt: VimPanel?

  // MARK: adapter state

  private var markers: [Int: WeakMarker] = [:]
  private var markCounter = 0
  private var handlers: [EditorEvent: [(HandlerToken, (EditorEventPayload) -> Void)]] = [:]
  var lastChangeEndOffset = 0
  var virtualSelection: EditorSelection?
  var curOp: CurOp?
  var lineHandleChanges: [ChangeSet]?
  /// The query vim highlights (`cm6Query` with `forVim`).
  var searchHighlight: VimSearchHighlight?
  /// Listeners vim.js adds to the content element (`getInputField()`).
  var inputFieldKeydown: [(HandlerToken, (DOMKeyEvent) -> Void)] = []
  var inputFieldPaste: [(HandlerToken, () -> Void)] = []
  /// The selection last applied, with the flags the host doesn't store.
  private var appliedSelection: EditorSelection?
  /// Called for every transaction the adapter dispatches (the replay counts them).
  var scheduler: VimScheduler

  init(host: any VimEditor, scheduler: VimScheduler) {
    self.host = host
    self.scheduler = scheduler
  }

  // MARK: Events

  func on(_ event: EditorEvent, _ token: HandlerToken, _ fn: @escaping (EditorEventPayload) -> Void) {
    handlers[event, default: []].append((token, fn))
  }

  func off(_ event: EditorEvent, _ token: HandlerToken) {
    guard var list = handlers[event], let index = list.firstIndex(where: { $0.0 === token }) else { return }
    list.remove(at: index)
    handlers[event] = list
  }

  /// `CodeMirror.signal(cm, type, payload)`: calls the handlers registered now.
  func signal(_ event: EditorEvent, _ payload: EditorEventPayload = .none) {
    guard let list = handlers[event] else { return }
    for (_, fn) in list { fn(payload) }
  }

  private func signalTo(_ list: [(HandlerToken, (EditorEventPayload) -> Void)]?, _ payload: EditorEventPayload) {
    guard let list else { return }
    for (_, fn) in list { fn(payload) }
  }

  func onInputFieldKeydown(_ token: HandlerToken, _ fn: @escaping (DOMKeyEvent) -> Void) {
    if !inputFieldKeydown.contains(where: { $0.0 === token }) { inputFieldKeydown.append((token, fn)) }
  }

  func offInputFieldKeydown(_ token: HandlerToken) {
    inputFieldKeydown.removeAll { $0.0 === token }
  }

  // MARK: Document

  func firstLine() -> Int { 0 }
  func lastLine() -> Int { host.vimLineCount - 1 }
  func lineCount() -> Int { host.vimLineCount }
  var docLength: Int { host.vimLength }

  func getLine(_ row: Int) -> VimText {
    row < 0 || row >= host.vimLineCount ? VimText() : host.vimLine(row)
  }

  /// The offset of the end of line `row` (before its line break).
  func lineEnd(_ row: Int) -> Int {
    row + 1 < host.vimLineCount ? host.vimLineStart(row + 1) - 1 : host.vimLength
  }

  func lineLength(_ row: Int) -> Int { lineEnd(row) - host.vimLineStart(row) }

  /// `indexFromPos`: clamps the line into the document and the column into the line.
  func indexFromPos(_ pos: Pos) -> Int {
    var ch = pos.ch
    var line = pos.line
    if line < 0 {
      line = 0
      ch = 0
    }
    if line >= host.vimLineCount {
      line = host.vimLineCount - 1
      ch = Pos.endOfLine
    }
    let from = host.vimLineStart(line)
    let to = lineEnd(line)
    return ch >= to - from ? to : from + max(0, ch)
  }

  /// `posFromIndex` for a valid offset.
  func posFromIndex(_ offset: Int) -> Pos {
    let clamped = min(max(offset, 0), host.vimLength)
    let line = host.vimLineNumber(at: clamped)
    return Pos(line, clamped - host.vimLineStart(line))
  }

  /// `posFromIndex` as vim.js calls it with computed offsets: CodeMirror throws a RangeError
  /// outside the document.
  func posFromIndexChecked(_ offset: Int) throws -> Pos {
    guard offset >= 0 && offset <= host.vimLength else {
      throw JSException.rangeError("Invalid position \(offset) in document of length \(host.vimLength)")
    }
    return posFromIndex(offset)
  }

  /// The document text between two offsets.
  func sliceDoc(_ from: Int, _ to: Int) -> VimText {
    let length = host.vimLength
    let a = max(0, min(length, from))
    let b = max(a, min(length, to))
    if a == b { return VimText() }
    let startLine = host.vimLineNumber(at: a)
    let endLine = host.vimLineNumber(at: b)
    let startCh = a - host.vimLineStart(startLine)
    let endCh = b - host.vimLineStart(endLine)
    if startLine == endLine { return host.vimLine(startLine).slice(startCh, endCh) }
    var out = host.vimLine(startLine).slice(startCh).units
    for line in (startLine + 1)..<endLine {
      out.append(0x0A)
      out.append(contentsOf: host.vimLine(line).units)
    }
    out.append(0x0A)
    out.append(contentsOf: host.vimLine(endLine).slice(0, endCh).units)
    return VimText(units: out)
  }

  func getRange(_ s: Pos, _ e: Pos) -> VimText {
    sliceDoc(indexFromPos(s), indexFromPos(e))
  }

  func getValue() -> VimText { sliceDoc(0, host.vimLength) }

  func clipPos(_ p: Pos) -> Pos {
    var ch = p.ch
    var line = p.line
    if line < 0 {
      line = 0
      ch = 0
    }
    if line >= host.vimLineCount {
      line = host.vimLineCount - 1
      ch = Pos.endOfLine
    }
    return Pos(line, min(max(0, ch), lineLength(line)))
  }

  // MARK: Selection

  /// The current selection (with the flags of the last applied selection when unchanged).
  var selection: EditorSelection {
    let current = host.vimSelection
    if let applied = appliedSelection, applied.ranges.count == current.ranges.count, applied.mainIndex == current.mainIndex,
      zip(applied.ranges, current.ranges).allSatisfy({ $0.anchor == $1.anchor && $0.head == $1.head })
    {
      return applied
    }
    let ranges = current.ranges.map { SelRange.range($0.anchor, $0.head) }
    let sel = EditorSelection(ranges: ranges.isEmpty ? [.cursor(0)] : ranges, mainIndex: ranges.isEmpty ? 0 : current.mainIndex)
    appliedSelection = sel
    return sel
  }

  enum CursorEnd {
    case head, anchor, start, end
  }

  func getCursor(_ which: CursorEnd = .head) -> Pos {
    let main = selection.main
    switch which {
    case .head: return posFromIndex(main.head)
    case .anchor: return posFromIndex(main.anchor)
    case .start: return posFromIndex(main.from)
    case .end: return posFromIndex(main.to)
    }
  }

  func setCursor(_ line: Int, _ ch: Int) {
    let offset = indexFromPos(Pos(line, ch))
    dispatch(selection: .single(offset), scrollIntoView: curOp == nil)
    if let op = curOp, !op.isVimOp { onBeforeEndOperation() }
  }

  func setCursor(_ pos: Pos) {
    setCursor(pos.line, pos.ch)
  }

  func listSelections() -> [VimRange] {
    selection.ranges.map { VimRange(anchor: posFromIndex($0.anchor), head: posFromIndex($0.head)) }
  }

  func setSelections(_ ranges: [VimRange], _ primary: Int? = nil) {
    let sel = ranges.map { r -> SelRange in
      let head = indexFromPos(r.head)
      let anchor = indexFromPos(r.anchor)
      if head == anchor { return .cursor(head, assoc: 1) }
      return .range(anchor, head)
    }
    dispatch(selection: .create(sel, mainIndex: primary ?? 0))
  }

  func setSelection(_ anchor: Pos, _ head: Pos, mouse: Bool = false) {
    setSelections([VimRange(anchor: anchor, head: head)], 0)
    if mouse { onBeforeEndOperation() }
  }

  func getSelection() -> VimText { getSelections().joined("\n") }

  func getSelections() -> [VimText] {
    selection.ranges.map { sliceDoc($0.from, $0.to) }
  }

  func somethingSelected() -> Bool { selection.ranges.contains { !$0.isEmpty } }

  func isInMultiSelectMode() -> Bool { selection.ranges.count > 1 }

  // MARK: Changes

  /// `dispatchChange`: vim's edits are labeled so one command is one undo step.
  func dispatchChange(_ changes: ChangeSet, selection: EditorSelection? = nil, userEvent: String? = nil, scrollIntoView: Bool = false) {
    if host.vimIsReadOnly { return }
    var type = "input.type.compose"
    if let op = curOp, op.lastChange == nil { type = "input.type.compose.start" }
    let event = userEvent == nil || userEvent == "input" ? type : userEvent
    dispatch(changes: changes, selection: selection, userEvent: event, scrollIntoView: scrollIntoView)
  }

  func replaceRange(_ text: VimText, _ s: Pos, _ e: Pos? = nil) throws {
    let from = indexFromPos(s)
    let to = indexFromPos(e ?? s)
    let changes = try ChangeSet.of([.init(from: from, to: to, insert: text)], length: docLength)
    dispatchChange(changes)
  }

  func replaceSelection(_ text: VimText) {
    let (changes, sel) = changeByRange { range in
      ([.init(from: range.from, to: range.to, insert: text)], .cursor(range.from + ChangeSet.normalizeLineBreaks(text).length, assoc: -1))
    }
    dispatchChange(changes, selection: sel)
  }

  func replaceSelections(_ replacements: [VimText]) {
    let specs = selection.ranges.enumerated().map { i, r in
      ChangeSet.Spec(from: r.from, to: r.to, insert: i < replacements.count ? replacements[i] : VimText())
    }
    // Selection ranges are sorted and don't overlap, so this can't throw.
    dispatchChange((try? ChangeSet.of(specs, length: docLength)) ?? .empty(docLength))
  }

  /// `EditorState.changeByRange`.
  func changeByRange(_ f: (SelRange) -> ([ChangeSet.Spec], SelRange)) -> (ChangeSet, EditorSelection) {
    let sel = selection
    let length = docLength
    let first = f(sel.ranges[0])
    var changes = (try? ChangeSet.of(first.0, length: length)) ?? .empty(length)
    var ranges = [first.1]
    for i in 1..<max(1, sel.ranges.count) {
      let result = f(sel.ranges[i])
      let newChanges = (try? ChangeSet.of(result.0, length: length)) ?? .empty(length)
      let newMapped = newChanges.map(changes)
      for j in 0..<i { ranges[j] = ranges[j].map(newMapped) }
      let mapBy = changes.mapDesc(newChanges, before: true)
      ranges.append(result.1.map(mapBy))
      changes = changes.compose(newMapped)
    }
    return (changes, .create(ranges, mainIndex: sel.mainIndex))
  }

  func setValue(_ text: VimText) {
    let changes = (try? ChangeSet.of([.init(from: 0, to: docLength, insert: text)], length: docLength)) ?? .empty(docLength)
    dispatch(changes: changes, selection: .single(0))
  }

  // MARK: Transactions

  /// `view.dispatch(transaction)` followed by the vim view plugin's `update`.
  func dispatch(changes: ChangeSet? = nil, selection newSelection: EditorSelection? = nil, userEvent: String? = nil, scrollIntoView: Bool = false) {
    let changes = changes ?? .empty(docLength)
    let resulting = newSelection ?? selection.map(changes)
    var list: [VimChange] = []
    changes.iterChanges { fromA, toA, _, _, text in list.append(VimChange(from: fromA, to: toA, text: text)) }
    var transaction = VimTransaction(
      changes: list,
      selection: VimSelection(ranges: resulting.ranges.map { .init(anchor: $0.anchor, head: $0.head) }, mainIndex: resulting.mainIndex),
      userEvent: userEvent, scrollIntoView: scrollIntoView)
    transaction.changeSet = changes
    transaction.selectionIsExplicit = newSelection != nil
    host.vimApply(transaction)
    appliedSelection = resulting
    viewUpdate(changes: changes.isEmpty ? nil : changes, selectionSet: newSelection != nil)
  }

  /// What the host applied on its own (typing, undo, a mouse selection), reported to vim.
  func hostDidApply(_ transaction: VimTransaction, selectionSet: Bool = true) {
    let changes = transaction.changeSet ?? ((try? ChangeSet.of(
      transaction.changes.map { .init(from: $0.from, to: $0.to, insert: $0.text) }, length: docLengthBefore(transaction))) ?? .empty(docLength))
    appliedSelection = nil
    viewUpdate(changes: changes.isEmpty ? nil : changes, selectionSet: selectionSet)
  }

  private func docLengthBefore(_ transaction: VimTransaction) -> Int {
    var length = host.vimLength
    for change in transaction.changes { length += (change.to - change.from) - change.text.length }
    return length
  }

  /// The vim view plugin's `update(update)`.
  private func viewUpdate(changes: ChangeSet?, selectionSet: Bool) {
    if let changes { onChange(changes) }
    if selectionSet { onSelectionChange() }
    if let op = curOp, !op.isVimOp { onBeforeEndOperation() }
  }

  private func onChange(_ changes: ChangeSet) {
    lineHandleChanges?.append(changes)
    for (id, weak) in markers {
      if let marker = weak.marker { marker.update(changes) } else { markers[id] = nil }
    }
    if var virtual = virtualSelection {
      virtual.ranges = virtual.ranges.map { $0.map(changes) }
      virtualSelection = virtual
    }
    let op = curOp ?? CurOp()
    curOp = op
    changes.iterChanges(individual: true) { _, _, fromB, toB, text in
      if op.changeStart == nil || op.changeStart! > fromB { op.changeStart = fromB }
      lastChangeEndOffset = toB
      let change = ChangeObj(text: text.split(unit: 0x0A))
      if let last = op.lastChange {
        last.next = change
        op.lastChange = change
      } else {
        op.lastChange = change
        op.change = change
      }
    }
    if op.changeHandlers == nil { op.changeHandlers = handlers[.change] }
  }

  private func onSelectionChange() {
    let op = curOp ?? CurOp()
    curOp = op
    if op.cursorActivityHandlers == nil { op.cursorActivityHandlers = handlers[.cursorActivity] }
    op.cursorActivity = true
  }

  /// `operation(fn)`: batches change and cursor events until `fn` returns.
  @discardableResult
  func operation<T>(_ body: () throws -> T) throws -> T {
    if curOp == nil { curOp = CurOp(depth: 0) }
    if let d = curOp!.depth { curOp!.depth = d + 1 }
    defer {
      if let op = curOp {
        if let d = op.depth {
          op.depth = d - 1
          if d - 1 == 0 { onBeforeEndOperation() }
        } else {
          onBeforeEndOperation()
        }
      }
    }
    return try body()
  }

  func onBeforeEndOperation() {
    var scroll = false
    if let op = curOp {
      if let change = op.change { signalTo(op.changeHandlers, .change(change)) }
      if op.cursorActivity {
        signalTo(op.cursorActivityHandlers, .none)
        if op.isVimOp { scroll = true }
      }
      curOp = nil
    }
    if scroll { host.vimScrollIntoView(nil) }
  }

  // MARK: Bookmarks

  func nextMarkID() -> Int {
    defer { markCounter += 1 }
    return markCounter
  }

  func register(_ marker: Marker) { markers[marker.id] = WeakMarker(marker: marker) }

  func unregister(_ marker: Marker) { markers[marker.id] = nil }

  func setBookmark(_ cursor: Pos, insertLeft: Bool = false) -> Marker {
    Marker(self, offset: indexFromPos(cursor), assoc: insertLeft ? 1 : -1)
  }

  func getLastEditEnd() -> Pos { posFromIndex(lastChangeEndOffset) }

  // MARK: Line handles

  func getLineHandle(_ row: Int) -> LineHandle {
    if lineHandleChanges == nil { lineHandleChanges = [] }
    return LineHandle(row: row, index: indexFromPos(Pos(row, 0)))
  }

  func getLineNumber(_ handle: LineHandle) -> Int? {
    guard let updates = lineHandleChanges else { return nil }
    var offset = handle.index
    for update in updates {
      guard let mapped = update.mapPos(offset, assoc: 1, mode: .trackAfter) else { return nil }
      offset = mapped
    }
    let pos = posFromIndex(offset)
    return pos.ch == 0 ? pos.line : nil
  }

  func releaseLineHandles() { lineHandleChanges = nil }

  // MARK: Options

  func setOption(_ name: String, _ value: VimOptionValue?) {
    switch name {
    case "keyMap": keyMap = value?.stringValue
    case "textwidth": textwidth = value?.intValue
    default: break
    }
  }

  /// `getOption(name)`: nil stands for `undefined`.
  func getOption(_ name: String) -> VimOptionValue? {
    switch name {
    case "firstLineNumber": return .number(1)
    case "tabSize": return .number(Double(host.vimTabSize > 0 ? host.vimTabSize : 4))
    case "readOnly": return .bool(host.vimIsReadOnly)
    case "indentWithTabs": return .bool(host.vimIndentUnit == "\t")
    case "indentUnit": return .number(Double(host.vimIndentUnit.utf16.isEmpty ? 2 : host.vimIndentUnit.utf16.count))
    case "textwidth": return textwidth.map { .number(Double($0)) }
    case "keyMap": return .string(keyMap ?? "vim")
    default: return nil
    }
  }

  var tabSize: Int { host.vimTabSize > 0 ? host.vimTabSize : 4 }
  var indentWithTabs: Bool { host.vimIndentUnit == "\t" }

  func toggleOverwrite(_ on: Bool) { overwrite = on }

  // MARK: Interface

  func focus() { host.vimFocus() }

  func defaultTextHeight() -> Double { host.vimLineHeight }

  /// `getTokenTypeAt`: "string" or "comment" inside such tokens; plain text has neither.
  func getTokenTypeAt(_ pos: Pos) -> String { "" }

  // MARK: Multiple selections

  /// `forEachSelection(command)`: runs `command` once per range with that range selected.
  func forEachSelection(_ command: () throws -> Void) throws {
    let sel = selection
    virtualSelection = EditorSelection(ranges: sel.ranges, mainIndex: sel.mainIndex)
    var i = 0
    while let virtual = virtualSelection, i < virtual.ranges.count {
      let range = virtual.ranges[i]
      dispatch(selection: EditorSelection(ranges: [range], mainIndex: 0))
      try command()
      virtualSelection?.ranges[i] = selection.ranges[0]
      i += 1
    }
    if let virtual = virtualSelection { dispatch(selection: virtual) }
    virtualSelection = nil
  }

  /// `sendCmKey` → `CodeMirror.lookupKey` → `CodeMirror.keys`: a special key vim replays in
  /// insert mode ("Backspace", "Delete", "ArrowLeft"…), run through the editor's key bindings. The
  /// host may handle it (`vimPerformKey`); otherwise the bindings of the vectors' oracle editor
  /// apply: Backspace and Delete remove a grapheme cluster (or the selection), the arrows move
  /// like CodeMirror's `cursorCharLeft`/`cursorCharRight`/`cursorLineUp`/`cursorLineDown`.
  func runInsertModeKey(_ key: String) {
    let bound = ["Left", "Right", "Up", "Down", "Backspace", "Delete"]
    var name: String? = bound.contains(key) ? key : nil
    if name == nil, key.hasPrefix("Arrow"), bound.contains(String(key.dropFirst(5))) { name = String(key.dropFirst(5)) }
    guard let name else { return }
    if host.vimPerformKey(name) { return }
    switch name {
    case "Backspace": deleteByGrapheme(forward: false, scrollIntoView: false)
    case "Delete": deleteByGrapheme(forward: true, scrollIntoView: false)
    case "Left": cursorCharLeft()
    case "Right": cursorCharRight()
    case "Up": cursorLine(forward: false)
    default: cursorLine(forward: true)
    }
  }

  /// Deletes each selection, or the grapheme cluster (or line break) before/after each cursor.
  func deleteByGrapheme(forward: Bool, scrollIntoView: Bool) {
    if host.vimIsReadOnly { return }
    let (changes, sel) = graphemeDeletion(forward: forward)
    dispatch(changes: changes, selection: sel, userEvent: forward ? "delete.forward" : "delete.backward", scrollIntoView: scrollIntoView)
  }

  /// The changes of `deleteByGrapheme`: each non-empty selection, otherwise the grapheme cluster
  /// before/after the cursor or the line break there.
  func graphemeDeletion(forward: Bool) -> (ChangeSet, EditorSelection) {
    changeByRange { range in
      if !range.isEmpty { return ([.init(from: range.from, to: range.to)], .cursor(range.from)) }
      let line = host.vimLineNumber(at: range.head)
      let lineFrom = host.vimLineStart(line)
      let text = host.vimLine(line)
      let offset = range.head - lineFrom
      var from = range.head, to = range.head
      if forward {
        to = offset < text.length ? lineFrom + graphemeBoundary(text, offset, forward: true) : min(lineEnd(line) + 1, docLength)
      } else {
        from = offset > 0 ? lineFrom + graphemeBoundary(text, offset, forward: false) : max(lineFrom - 1, 0)
      }
      return ([.init(from: from, to: to)], .cursor(from))
    }
  }

  /// `state.replaceSelection(text)`: every selection replaced, the cursor after the text.
  func selectionReplacement(_ text: VimText) -> (ChangeSet, EditorSelection) {
    changeByRange { range in ([.init(from: range.from, to: range.to, insert: text)], .cursor(range.from + text.length)) }
  }

  /// `overWriteSelection(text)`: replace mode typing.
  func overWriteSelection(_ text: VimText) {
    let sel = selection
    let length = docLength
    let ranges = sel.ranges.map { x -> SelRange in
      if x.isEmpty {
        let ch = x.to < length ? sliceDoc(x.from, x.to + 1) : VimText()
        if !ch.isEmpty && !ch.contains(unit: 0x0A) { return .range(x.from, x.to + 1) }
      }
      return x
    }
    dispatch(selection: EditorSelection.create(ranges, mainIndex: sel.mainIndex))
    replaceSelection(text)
  }
}
