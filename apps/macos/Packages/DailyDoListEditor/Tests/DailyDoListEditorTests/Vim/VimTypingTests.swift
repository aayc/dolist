import AppKit
import DailyDoListVim
import Testing

@testable import DailyDoListEditor

/// Keys through `keyDown` like a keyboard: insert-mode typing goes through NSTextView (and the
/// editor's list editing), vim records it for `.`, and undo steps follow CodeMirror's history.
@MainActor
@Suite("Vim typing and undo")
struct VimTypingTests {
  @Test func insertModeTypingIsNativeAndDotRepeatsIt() {
    let editor = VimEditorHarness("one two")
    editor.press("i")
    #expect(editor.mode == .insert)
    editor.type("new ")
    editor.press("<Esc>")
    #expect(editor.text == "new one two")
    #expect(editor.mode == .normal)
    editor.press("w", "w", ".")
    #expect(editor.text == "new one new two")
    #expect(editor.session?.vim.register(".").text.string == "new ")
  }

  @Test func backspaceInInsertModeIsRecordedForDot() {
    let editor = VimEditorHarness("abc\nabc")
    editor.press("A")
    editor.type("xy")
    editor.press("<BS>", "<Esc>")
    #expect(editor.text == "abcx\nabc")
    editor.press("j", ".")
    #expect(editor.text == "abcx\nabcx")
  }

  @Test func enterContinuesListsInInsertModeAndDotRepeatsTheInsertedText() {
    let editor = VimEditorHarness("- [ ] a\n- [ ] x")
    editor.press("A", "<CR>")
    #expect(editor.text == "- [ ] a\n- [ ] \n- [ ] x")
    editor.type("b")
    editor.press("<Esc>")
    #expect(editor.text == "- [ ] a\n- [ ] b\n- [ ] x")
    editor.press("G", ".")
    #expect(editor.text == "- [ ] a\n- [ ] b\n- [ ] x\n- [ ] b")
  }

  @Test func oneVimCommandIsOneUndoStep() {
    let editor = VimEditorHarness("a b c d e")
    editor.press("2", "x")
    #expect(editor.text == "b c d e")
    editor.press("d", "w")
    #expect(editor.text == "c d e")
    editor.press(":")
    editor.type("s/ /-/g")
    editor.press("<CR>")
    #expect(editor.text == "c-d-e")
    editor.press("u")
    #expect(editor.text == "c d e")
    editor.press("u")
    #expect(editor.text == "b c d e")
    editor.press("u")
    #expect(editor.text == "a b c d e")
    editor.press("<C-r>", "<C-r>")
    #expect(editor.text == "c d e")
  }

  @Test func oneInsertSessionIsOneUndoStepAndMovingTheCaretStartsANewOne() {
    let editor = VimEditorHarness("|x")
    editor.press("i")
    editor.type("abc")
    editor.press("<BS>")
    editor.type("d")
    editor.press("<Esc>")
    #expect(editor.text == "abdx")
    editor.press("u")
    #expect(editor.text == "x")
    editor.press("<C-r>")
    #expect(editor.text == "abdx")
    // Typing, an arrow key, typing: the selection moved in between.
    editor.press("A")
    editor.type("1")
    editor.press("<Left>")
    editor.type("2")
    editor.press("<Esc>")
    #expect(editor.text == "abdx21")
    editor.press("u")
    #expect(editor.text == "abdx1")
    editor.press("u")
    #expect(editor.text == "abdx")
  }

  @Test func commandZWalksTheSameStepsAsU() {
    let editor = VimEditorHarness("one")
    editor.press("A")
    editor.type(" two")
    editor.press("<Esc>", "d", "d")
    #expect(editor.text == "")
    editor.undoManager.undo()
    #expect(editor.text == "one two")
    editor.press("u")
    #expect(editor.text == "one")
    editor.undoManager.redo()
    #expect(editor.text == "one two")
    editor.press("<C-r>")
    #expect(editor.text == "")
    #expect(!editor.undoManager.canRedo)
  }

