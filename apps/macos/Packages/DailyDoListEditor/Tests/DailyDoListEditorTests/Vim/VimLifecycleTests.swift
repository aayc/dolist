import AppKit
import DailyDoListVim
import Testing

@testable import DailyDoListEditor

/// Vim alongside the rest of the editor: mouse selections, paste, shortcuts, note switches,
/// turning vim on and off, badges.
@MainActor
@Suite("Vim lifecycle")
struct VimLifecycleTests {
  @Test func aMouseSelectionEntersVisualModeAndAClickLeavesIt() {
    let editor = VimEditorHarness("one two three")
    editor.textView.setSelectedRanges(
      [NSValue(range: NSRange(location: 4, length: 3))], affinity: .downstream, stillSelecting: true
    )
    #expect(editor.mode == .normal)
    editor.textView.setSelectedRanges(
      [NSValue(range: NSRange(location: 4, length: 3))], affinity: .downstream,
      stillSelecting: false)
    #expect(editor.mode == .visual)
    editor.press("d")
    #expect(editor.text == "one  three")
    editor.textView.setSelectedRange(NSRange(location: 6, length: 0))
    #expect(editor.mode == .normal)
    #expect(editor.cursor == 6)
  }

  @Test func aSelectionDraggedBackwardKeepsItsHeadAtTheStart() {
    let editor = VimEditorHarness("one two three")
    editor.textView.setSelectedRange(NSRange(location: 7, length: 0))
    editor.textView.setSelectedRanges(
      [NSValue(range: NSRange(location: 4, length: 3))], affinity: .downstream,
      stillSelecting: false)
    #expect(editor.host.selection.main == VimSelection.Range(anchor: 7, head: 4))
  }

  @Test func pastingInNormalModeInsertsAfterTheCursorAndEntersInsertMode() {
    let editor = VimEditorHarness("ab")
    let pasteboard = NSPasteboard.general
    let saved = pasteboard.string(forType: .string)
    defer {
      pasteboard.clearContents()
      if let saved { pasteboard.setString(saved, forType: .string) }
    }
    pasteboard.clearContents()
    pasteboard.setString("XY", forType: .string)
    editor.textView.paste(nil)
    #expect(editor.text == "aXYb")
    #expect(editor.mode == .insert)
    editor.press("<Esc>")
    #expect(editor.session?.vim.register(".").text.string == "XY")
  }

  @Test func commandShortcutsKeepWorkingInNormalMode() {
    let editor = VimEditorHarness("word")
    let event = VimEditorHarness.event(for: "<D-b>", window: editor.window)
    #expect(editor.textView.performKeyEquivalent(with: event))
    #expect(editor.text == "**word**")
    // …and as a vim command: one undo step.
    editor.press("u")
    #expect(editor.text == "word")
  }

