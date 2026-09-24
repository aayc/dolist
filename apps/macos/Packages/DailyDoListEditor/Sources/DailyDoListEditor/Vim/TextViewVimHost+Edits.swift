import AppKit
import DailyDoListVim

/// The edit pipeline seen from vim: which edits are vim's (not reported back, undo step labeled
/// with vim's user event), which are the editor's (reported to vim once the operation is over),
/// and undo/redo for `u` and `<C-r>`.
extension TextViewVimHost {
  // MARK: Operations

  /// An editor operation starts (a key, a command, a paste, a remote update): its edits reach vim
  /// together, with the selection it ends with.
  func beginOperation(userEvent: String) {
    operationDepth += 1
    operationUserEvents.append(userEvent)
  }

  func endOperation() {
    operationDepth -= 1
    operationUserEvents.removeLast()
    if operationDepth == 0 { flushToVim() }
  }

  /// The user event edits get now: the innermost operation's, "input" outside any.
  var currentUserEvent: String { operationUserEvents.last.flatMap { $0 } ?? "input" }

  /// Runs an edit of the editor (the user's Backspace replayed by vim) and tells vim right away,
  /// like a CodeMirror transaction inside a vim command.
  func performEditorEdit(_ body: () -> Void) {
    beginOperation(userEvent: "input")
    body()
    operationDepth -= 1
    operationUserEvents.removeLast()
    flushToVim()
  }

  // MARK: Announced edits

  /// `shouldChangeText`: records what the edit replaces. True when vim's history records the edit
  /// (the text view then doesn't register an undo action).
  func willReplace(_ ranges: [NSRange], with strings: [String]) -> Bool {
    guard isAttached, !controller.replacingDocument, !ranges.isEmpty else { return false }
    let pairs = zip(ranges, strings).sorted { $0.0.location < $1.0.location }
    let changes = pairs.map { VimChange(from: $0.0.location, to: $0.0.end, text: VimText($0.1 as NSString)) }
    guard let set = try? VimChangeSet(changes: changes, length: storage.length) else { return false }
    let start = changes[0].from
    let end = changes.map(\.to).max() ?? start
    announcements.append(
      EditAnnouncement(
        changes: set, originalStart: start, originalText: text(in: NSRange(start, end)), selectionBefore: selection,
        kind: applying, userEvent: currentUserEvent))
    return true
  }

  func changeWasRefused() {
    if !announcements.isEmpty { announcements.removeLast() }
  }

  /// `didChangeText`: the announced edit is done.
  func textDidChange() {
    guard isAttached else { return }
    guard !announcements.isEmpty else {
      if operationDepth == 0 { flushToVim() }
      return
    }
    // Usually one announcement per `didChangeText`; an IME composition announces every step of
    // the marked text and completes them together.
    let pending = announcements
    announcements.removeAll()
    let announcement = pending[0]
    var changes = announcement.changes
    var inverse = announcement.changes.inverted(original: announcement.original)
    for next in pending.dropFirst() {
      guard next.changes.length == changes.newLength else {
        recorder.forgetTop()
        return
      }
      changes = changes.composed(with: next.changes)
      inverse = next.changes.inverted(original: next.original).composed(with: inverse)
    }
    guard storage.length == changes.newLength else {
      // The text view did something else than it announced: the history can't follow it.
      recorder.forgetTop()
      return
    }
    switch announcement.kind {
    case .vim(let userEvent)?:
      recorder.record(
        changes, inverse: inverse, startSelection: announcement.selectionBefore, userEvent: userEvent, time: clock(),
        in: controller)
    case .history?:
      if vimRunsHistory, var capture = historyCapture {
        capture.applied = capture.applied.map { $0.composed(with: changes) } ?? changes
        historyCapture = capture
      } else {
        addPending(changes, userEvent: "undo")
      }
    case nil:
      recorder.record(
        changes, inverse: inverse, startSelection: announcement.selectionBefore, userEvent: announcement.userEvent,
        time: clock(), in: controller)
      addPending(changes, userEvent: announcement.userEvent)
    }
    if operationDepth == 0 { flushToVim() }
  }

  /// Every storage edit (after it happened).
  func storageDidEdit(location: Int, oldLength: Int, newLength: Int) {
    invalidateLineCache()
    guard isAttached else { return }
    searchHighlighter.textDidChange()
    guard announcements.isEmpty else { return }
    // Nobody announced this edit: the text view's own undo action ran, or the storage was edited
    // directly.
    let lengthBefore = storage.length - newLength + oldLength
    let change = VimChange(from: location, to: location + oldLength, text: text(in: NSRange(location: location, length: newLength)))
    guard let set = try? VimChangeSet(changes: [change], length: lengthBefore) else { return }
    if var capture = historyCapture {
      capture.changes = capture.changes.length == lengthBefore ? capture.changes.composed(with: set) : set
      historyCapture = capture
      return
    }
    recorder.forgetTop()
    addPending(set, userEvent: nil)
  }

  private func addPending(_ changes: VimChangeSet, userEvent: String?) {
    if let pending = pendingChanges, pending.newLength != changes.length { flushToVim() }
    pendingChanges = pendingChanges.map { $0.composed(with: changes) } ?? changes
    pendingUserEvent = userEvent
  }

