/// Package-internal entry points for `DailyDoListVimTestSupport`, the vector replay any
/// `VimEditor` host can run (the web vectors' api steps, the oracle's native edits and the
/// expected-state snapshot need the adapter and the register table).
extension VimSession {
  package func replaySetSelections(_ ranges: [VimRange], primary: Int) {
    cm.setSelections(ranges, primary)
  }

  package func replaySetCursor(line: Int, ch: Int) {
    cm.setCursor(line, ch)
  }

  package func replaySetValue(_ text: VimText) {
    cm.setValue(text)
  }

  package func replayReplaceRange(_ text: VimText, from: VimPosition, to: VimPosition?) throws {
    try cm.replaceRange(text, from, to)
  }

  /// CodeMirror 5's `cm.setOption` (the adapter implements `keyMap` and `textwidth`).
  package func replaySetEditorOption(_ name: String, _ value: VimOptionValue?) {
    cm.setOption(name, value)
  }

  package func replayClearLastMessage() {
    lastMessage = nil
  }

  /// The index of the main selection range as vim sees it.
  package var replayMainIndex: Int { cm.selection.mainIndex }

  /// The oracle editor's native edit for a token vim left to the editor (the vectors README, rule
  /// 2): a character, `<Space>`, `<CR>` or `<Tab>` replaces every selection; `<BS>`/`<Del>` delete
  /// each selection or the grapheme cluster before/after each cursor. nil for other tokens.
  package func replayNativeEdit(for token: String) -> (changes: VimChangeSet, selection: VimSelection, userEvent: String)? {
    let event = DOMKeyEvent(vimKey: token)
    let edit: (ChangeSet, EditorSelection)
    let userEvent: String
    if let text = event.insertedText {
      edit = cm.selectionReplacement(text)
      userEvent = "input.type"
    } else if token == "<BS>" || token == "<Del>" {
      edit = cm.graphemeDeletion(forward: token == "<Del>")
      userEvent = token == "<Del>" ? "delete.forward" : "delete.backward"
    } else {
      return nil
    }
    let selection = VimSelection(
      ranges: edit.1.ranges.map { .init(anchor: $0.anchor, head: $0.head) }, mainIndex: edit.1.mainIndex)
    return (VimChangeSet(edit.0), selection, userEvent)
  }
}

extension Vim {
  /// `Vim.getRegisterController().pushText(name, operator, text, linewise, blockwise)`.
  package func replayPushText(_ name: String?, _ op: String, _ text: VimText, linewise: Bool, blockwise: Bool) {
    globalState.registerController.pushText(name, op, text, linewise: linewise, blockwise: blockwise)
  }

  /// The register called `name` if it exists (reading doesn't create it).
  package func replayExistingRegister(_ name: String) -> VimRegister? {
    globalState.registerController.registers[name]
  }
}