  @Test func vimClaimsItsControlKeysOutsideInsertMode() {
    let editor = VimEditorHarness((0..<80).map { "line \($0)" }.joined(separator: "\n"))
    let ctrlD = VimEditorHarness.event(for: "<C-d>", window: editor.window)
    #expect(editor.host.claimsKeyEquivalent(ctrlD))
    #expect(editor.textView.performKeyEquivalent(with: ctrlD))
    #expect(editor.host.vimLineNumber(at: editor.cursor) > 0)
    let ctrlS = VimEditorHarness.event(for: "<C-s>", window: editor.window)
    #expect(!editor.host.claimsKeyEquivalent(ctrlS))
    let commandO = VimEditorHarness.event(for: "<D-o>", window: editor.window)
    #expect(!editor.host.claimsKeyEquivalent(commandO))
    editor.press("i")
    #expect(!editor.host.claimsKeyEquivalent(ctrlD))
    editor.press("<Esc>", ":")
    #expect(
      editor.host.claimsKeyEquivalent(VimEditorHarness.event(for: "<C-u>", window: editor.window)))
  }

  @Test func switchingNotesStartsVimOverButKeepsRegisters() {
    let editor = VimEditorHarness("note A line one\nline two")
    editor.press("j", "m", "a", "y", "y", "v", "l")
    #expect(editor.mode == .visual)
    let a = editor.controller.snapshot()
    editor.controller.restore(EditorSnapshot(text: "note B\nsecond\nthird"))
    #expect(editor.mode == .normal)
    #expect(editor.session?.pendingKeys == "")
    // Mark `a` belonged to note A.
    editor.press("'", "a")
    #expect(editor.cursor == 0)
    // Registers are global: the line yanked in A pastes in B.
    editor.press("p")
    #expect(editor.text == "note B\nline two\nsecond\nthird")
    editor.press("d", "<Esc>")
    editor.controller.restore(a)
    #expect(editor.mode == .normal)
    #expect(editor.session?.pendingKeys == "")
    editor.press("u")
    #expect(editor.text == "note A line one\nline two")
  }

  @Test func aCommandThatSwitchesNotesFinishesInTheOldSessionFirst() {
    let editor = VimEditorHarness("first note")
    final class Switcher: MarkdownEditorDelegate {
      weak var controller: MarkdownEditorController?
      func editor(_ editor: MarkdownEditorController, perform request: EditorVimRequest)
        -> EditorVimRequestResult
      {
        controller?.restore(EditorSnapshot(text: "second note"))
        return .done
      }
    }
    let switcher = Switcher()
    switcher.controller = editor.controller
    editor.controller.delegate = switcher
    editor.press(":")
    editor.type("tabnext")
    editor.press("<CR>")
    #expect(editor.text == "second note")
    #expect(editor.host.panelView == nil)
    #expect(editor.mode == .normal)
    editor.press("x")
    #expect(editor.text == "econd note")
    editor.press("g", "t")
    #expect(editor.text == "second note")
  }

  @Test func turningVimOffAndOnMidEdit() {
    let editor = VimEditorHarness("one")
    editor.press("A")
    editor.type(" two")
    editor.controller.configure(EditorConfiguration(livePreview: false, vimMode: false))
    #expect(editor.session == nil)
    #expect(editor.textView.shouldDrawInsertionPoint || editor.textView.window != nil)
    // Without vim, keys are the text view's.
    editor.act { editor.type(" three") }
    #expect(editor.text == "one two three")
    editor.undoManager.undo()
    #expect(editor.text == "one two")
    editor.undoManager.undo()
    #expect(editor.text == "one")
    editor.undoManager.redo()
    #expect(editor.text == "one two")
    editor.controller.configure(EditorConfiguration(livePreview: false, vimMode: true))
    #expect(editor.mode == .normal)
    editor.press("u")
    #expect(editor.text == "one")
    // `u` leaves the cursor where the undone text started (clipped to the last character).
    editor.press("x")
    #expect(editor.text == "on")
  }

  @Test func badgesFollowTheirTaskThroughDdAndU() {
    let editor = VimEditorHarness("Tasks\n- [ ] Book flights\n- [ ] Pay rent")
    editor.controller.setBadges([EditorBadge(id: "b", line: 2, status: "working", label: "Working")]
    )
    editor.press("j", "d", "d")
    #expect(editor.controller.badges.first?.line == 1)
    editor.press("u")
    #expect(editor.text == "Tasks\n- [ ] Book flights\n- [ ] Pay rent")
    #expect(editor.controller.badges.first?.line == 2)
    // The deleted task's own badge went with its line; the host sets badges again from its
    // records (as the app does after every edit).
    editor.controller.setBadges([
      EditorBadge(id: "a", line: 1, status: "done", label: "Done"),
      EditorBadge(id: "b", line: 2, status: "working", label: "Working"),
    ])
    editor.press("d", "d")
    #expect(editor.controller.badges.map(\.id) == ["b"])
    editor.press("u")
    editor.controller.setBadges([
      EditorBadge(id: "a", line: 1, status: "done", label: "Done"),
      EditorBadge(id: "b", line: 2, status: "working", label: "Working"),
    ])
    #expect(editor.controller.badges.map(\.line) == [1, 2])
  }

  @Test func vimEditsAreUserEditsForTheHost() {
    let editor = VimEditorHarness("abc")
    editor.press("x")
    #expect(editor.delegate.textChanges == 1)
    editor.press(":")
    editor.type("w")
    editor.press("<CR>")
    #expect(editor.delegate.saves == 1)
  }
}