  @Test func marksFollowEditsTheEditorMakesOnItsOwn() {
    let editor = VimEditorHarness("alpha\nbeta")
    editor.press("j", "m", "a", "g", "g")
    // A remote update inserts a line above the mark.
    editor.controller.setText("zero\nalpha\nbeta")
    editor.press("'", "a")
    #expect(editor.host.vimLineNumber(at: editor.cursor) == 2)
  }

  @Test func imeCompositionBypassesVimAndIsRecordedOnceCommitted() {
    let editor = VimEditorHarness("ab")
    editor.press("a")
    #expect(editor.mode == .insert)
    let textView = editor.textView
    textView.setMarkedText("k", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
    #expect(textView.hasMarkedText())
    // While composing, keys belong to the input method: vim doesn't see this Escape.
    #expect(editor.host.handleKeyDown(VimEditorHarness.event(for: "<Esc>", window: editor.window)) == false)
    #expect(editor.mode == .insert)
    textView.setMarkedText("か", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
    textView.insertText("か", replacementRange: NSRange(location: NSNotFound, length: 0))
    #expect(!textView.hasMarkedText())
    #expect(editor.text == "aかb")
    editor.press("<Esc>")
    #expect(editor.session?.vim.register(".").text.string == "か")
    editor.press("$", ".")
    #expect(editor.text == "aかbか")
  }

  @Test func visualBlockInsertTypesAtEveryCursor() {
    let editor = VimEditorHarness("one\ntwo\nthree")
    editor.press("<C-v>", "j", "j", "I")
    #expect(editor.mode == .insert)
    #expect(editor.host.selection.ranges.count == 3)
    editor.type("- ")
    #expect(editor.text == "- one\n- two\n- three")
    editor.press("<BS>")
    #expect(editor.text == "-one\n-two\n-three")
    editor.press("<Esc>")
    #expect(editor.text == "-one\n-two\n-three")
    #expect(editor.mode == .normal)
    editor.press("u")
    #expect(editor.text == "one\ntwo\nthree")
  }

  @Test func visualBlockAppendAndChangeAcrossShortLines() {
    let editor = VimEditorHarness("abcd\nab\nabcd")
    editor.press("l", "l", "<C-v>", "j", "j", "$", "A")
    editor.type("!")
    editor.press("<Esc>")
    #expect(editor.text == "abcd!\nab!\nabcd!")
    let change = VimEditorHarness("abcd\nabcd\nabcd")
    change.press("l", "<C-v>", "j", "j", "l", "c")
    change.type("X")
    change.press("<Esc>")
    #expect(change.text == "aXd\naXd\naXd")
  }

  @Test func escapeLeavesInsertModeInsteadOfCancellingOrCompleting() {
    let editor = VimEditorHarness("word")
    editor.press("A")
    editor.type(" wo")
    editor.press("<Esc>")
    #expect(editor.mode == .normal)
    #expect(editor.text == "word wo")
  }

  @Test func normalModeKeysNeverReachTheTextView() {
    let editor = VimEditorHarness("one two")
    editor.press("q", "z", "e", "é", "<Tab>", "<F1>")
    #expect(editor.text == "one two")
    #expect(editor.mode == .normal)
    editor.press("q")
    // A key vim doesn't bind types nothing either.
    editor.press("§")
    #expect(editor.text == "one two")
  }

  @Test func insertModeFallsBackToTheTextViewsControlKeys() {
    let editor = VimEditorHarness("first line")
    editor.press("A", "<C-a>")
    #expect(editor.cursor == 0)
    editor.type("X")
    editor.press("<Esc>")
    #expect(editor.text == "Xfirst line")
  }

  @Test func replaceModeOverwrites() {
    let editor = VimEditorHarness("abcd")
    editor.press("R")
    #expect(editor.mode == .replace)
    editor.type("xy")
    editor.press("<Esc>")
    #expect(editor.text == "xycd")
    editor.press("u")
    #expect(editor.text == "abcd")
  }

  @Test func readOnlyEditorsIgnoreVimEdits() {
    let editor = VimEditorHarness("keep", configuration: EditorConfiguration(livePreview: false, isEditable: false, vimMode: true))
    editor.press("d", "d", "x", "i")
    editor.type("zz")
    #expect(editor.text == "keep")
  }
}
