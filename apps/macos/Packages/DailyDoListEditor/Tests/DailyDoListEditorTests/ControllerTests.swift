import AppKit
import Testing

@testable import DailyDoListEditor

@Suite("Controller")
@MainActor
struct ControllerTests {
  @Test func setTextAppliesAMinimalDiffKeepingSelectionAndBadges() {
    let editor = EditorHarness("- [ ] A\n- [ ] B|\n- [ ] C")
    editor.controller.setBadges([EditorBadge(id: "b", line: 1, status: "working", label: "Working")])
    editor.controller.setText("- [ ] New\n- [ ] A\n- [ ] B\n- [ ] C")
    #expect(editor.marked == "- [ ] New\n- [ ] A\n- [ ] B|\n- [ ] C")
    #expect(editor.controller.badges.first?.line == 2)
    editor.controller.setText("- [ ] New\n- [ ] A\n- [ ] B\n- [ ] C edited")
    #expect(editor.marked == "- [ ] New\n- [ ] A\n- [ ] B|\n- [ ] C edited")
    #expect(editor.delegate.textChanges.isEmpty)
  }

  @Test func focusRequestedBeforeTheEditorIsInAWindowTakesEffectOnceItIs() {
    let controller = MarkdownEditorController()
    controller.setText("- [ ] ")
    controller.moveCaretToEnd()
    controller.focus()
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 600, height: 400), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    window.contentView = controller.scrollView
    #expect(window.firstResponder === controller.textView)
    #expect(controller.textView.selectedRange() == NSRange(location: 6, length: 0))
  }

  @Test func aCaretAtALineStartStaysOnItsLineWhenLinesAreInsertedAbove() {
    let editor = EditorHarness("- [ ] A\n|- [ ] B")
    editor.controller.setText("- [ ] A\n- [ ] X\n- [ ] B")
    #expect(editor.marked == "- [ ] A\n- [ ] X\n|- [ ] B")
  }

  @Test func externalChangesAreUndoableButNotReported() {
    let editor = EditorHarness("one|")
    editor.act { editor.controller.setText("one two") }
    #expect(editor.text == "one two")
    #expect(editor.delegate.textChanges.isEmpty)
    editor.undo()
    #expect(editor.text == "one")
    #expect(editor.delegate.textChanges.count == 1)
  }

  @Test func readOnlyExternalChangesClearUndo() {
    let editor = EditorHarness("one|", configuration: EditorConfiguration(isEditable: false))
    editor.controller.setText("two")
    #expect(editor.text == "two")
    #expect(!editor.undoManager.canUndo)
  }

  @Test func resetUndoReplacesTheDocument() {
    let editor = EditorHarness("one|")
    editor.type(" more")
    editor.controller.setBadges([EditorBadge(id: "x", line: 0, status: "done", label: "Done")])
    editor.controller.setText("other note\n- [ ] task", resetUndo: true)
    #expect(editor.marked == "|other note\n- [ ] task")
    #expect(!editor.undoManager.canUndo)
    #expect(editor.controller.badges.isEmpty)
    editor.controller.setText("crlf\r\nline\rend", resetUndo: true)
    #expect(editor.text == "crlf\nline\nend")
  }

  @Test func userChangesAreReportedAndCursorLinesOnlyWhenTheLineChanges() {
    let editor = EditorHarness("a|\nb\nc")
    editor.type("x")
    #expect(editor.delegate.textChanges == ["ax\nb\nc"])
    #expect(editor.delegate.cursorLines.isEmpty)
    editor.select(NSRange(location: 3, length: 0))
    editor.select(NSRange(location: 4, length: 0))
    editor.select(NSRange(location: 6, length: 0))
    #expect(editor.delegate.cursorLines == [1, 2])
  }

  @Test func documentSwitchesAlwaysReportTheCaretLine() {
    let editor = EditorHarness("a|\nb")
    editor.controller.setText("other", resetUndo: true)
    #expect(editor.delegate.cursorLines == [0])
    editor.controller.restore(EditorSnapshot(text: "x\ny\nz", selectedRange: NSRange(location: 4, length: 0)))
    #expect(editor.delegate.cursorLines == [0, 2])
    editor.controller.restore(EditorSnapshot(text: "p\nq\nr", selectedRange: NSRange(location: 4, length: 0)))
    #expect(editor.delegate.cursorLines == [0, 2, 2])
    editor.controller.setText("p\nq\nr!")
    #expect(editor.delegate.cursorLines == [0, 2, 2])
  }

  @Test func snapshotsRestoreTextSelectionAndSeparateUndoHistories() {
    let editor = EditorHarness("note A|")
    editor.type(" edited")
    let a = editor.controller.snapshot()
    #expect(a.selectedRange == NSRange(location: 13, length: 0))

    editor.controller.restore(EditorSnapshot(text: "note B"))
    editor.controller.noteUndoManager.groupsByEvent = false
    #expect(!editor.undoManager.canUndo)
    editor.select(NSRange(location: 6, length: 0))
    editor.type("!")
    let b = editor.controller.snapshot()

    editor.controller.restore(a)
    editor.controller.noteUndoManager.groupsByEvent = false
    #expect(editor.marked == "note A edited|")
    editor.undo()
    #expect(editor.text == "note A")

    editor.controller.restore(b)
    #expect(editor.text == "note B!")
    editor.undo()
    #expect(editor.text == "note B")
  }

  @Test func restoreScrollsToTheSavedOffset() {
    let text = (0..<300).map { "- [ ] line \($0)" }.joined(separator: "\n")
    let editor = EditorHarness(text: text, size: NSSize(width: 800, height: 400))
    editor.controller.scrollToLine(200)
    let snapshot = editor.controller.snapshot()
    #expect(snapshot.scrollOffset.y > 1000)
    editor.controller.restore(EditorSnapshot(text: "short"))
    #expect(editor.controller.scrollView.contentView.bounds.origin.y == 0)
    editor.controller.restore(snapshot)
    #expect(abs(editor.controller.scrollView.contentView.bounds.origin.y - snapshot.scrollOffset.y) < 1)
    #expect(editor.controller.caretLine == 200)
  }

  @Test func scrollToLineMovesTheCaretAndCentersTheLine() {
    let text = (0..<200).map { "line \($0)" }.joined(separator: "\n")
    let editor = EditorHarness(text: text, size: NSSize(width: 800, height: 400))
    editor.controller.scrollToLine(120)
    #expect(editor.controller.caretLine == 120)
    let clip = editor.controller.scrollView.contentView.bounds
    let line = editor.controller.lineRectInTextView(at: editor.selection.location)
    #expect(abs(line.midY - clip.midY) < line.height)
    editor.controller.scrollToLine(10_000)
    #expect(editor.controller.caretLine == 199)
    editor.controller.scrollToLine(-3)
    #expect(editor.controller.caretLine == 0)
  }

  @Test func configurationControlsTheTextViewAndGeometry() {
    let editor = EditorHarness(text: "text", size: NSSize(width: 1400, height: 500))
    let container = editor.controller.textContainer
    #expect(container.size.width == TextGeometry.maxReadableWidth)
    #expect(abs(editor.textView.textContainerInset.width - (editor.textView.bounds.width - 700) / 2) <= 1)
    var configuration = editor.controller.configuration
    configuration.readableLineLength = false
    configuration.spellcheck = true
    configuration.isEditable = false
    configuration.showLineNumbers = true
    editor.controller.configure(configuration)
    #expect(container.size.width > 1000)
    #expect(editor.textView.isContinuousSpellCheckingEnabled)
    #expect(!editor.textView.isEditable)
    #expect(editor.controller.scrollView.rulersVisible)
    #expect(editor.controller.scrollView.verticalRulerView is LineNumberRulerView)
  }

  @Test func geometryCentersAReadableColumnAndReservesBadgeRoom() {
    let wide = TextGeometry.compute(viewWidth: 1200, readable: true, horizontalPadding: 28, topPadding: 20, badgeReserve: 0)
    #expect(wide.columnWidth == 700)
    #expect(wide.inset.width == 250)
    let narrow = TextGeometry.compute(viewWidth: 600, readable: true, horizontalPadding: 28, topPadding: 20, badgeReserve: 0)
    #expect(narrow.columnWidth == 544)
    let reserved = TextGeometry.compute(viewWidth: 600, readable: true, horizontalPadding: 28, topPadding: 20, badgeReserve: 160)
    #expect(reserved.columnWidth == CGFloat(412))
    let full = TextGeometry.compute(viewWidth: 1200, readable: false, horizontalPadding: 28, topPadding: 20, badgeReserve: 160)
    #expect(full.columnWidth == CGFloat(1012))
  }
}
