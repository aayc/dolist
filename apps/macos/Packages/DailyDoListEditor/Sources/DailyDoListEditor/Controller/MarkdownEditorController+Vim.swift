import AppKit
import DailyDoListVim

extension MarkdownEditorController {
  /// The vim session of this editor while vim mode is on (for status bars and host commands).
  public var vimSession: VimSession? { vimHost.session }

  /// Vim's mode line while vim mode is on (`delegate` hears about changes).
  public var vimStatus: EditorVimStatus? { vimHost.status }

  /// Attaches or detaches vim to match `configuration.vimMode` and `vim`.
  func updateVimAttachment() {
    if configuration.vimMode, let vim {
      vimHost.attach(vim)
    } else {
      vimHost.detach()
    }
  }

  /// Brackets an editing operation (a command, a paste, a remote update): vim hears about its edits
  /// when the outermost one ends, with the selection it ends with. `userEvent` labels its edits
  /// for vim's undo grouping (CodeMirror's user events).
  func beginEditorOperation(userEvent: String) {
    vimHost.beginOperation(userEvent: userEvent)
  }

  func endEditorOperation() {
    vimHost.endOperation()
  }

  // MARK: Undo steps

  /// Registers `step` on `manager` as one undoable action in a group of its own (also while
  /// `UndoManager` groups by event, which would merge the steps of one key: a macro, a mapping).
  func registerVimUndoStep(_ step: VimUndoStep, in manager: UndoManager) {
    // The text view's registration is off while it edits; vim's own step is registered anyway.
    var disabledLevels = 0
    while !manager.isUndoRegistrationEnabled {
      manager.enableUndoRegistration()
      disabledLevels += 1
    }
    defer { for _ in 0..<disabledLevels { manager.disableUndoRegistration() } }
    let opensGroup = manager.groupingLevel == 0
    let groupsByEvent = manager.groupsByEvent
    if opensGroup {
      if groupsByEvent { manager.groupsByEvent = false }
      manager.beginUndoGrouping()
    }
    // UndoManager doesn't retain targets: the action keeps its step alive.
    manager.registerUndo(withTarget: step) { [weak self, weak manager, step] _ in
      MainActor.assumeIsolated {
        guard let self, let manager else { return }
        self.revertVimUndoStep(step, in: manager)
      }
    }
    if let name = step.actionName { manager.setActionName(name) }
    if opensGroup {
      manager.endUndoGrouping()
      if groupsByEvent { manager.groupsByEvent = true }
    }
  }

  /// Undoes (or redoes) `step` from inside `UndoManager.undo()`/`redo()`: applies its changes and
  /// selection like CodeMirror's history and registers the step that goes the other way.
  func revertVimUndoStep(_ step: VimUndoStep, in manager: UndoManager) {
    let redoing = manager.isRedoing
    let host = vimHost
    let forward = step.inverse.inverted { from, to in
      host.text(in: NSRange(location: from, length: to - from))
    }
    let remembered =
      step.selectionsAfter.first ?? forward.mapSelection(step.startSelection, assoc: 1)
    beginEditorOperation(userEvent: redoing ? "redo" : "undo")
    let changes = step.inverse.changes
    if vimHost.isAttached {
      vimHost.applying = .history
      vimHost.applyChanges(changes)
      vimHost.applying = nil
      if vimHost.vimRunsHistory {
        vimHost.setSelection(step.startSelection)
      } else {
        // ⌘Z in vim mode ends like `u`: the cursor at the start of the change (the restored
        // selection would otherwise read as a mouse selection and start visual mode).
        vimHost.setSelection(
          .cursor(step.inverse.changedRanges.first?.fromB ?? step.startSelection.main.from))
      }
      vimHost.pendingScroll = vimHost.selection.main
    } else {
      applyWithoutRegistering(changes, selection: step.startSelection)
    }
    endEditorOperation()
    let counterpart = VimUndoStep(
      inverse: forward, startSelection: remembered, below: redoing ? vimHost.recorder.top : nil,
      actionName: step.actionName)
    manager.registerUndo(withTarget: counterpart) { [weak self, weak manager, counterpart] _ in
      MainActor.assumeIsolated {
        guard let self, let manager else { return }
        self.revertVimUndoStep(counterpart, in: manager)
      }
    }
    if let name = step.actionName { manager.setActionName(name) }
    vimHost.recorder.didRevert(onTop: redoing ? counterpart : step.below)
  }

  /// Applies history changes with vim off: one edit the text view doesn't register (the step's
  /// counterpart is registered instead), then the selection (what the text view can show of it).
  private func applyWithoutRegistering(_ changes: [VimChange], selection: VimSelection) {
    guard !changes.isEmpty else { return }
    let ranges = changes.map { NSValue(range: NSRange(location: $0.from, length: $0.to - $0.from)) }
    let strings = changes.map { $0.text.nsString as String }
    noteUndoManager.disableUndoRegistration()
    defer { noteUndoManager.enableUndoRegistration() }
    guard textView.shouldChangeText(inRanges: ranges, replacementStrings: strings) else { return }
    replacingText = true
    for (range, string) in zip(ranges, strings).reversed() {
      storage.replaceCharacters(in: range.rangeValue, with: string)
    }
    replacingText = false
    textView.didChangeText()
    setSelection(TextViewVimHost.displayRanges(selection), adjust: false)
    textView.scrollRangeToVisible(textView.selectedRange())
  }
}
