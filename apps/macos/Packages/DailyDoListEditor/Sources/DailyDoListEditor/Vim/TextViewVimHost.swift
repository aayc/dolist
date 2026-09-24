import AppKit
import DailyDoListVim

/// Vim's view of a `MarkdownEditorController`: `VimEditor` on its TextKit text system.
///
/// - Lines come from the highlighter's line index; nothing copies the whole document per key.
/// - Vim's edits go through the editor's normal pipeline (`shouldChangeText`, `replaceCharacters`,
///   `didChangeText`), so undo, badges, live preview, styling and `editorTextDidChange` behave as
///   for typing. Undo steps follow CodeMirror's history (`VimUndoRecorder`) on the note's
///   `UndoManager`, so ⌘Z and `u` walk the same steps.
/// - The editor's own edits (typing, paste, list commands, remote changes) reach vim once each
///   operation is over, with the selection afterwards (`session.editorDidChange`).
/// - The selection keeps vim's anchor, head and main range, including cursors NSTextView can't show
///   (the empty ranges of a visual block, several insertion points): the text view shows what it
///   can and the host draws the rest.
@MainActor
final class TextViewVimHost: VimEditor {
  unowned let controller: MarkdownEditorController
  private(set) var session: VimSession?
  let recorder = VimUndoRecorder()
  let cursor = VimCursorRenderer()
  let searchHighlighter = VimSearchHighlighter()
  private(set) var panelView: VimPanelView?
  /// Milliseconds since 1970 for undo grouping (CodeMirror joins typing less than 500 ms apart).
  var clock: () -> Double = { Date().timeIntervalSince1970 * 1000 }
  /// The tab width in columns and one level of indentation, like the web editor (`\t`, 4).
  var tabSize = 4
  var indentUnit = "\t"

  // MARK: Selection state

  /// What vim sees as the selection: vim's own (anchor, head, main range, empty ranges) while the
  /// text view shows it, else the text view's.
  private(set) var selection: VimSelection = .cursor(0)
  /// The text view's ranges for `selection`.
  private var shownRanges: [NSRange] = [NSRange(location: 0, length: 0)]
  private var settingSelection = false

  // MARK: Edit state

  /// Nesting of editor operations; the edits of the outermost one are reported when it ends.
  var operationDepth = 0
  /// CodeMirror user events of the open operations (innermost last; nil: none).
  var operationUserEvents: [String?] = []
  /// Edits announced by `shouldChangeText` and not yet completed by `didChangeText`.
  var announcements: [EditAnnouncement] = []
  /// What the next announced edit is (vim's own, an undo step, the host's).
  var applying: ApplyKind?
  /// The editor's edits vim hasn't heard about yet, composed, and their user event.
  var pendingChanges: VimChangeSet?
  var pendingUserEvent: String?
  /// The selection moved since vim last heard.
  var pendingSelectionMove = false
  /// Storage edits made while `u` / `<C-r>` ran an undo action.
  var historyCapture: HistoryCapture?
  /// Set while vim itself runs undo/redo (vim applies the result, so it isn't reported).
  var vimRunsHistory = false
  /// A selection vim asked to scroll into view, applied at the next layout pass.
  var pendingScroll: VimSelection.Range?
  /// Keys being routed (status updates wait for the end of the key).
  var keyDepth = 0
  var statusIsStale = false
  /// The document was replaced while a key ran: vim starts over once the key is done.
  var needsFreshSession = false
  private(set) var status: EditorVimStatus?
  private var lineCache: [(line: Int, text: VimText)] = []
  private var undoObservers: [NSObjectProtocol] = []

  init(controller: MarkdownEditorController) {
    self.controller = controller
  }

  var textView: MarkdownTextView { controller.markdownTextView }
  var storage: NSTextStorage { controller.storage }
  var lineIndex: LineIndex { controller.highlighter.lineIndex }
  var isAttached: Bool { session != nil }

  // MARK: Attaching

