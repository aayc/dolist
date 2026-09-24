import AppKit

extension MarkdownEditorController {
  /// Toggles the checkbox of the task on a 0-based line (`[ ]` ↔ `[x]`, other statuses → done) as
  /// an undoable edit; a checkmark pops in. False for non-task lines or a read-only editor.
  @discardableResult
  public func toggleTask(atLine line: Int) -> Bool {
    let index = highlighter.lineIndex
    guard configuration.isEditable, line >= 0, line < index.count, !highlighter.isLiteralLine(line),
      let replacement = TaskCommands.toggleTask(in: storage.mutableString, lineContaining: index.start(ofLine: line))
    else { return false }
    let edit = TextEdit(replacements: [replacement], selection: textView.selectedRanges.map(\.rangeValue))
    guard perform(edit, actionName: "Toggle Task", scroll: false) else { return false }
    animateChecks(in: edit)
    return true
  }

  /// ⌘L / ⌘↩: plain line → `- [ ] line`, list item → task, open task → done, done → open, on every
  /// selected line.
  @discardableResult
  public func toggleChecklist() -> Bool {
    guard configuration.isEditable,
      let edit = TaskCommands.toggleChecklist(in: storage.mutableString, selection: currentSelection),
      perform(edit, actionName: "Toggle Checkbox")
    else { return false }
    animateChecks(in: edit)
    return true
  }

  /// ⌘B: `**bold**` around the selection or the word at the caret (removed when already bold).
  @discardableResult
  public func toggleBold() -> Bool { toggle(.bold, actionName: "Bold") }

  /// ⌘I: `*italic*`, aware of `**bold**` and `***both***`.
  @discardableResult
  public func toggleItalic() -> Bool { toggle(.italic, actionName: "Italic") }

  /// `` `code` `` (not bound to a key by default; the host can bind it, e.g. to ⌘E).
  @discardableResult
  public func toggleInlineCode() -> Bool { toggle(.inlineCode, actionName: "Code") }

  @discardableResult
  public func toggleStrikethrough() -> Bool { toggle(.strikethrough, actionName: "Strikethrough") }

  @discardableResult
  public func toggleHighlight() -> Bool { toggle(.highlight, actionName: "Highlight") }

  /// ⌘K: `[text](|)` for selected text, `[|](url)` for a selected URL, `[|]()` otherwise.
  @discardableResult
  public func insertLink() -> Bool {
    guard configuration.isEditable else { return false }
    return perform(FormattingCommands.insertLink(in: storage.mutableString, selection: currentSelection), actionName: "Insert Link")
  }

  private func toggle(_ style: FormattingCommands.MarkupStyle, actionName: String) -> Bool {
    guard configuration.isEditable else { return false }
    return perform(FormattingCommands.toggle(style, in: storage.mutableString, selection: currentSelection), actionName: actionName)
  }

  var currentSelection: [NSRange] {
    textView.selectedRanges.map(\.rangeValue)
  }

  /// Applies a command's edit as one undoable user change (its own undo group), then sets the
  /// command's selection. Each replacement is its own storage edit, so styles and badge anchors are
  /// remapped precisely.
  @discardableResult
  func perform(_ edit: TextEdit, actionName: String, scroll: Bool = true) -> Bool {
    guard textView.isEditable else { return false }
    guard !edit.replacements.isEmpty else {
      if edit.selection != currentSelection { setSelection(edit.selection) }
      return true
    }
    let ranges = edit.replacements.map { NSValue(range: $0.range) }
    markdownTextView.breakUndoCoalescing()
    var applied = false
    withUndoGroup {
      guard textView.shouldChangeText(inRanges: ranges, replacementStrings: edit.replacements.map(\.text)) else { return }
      replacingText = true
      for replacement in edit.replacements.reversed() {
        storage.replaceCharacters(in: replacement.range, with: replacement.text)
      }
      replacingText = false
      textView.didChangeText()
      noteUndoManager.setActionName(actionName)
      applied = true
    }
    markdownTextView.breakUndoCoalescing()
    guard applied else { return false }
    setSelection(edit.selection)
    if scroll { textView.scrollRangeToVisible(textView.selectedRange()) }
    return true
  }

  func showFindInterface(_ action: NSTextFinder.Action) {
    let item = NSMenuItem()
    item.tag = action.rawValue
    textView.performTextFinderAction(item)
  }

  /// Editor key equivalents. Returns false for keys it doesn't handle (and while read-only for
  /// editing commands), so menus can still act on them.
  func performShortcut(_ event: NSEvent) -> Bool {
    let flags = event.modifierFlags.intersection([.command, .shift, .option, .control])
    let isReturn = event.keyCode == 36 || event.keyCode == 76
    if flags == .command, isReturn { return toggleChecklist() }
    guard let key = event.charactersIgnoringModifiers?.lowercased() else { return false }
    switch (flags, key) {
    case (.command, "b"): return toggleBold()
    case (.command, "i"): return toggleItalic()
    case (.command, "k"): return insertLink()
    case (.command, "l"): return toggleChecklist()
    case (.command, "s"):
      delegate?.editorDidRequestSave(self)
      return true
    case (.command, "f"):
      showFindInterface(.showFindInterface)
      return true
    case (.command, "g"):
      showFindInterface(.nextMatch)
      return true
    case ([.command, .shift], "g"):
      showFindInterface(.previousMatch)
      return true
    default:
      return false
    }
  }
}
