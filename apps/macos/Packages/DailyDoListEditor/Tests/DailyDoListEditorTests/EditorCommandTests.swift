import AppKit
import Testing

@testable import DailyDoListEditor

/// Commands driven through the offscreen editor: keys go through the text view's action methods,
/// shortcuts through synthesized key events.
@Suite("Editor commands")
@MainActor
struct EditorCommandTests {
  private func keyEvent(_ characters: String, keyCode: UInt16 = 0, modifiers: NSEvent.ModifierFlags = .command) -> NSEvent {
    NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0, windowNumber: 0, context: nil,
      characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode)!
  }

  @Test func typingATaskFromScratchProducesExactlyThat() {
    let editor = EditorHarness("|")
    editor.type("- [ ] ")
    #expect(editor.text == "- [ ] ")
    editor.type("(x) [y] {z} \"q\" 'a' -- ...")
    #expect(editor.text == "- [ ] (x) [y] {z} \"q\" 'a' -- ...")
  }

  @Test func enterContinuesListsAndEndsThemLikeObsidian() {
    let editor = EditorHarness("- [ ] first|")
    editor.enter()
    #expect(editor.marked == "- [ ] first\n- [ ] |")
    editor.type("second")
    editor.enter()
    editor.enter()
    #expect(editor.marked == "- [ ] first\n- [ ] second\n|")
    editor.type("1. one")
    editor.enter()
    #expect(editor.marked == "- [ ] first\n- [ ] second\n1. one\n2. |")
  }

  @Test func enterInsideAQuoteAndPlainNewlinesElsewhere() {
    let editor = EditorHarness("> quoted|")
    editor.enter()
    #expect(editor.marked == "> quoted\n> |")
    let plain = EditorHarness("plain|")
    plain.enter()
    #expect(plain.marked == "plain\n|")
    let code = EditorHarness("```\n- a|\n```")
    code.enter()
    #expect(code.marked == "```\n- a\n|\n```")
  }

  @Test func tabIndentsListItemsAndInsertsTabsElsewhere() {
    let editor = EditorHarness("- a\n- b|")
    editor.tab()
    #expect(editor.marked == "- a\n\t- b|")
    editor.backtab()
    #expect(editor.marked == "- a\n- b|")
    let plain = EditorHarness("a|b")
    plain.tab()
    #expect(plain.marked == "a\t|b")
  }

  @Test func backspaceRemovesTheWholeTaskPrefix() {
    let editor = EditorHarness("- [ ] |text")
    editor.backspace()
    #expect(editor.marked == "|text")
    editor.backspace()
    #expect(editor.marked == "|text")
  }

  @Test func shortcutsCycleTasksAndToggleFormatting() {
    let editor = EditorHarness("buy |milk")
    let hooks = editor.controller
    editor.act { _ = hooks.performShortcut(keyEvent("l")) }
    #expect(editor.marked == "- [ ] buy |milk")
    editor.act { _ = hooks.performShortcut(keyEvent("\r", keyCode: 36)) }
    #expect(editor.marked == "- [x] buy |milk")
    editor.act { _ = hooks.performShortcut(keyEvent("l")) }
    #expect(editor.marked == "- [ ] buy |milk")
    editor.act { _ = hooks.performShortcut(keyEvent("b")) }
    #expect(editor.marked == "- [ ] buy **|milk**")
    editor.act { _ = hooks.performShortcut(keyEvent("i")) }
    #expect(editor.marked == "- [ ] buy ***|milk***")
    editor.act { _ = hooks.performShortcut(keyEvent("k")) }
    #expect(editor.text.contains("[]()"))
    #expect(hooks.performShortcut(keyEvent("s")))
    #expect(editor.delegate.saves == 1)
    #expect(!hooks.performShortcut(keyEvent("e")))
    #expect(!hooks.performShortcut(keyEvent("b", modifiers: [.command, .shift])))
  }

  @Test func eachCommandIsOneUndoStepAndUndoRestoresTheText() {
    let editor = EditorHarness("- [ ] a|")
    editor.enter()
    editor.type("b")
    editor.command { $0.toggleChecklist() }
    #expect(editor.text == "- [ ] a\n- [x] b")
    editor.undo()
    #expect(editor.text == "- [ ] a\n- [ ] b")
    editor.undo()
    #expect(editor.text == "- [ ] a\n- [ ] ")
    editor.undo()
    #expect(editor.text == "- [ ] a")
    editor.redo()
    #expect(editor.text == "- [ ] a\n- [ ] ")
  }

  @Test func formattingSelectionAndUndo() {
    let editor = EditorHarness("a «word» b")
    editor.command { $0.toggleBold() }
    #expect(editor.marked == "a **«word»** b")
    editor.command { $0.toggleBold() }
    #expect(editor.marked == "a «word» b")
    editor.command { $0.toggleInlineCode() }
    #expect(editor.marked == "a `«word»` b")
    editor.undo()
    #expect(editor.text == "a word b")
  }

  @Test func readOnlyEditorsIgnoreCommands() {
    let editor = EditorHarness("- [ ] a|", configuration: EditorConfiguration(isEditable: false))
    #expect(!editor.controller.toggleChecklist())
    #expect(!editor.controller.toggleBold())
    #expect(!editor.controller.toggleTask(atLine: 0))
    #expect(!editor.controller.textViewHandleNewline(editor.textView))
    #expect(editor.text == "- [ ] a")
  }

  @Test func toggleTaskAtLine() {
    let editor = EditorHarness("- [ ] a\nplain\n- [x] b|")
    editor.command { #expect($0.toggleTask(atLine: 0)) }
    editor.command { #expect($0.toggleTask(atLine: 2)) }
    #expect(!editor.controller.toggleTask(atLine: 1))
    #expect(!editor.controller.toggleTask(atLine: 7))
    #expect(!editor.controller.toggleTask(atLine: -1))
    #expect(editor.text == "- [x] a\nplain\n- [ ] b")
    #expect(editor.delegate.textChanges.count == 2)
  }
}