  /// Attaches `vim` (a fresh session in normal mode). Global state stays in `vim`.
  func attach(_ vim: Vim) {
    if let session, session.vim === vim { return }
    detach()
    textView.breakUndoCoalescing()
    recorder.reset()
    selection = derivedSelection(
      textView.selectedRanges.map(\.rangeValue),
      previous: .cursor(textView.selectedRange().location))
    shownRanges = textView.selectedRanges.map(\.rangeValue)
    let session = vim.attach(to: self)
    self.session = session
    session.onModeChange = { [weak self] _, _ in self?.statusDidChange() }
    session.onCommandDone = { [weak self] in self?.statusDidChange() }
    session.onKeypress = { [weak self] _ in self?.statusDidChange() }
    for name in [NSNotification.Name.NSUndoManagerDidUndoChange, .NSUndoManagerDidRedoChange] {
      undoObservers.append(
        NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) {
          [weak self] notification in
          let manager = (notification.object as AnyObject?).map(ObjectIdentifier.init)
          MainActor.assumeIsolated { self?.undoManagerDidRevert(manager) }
        })
    }
    statusDidChange()
    cursorDidChange()
  }

  /// Detaches vim (vim mode off, or before a fresh session).
  func detach() {
    guard let session else { return }
    session.onModeChange = nil
    session.onCommandDone = nil
    session.onKeypress = nil
    for observer in undoObservers { NotificationCenter.default.removeObserver(observer) }
    undoObservers.removeAll()
    self.session = nil
    session.detach()
    textView.breakUndoCoalescing()
    announcements.removeAll()
    pendingChanges = nil
    pendingSelectionMove = false
    pendingScroll = nil
    historyCapture = nil
    applying = nil
    recorder.reset()
    showPanel(nil)
    searchHighlighter.show(nil, in: self)
    cursorDidChange()
    textView.updateInsertionPointStateAndRestartTimer(true)
    if status != nil {
      status = nil
      controller.delegate?.editor(controller, vimStatusDidChange: nil)
    }
  }

  /// A note switch replaced the document: vim starts over in normal mode, so marks, a visual
  /// selection or a half-typed command of the previous note never apply to this one. Registers,
  /// history, macros and mappings are global and stay.
  func documentDidReset() {
    lineCache.removeAll()
    guard let vim = session?.vim else { return }
    announcements.removeAll()
    pendingChanges = nil
    pendingSelectionMove = false
    pendingScroll = nil
    historyCapture = nil
    recorder.reset()
    shownRanges = textView.selectedRanges.map(\.rangeValue)
    selection = derivedSelection(shownRanges, previous: .cursor(textView.selectedRange().location))
    // A command switching notes (`:e`, `gt`) is still running in the old session: swap after it.
    if keyDepth > 0 {
      needsFreshSession = true
      return
    }
    detach()
    attach(vim)
  }

  // MARK: Text

  var vimLineCount: Int { lineIndex.count }

  func vimLine(_ line: Int) -> VimText {
    if let cached = lineCache.first(where: { $0.line == line }) { return cached.text }
    let text = self.text(in: lineIndex.contentRange(ofLine: line, textLength: storage.length))
    if lineCache.count >= 4 { lineCache.removeFirst() }
    lineCache.append((line, text))
    return text
  }

  func vimLineStart(_ line: Int) -> Int { lineIndex.start(ofLine: line) }

  func vimLineNumber(at offset: Int) -> Int { lineIndex.line(containing: offset) }

  var vimLength: Int { storage.length }

  /// The document's code units in `range` (lone surrogates included).
  func text(in range: NSRange) -> VimText {
    let range = range.clamped(to: storage.length)
    guard range.length > 0 else { return VimText() }
    var units = [UInt16](repeating: 0, count: range.length)
    units.withUnsafeMutableBufferPointer {
      storage.mutableString.getCharacters($0.baseAddress!, range: range)
    }
    return VimText(units: units)
  }

  func invalidateLineCache() {
    if !lineCache.isEmpty { lineCache.removeAll() }
  }

  // MARK: Selection

  var vimSelection: VimSelection { selection }

  /// Shows `next` in the text view (the ranges it can show) and makes it vim's selection.
  func setSelection(_ next: VimSelection) {
    let length = storage.length
    let clamped = VimSelection(
      ranges: next.ranges.map {
        .init(anchor: min(max($0.anchor, 0), length), head: min(max($0.head, 0), length))
      },
      mainIndex: min(max(next.mainIndex, 0), max(next.ranges.count - 1, 0)))
    selection = clamped
    let shown = Self.displayRanges(clamped)
    settingSelection = true
    controller.setSelection(shown, adjust: false)
    settingSelection = false
    shownRanges = textView.selectedRanges.map(\.rangeValue)
    cursorDidChange()
  }

  /// What NSTextView can show of `selection`: its non-empty ranges, else the main cursor.
  static func displayRanges(_ selection: VimSelection) -> [NSRange] {
    let ranges = selection.ranges.filter { !$0.isEmpty }.map {
      NSRange(location: $0.from, length: $0.to - $0.from)
    }
    .sorted { $0.location < $1.location }
    if !ranges.isEmpty { return ranges }
    let main = selection.main
    return [NSRange(location: main.head, length: 0)]
  }

  /// The text view's selection changed (the user, NSTextView's key handling, an edit).
  func textViewSelectionDidChange(stillSelecting: Bool) {
    guard !settingSelection else { return }
    let ranges = textView.selectedRanges.map(\.rangeValue)
    guard ranges != shownRanges else { return }
    let previous = selection
    selection = derivedSelection(ranges, previous: previous)
    cursorDidChange()
    // A drag in progress: vim hears about the selection the mouse ends with.
    guard !stillSelecting else { return }
    shownRanges = ranges
    guard isAttached, applying == nil, announcements.isEmpty, !controller.replacingText,
      !controller.replacingDocument
    else { return }
    let manager = controller.noteUndoManager
    if manager.isUndoing || manager.isRedoing {
      // The text view's own undo action (⌘Z): vim hears about it when the undo is over.
      pendingSelectionMove = true
      return
    }
    // A selection change that isn't part of an edit (a click, an arrow key in insert mode).
    if pendingChanges == nil {
      recorder.recordSelection(previous, userEvent: "select", time: clock())
    }
    pendingSelectionMove = true
    if operationDepth == 0 { flushToVim() }
  }

  /// The selection for ranges the text view reports, keeping the direction of the selection it
  /// replaces (NSTextView has no anchor): a range that grew from the old anchor keeps it.
  func derivedSelection(_ ranges: [NSRange], previous: VimSelection) -> VimSelection {
    let length = storage.length
    let clamped = ranges.map { $0.clamped(to: length) }
    guard clamped.count == 1, let range = clamped.first else {
      return VimSelection(
        ranges: clamped.map { .init(anchor: $0.location, head: $0.end) }, mainIndex: 0)
    }
    if range.length == 0 { return .cursor(range.location) }
    let anchor = previous.main.anchor
    if anchor == range.end && anchor != range.location {
      return VimSelection(ranges: [.init(anchor: range.end, head: range.location)])
    }
    return VimSelection(ranges: [.init(anchor: range.location, head: range.end)])
  }

  /// ⌘Z or ⇧⌘Z ran an undo action of the note (not vim's `u`): the cursor goes to the start of
  /// what it selected, like `u`, and vim hears about it.
  private func undoManagerDidRevert(_ manager: ObjectIdentifier?) {
    guard isAttached, !vimRunsHistory, manager == ObjectIdentifier(controller.noteUndoManager)
    else { return }
    let main = selection.main
    if !main.isEmpty || selection.ranges.count > 1 {
      setSelection(.cursor(main.from))
      pendingSelectionMove = true
    }
    if operationDepth == 0 { flushToVim() }
  }

  // MARK: Applying vim's transactions

  func vimApply(_ transaction: VimTransaction) {
    let before = selection
    if transaction.hasChanges {
      applying = .vim(transaction.userEvent)
      applyChanges(transaction.changes)
      applying = nil
    } else if transaction.selectionIsExplicit {
      recorder.recordSelection(before, userEvent: transaction.userEvent, time: clock())
    }
    setSelection(transaction.selection)
    if transaction.scrollIntoView { pendingScroll = selection.main }
  }

  /// Replaces `changes` (offsets before the edit, sorted) as one edit of the editor.
  @discardableResult
  func applyChanges(_ changes: [VimChange]) -> Bool {
    guard !changes.isEmpty else { return true }
    let ranges = changes.map { NSValue(range: NSRange(location: $0.from, length: $0.to - $0.from)) }
    let strings = changes.map { $0.text.nsString as String }
    guard textView.shouldChangeText(inRanges: ranges, replacementStrings: strings) else {
      return false
    }
    controller.replacingText = true
    for (range, string) in zip(ranges, strings).reversed() {
      storage.replaceCharacters(in: range.rangeValue, with: string)
    }
    controller.replacingText = false
    textView.didChangeText()
    return true
  }

  // MARK: Configuration

  var vimTabSize: Int { tabSize }
  var vimIndentUnit: String { indentUnit }
  var vimIsReadOnly: Bool { !controller.configuration.isEditable }

  // MARK: Interface

  func vimShowPanel(_ panel: VimPanel?) {
    showPanel(panel)
  }

  func showPanel(_ panel: VimPanel?) {
    guard let panel else {
      if panelView != nil {
        panelView = nil
        controller.containerView.setPanel(nil)
      }
      return
    }
    let view = panelView ?? VimPanelView()
    view.show(panel)
    panel.onUpdate = { [weak self, weak view, weak panel] in
      guard let view, let panel, self?.panelView === view else { return }
      view.show(panel)
      self?.controller.containerView.needsLayout = true
    }
    panelView = view
    controller.containerView.setPanel(view)
  }

  func vimShowSearchHighlight(_ highlight: VimSearchHighlight?) {
    searchHighlighter.show(highlight, in: self)
  }

  func vimFocus() {
    controller.focus()
  }

  func vimSave() {
    controller.delegate?.editorDidRequestSave(controller)
  }

  /// Keys vim replays in insert mode (`.` after Backspace or Delete): the editor's own delete, so
  /// list markup is removed the way the user's key removed it. Arrows move like CodeMirror.
  func vimPerformKey(_ key: String) -> Bool {
    switch key {
    case "Backspace":
      performEditorEdit { textView.deleteBackward(nil) }
    case "Delete":
      performEditorEdit { textView.deleteForward(nil) }
    default:
      return false
    }
    return true
  }

  // MARK: Status

  /// Vim's mode, pending keys or recording may have changed: reported at the end of the key (the
  /// delegate hears only real changes).
  func statusDidChange() {
    statusIsStale = true
    if keyDepth == 0 { reportStatus() }
  }

  func reportStatus() {
    statusIsStale = false
    guard let session else { return }
    let mode = EditorVimStatus.Mode(rawValue: session.mode.rawValue) ?? .normal
    let pending =
      mode == .insert || mode == .replace
      ? "" : (session.pendingRegister.map { "\"" + $0 } ?? "") + session.pendingKeys
    let next = EditorVimStatus(mode: mode, pending: pending, recording: session.recordingRegister)
    guard next != status else { return }
    let blockChanged = status.map { Self.blockStyle(of: $0) != Self.blockStyle(of: next) } ?? true
    status = next
    if blockChanged {
      textView.updateInsertionPointStateAndRestartTimer(true)
      cursorDidChange()
    }
    controller.delegate?.editor(controller, vimStatusDidChange: next)
  }

  private static func blockStyle(of status: EditorVimStatus) -> Int {
    switch status.mode {
    case .insert: 0
    case .replace: 1
    default: status.pending.isEmpty ? 2 : 3
    }
  }
}

/// What the next announced edit is.
enum ApplyKind: Equatable {
  /// Vim's own transaction, with its user event.
  case vim(String?)
  /// An undo step being applied (it registers its counterpart itself).
  case history
}

/// An edit announced by `shouldChangeText`: its changes and what the undo history needs.
struct EditAnnouncement {
  let changes: VimChangeSet
  /// The replaced text: `originalText` covers `originalStart..<originalStart + length`.
  let originalStart: Int
  let originalText: VimText
  let selectionBefore: VimSelection
  let kind: ApplyKind?
  let userEvent: String?

  func original(from: Int, to: Int) -> VimText {
    let start = from - originalStart
    let end = to - originalStart
    guard start >= 0, end <= originalText.length, start <= end else { return VimText() }
    return VimText(units: Array(originalText.units[start..<end]))
  }
}

/// Storage edits made while an undo action ran for `u` or `<C-r>`.
struct HistoryCapture {
  var changes: VimChangeSet
  /// Set by vim's own undo steps, which know exactly what they applied.
  var applied: VimChangeSet?
}