  /// Tells vim about the editor's edits and selection changes since it last heard (never in the
  /// middle of an IME composition, whose steps would read as typed text).
  func flushToVim() {
    guard let session, !textView.hasMarkedText() else { return }
    if let changes = pendingChanges {
      pendingChanges = nil
      pendingSelectionMove = false
      session.editorDidChange(VimTransaction(changeSet: changes, selection: selection, userEvent: pendingUserEvent))
    } else if pendingSelectionMove {
      pendingSelectionMove = false
      session.editorSelectionDidChange()
    } else {
      return
    }
    searchHighlighter.refresh(in: self)
    statusDidChange()
    cursorDidChange()
  }

  // MARK: Several cursors

  /// Typing at every cursor of vim's multiple selection (visual block `I`, `A`, `c`).
  func insertAtEveryCursor(_ text: String) -> Bool {
    guard hasSeveralCursorsInInsertMode else { return false }
    let insert = VimText(text as NSString)
    let ranges = selection.ranges.sorted { $0.from < $1.from }
    var cursors: [VimSelection.Range] = []
    var delta = 0
    for range in ranges {
      cursors.append(.init(cursor: range.from + delta + insert.length))
      delta += insert.length - (range.to - range.from)
    }
    let changes = ranges.map { VimChange(from: $0.from, to: $0.to, text: insert) }
    applyEditorEdit(changes, selection: VimSelection(ranges: cursors, mainIndex: selection.mainIndex), userEvent: "input.type")
    return true
  }

  /// Backspace or Delete at every cursor: each range, or the character before/after each cursor.
  func deleteAtEveryCursor(forward: Bool) -> Bool {
    guard hasSeveralCursorsInInsertMode else { return false }
    let string = storage.mutableString
    let length = string.length
    let ranges = selection.ranges.sorted { $0.from < $1.from }
    var deletions: [NSRange] = []
    for range in ranges {
      var deletion = NSRange(location: range.from, length: range.to - range.from)
      if deletion.length == 0 {
        if forward, range.head < length {
          deletion = string.rangeOfComposedCharacterSequence(at: range.head)
        } else if !forward, range.head > 0 {
          deletion = string.rangeOfComposedCharacterSequence(at: range.head - 1)
        }
      }
      if let last = deletions.last, deletion.location < last.end { deletion = NSRange(last.end, max(last.end, deletion.end)) }
      deletions.append(deletion)
    }
    var cursors: [VimSelection.Range] = []
    var delta = 0
    for deletion in deletions {
      cursors.append(.init(cursor: deletion.location - delta))
      delta += deletion.length
    }
    let changes = deletions.filter { $0.length > 0 }.map { VimChange(from: $0.location, to: $0.end, text: VimText()) }
    applyEditorEdit(
      changes, selection: VimSelection(ranges: cursors, mainIndex: selection.mainIndex),
      userEvent: forward ? "delete.forward" : "delete.backward")
    return true
  }

  private var hasSeveralCursorsInInsertMode: Bool {
    guard let session, selection.ranges.count > 1, !textView.hasMarkedText(), controller.configuration.isEditable else { return false }
    return session.mode == .insert
  }

  /// An edit the editor makes on its own (not a text view command), with the selection after it.
  func applyEditorEdit(_ changes: [VimChange], selection next: VimSelection, userEvent: String) {
    beginOperation(userEvent: userEvent)
    applyChanges(changes)
    setSelection(next)
    pendingScroll = selection.main
    endOperation()
  }

  // MARK: Mouse

  /// A click in the text leaves vim's command line, like the web app's prompt losing focus.
  func textWasClicked() {
    session?.activePrompt?.close()
  }

  // MARK: Paste

  /// Before a paste: into vim's command line when a prompt is open, else vim gets ready (in
  /// normal mode it moves right and enters insert mode).
  func willPaste() -> Bool {
    guard let session else { return false }
    if let prompt = session.activePrompt {
      let pasted = (NSPasteboard.general.string(forType: .string) ?? "").filter { $0 != "\n" && $0 != "\r" && $0 != "\r\n" }
      guard !pasted.isEmpty else { return true }
      prompt.setValue(prompt.value.string + pasted)
      prompt.keyUp("<M-v>")
      return true
    }
    session.willPaste()
    return false
  }

  // MARK: Undo

  func vimUndo() -> VimTransaction? { runHistory(undo: true) }

  func vimRedo() -> VimTransaction? { runHistory(undo: false) }

  /// Runs one undo (or redo) step of the note's history and returns what it applied.
  private func runHistory(undo: Bool) -> VimTransaction? {
    let manager = controller.noteUndoManager
    guard undo ? manager.canUndo : manager.canRedo else { return nil }
    flushToVim()
    historyCapture = HistoryCapture(changes: .empty(length: storage.length), applied: nil)
    vimRunsHistory = true
    if undo { manager.undo() } else { manager.redo() }
    vimRunsHistory = false
    let capture = historyCapture
    historyCapture = nil
    pendingSelectionMove = false
    if capture?.applied == nil { recorder.forgetTop() }
    let changes = capture?.applied ?? capture?.changes ?? .empty(length: storage.length)
    return VimTransaction(changeSet: changes, selection: selection, userEvent: undo ? "undo" : "redo", scrollIntoView: true)
  }
}
