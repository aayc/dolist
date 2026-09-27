import DailyDoListMobileEditor
import Testing
import UIKit

@MainActor
struct MobileEditorTests {
  @Test func nativeInputContinuesTasksAndPreservesMarkdown() {
    let editor = MobileMarkdownController()
    editor.load("- [ ] Walk 🌿")
    editor.selection = NSRange(location: editor.text.utf16.count, length: 0)
    editor.input.insertText("\n")
    editor.input.insertText("Read")
    #expect(editor.text == "- [ ] Walk 🌿\n- [ ] Read")
    editor.run(.checklist)
    #expect(editor.text == "- [ ] Walk 🌿\n- [x] Read")
  }

  @Test func externalEditsMoveTheSelectionWithoutBecomingLocalTyping() {
    let editor = MobileMarkdownController()
    editor.load("First\nSecond 🌿")
    editor.selection = NSRange(location: 6, length: 6)
    var localEdits = 0
    editor.onTextChange = { _ in localEdits += 1 }
    editor.applyExternalText("Before\nFirst\nSecond 🌿")
    #expect(editor.text == "Before\nFirst\nSecond 🌿")
    #expect(editor.selection == NSRange(location: 13, length: 6))
    #expect(localEdits == 0)
  }

  @Test func formattingIsUndoableInTheHostedTextView() {
    let editor = MobileMarkdownController()
    let host = UIViewController()
    host.view = editor.input
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
    window.rootViewController = host
    window.makeKeyAndVisible()
    defer {
      editor.input.resignFirstResponder()
      window.isHidden = true
    }
    editor.load("Keep these words")
    editor.input.becomeFirstResponder()
    editor.selection = NSRange(location: 5, length: 5)
    editor.run(.bold)
    #expect(editor.text == "Keep **these** words")
    #expect(editor.input.undoManager?.canUndo == true)
    editor.run(.undo)
    #expect(editor.text == "Keep these words")
  }
  @Test func typingInTheMiddleKeepsTheCaretAfterTheInsertion() {
    let editor = MobileMarkdownController()
    editor.load("A **bold** sentence")
    editor.selection = NSRange(location: 3, length: 0)
    editor.input.insertText("x")
    #expect(editor.text == "A *x*bold** sentence")
    #expect(editor.selection == NSRange(location: 4, length: 0))
  }

  @Test func compositionKeepsLocalTextWhileAnExternalLineArrives() {
    let editor = MobileMarkdownController()
    editor.load("Local\nRemote")
    editor.selection = NSRange(location: 5, length: 0)
    editor.input.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
    #expect(editor.input.markedTextRange != nil)
    editor.applyExternalText("Localに\nRemote update")
    editor.input.setMarkedText("日本", selectedRange: NSRange(location: 2, length: 0))
    editor.input.unmarkText()
    #expect(editor.text == "Local日本\nRemote update")
  }

  @Test func emojiKeepsItsGlyphAfterRestylingAnEditedLine() async {
    let editor = MobileMarkdownController()
    editor.input.frame = CGRect(x: 0, y: 0, width: 390, height: 500)
    editor.load("A 🌿 note")
    func emojiImage() -> Data? {
      let layout = editor.input.layoutManager
      layout.ensureLayout(for: editor.input.textContainer)
      let glyphs = layout.glyphRange(
        forCharacterRange: NSRange(location: 2, length: 2), actualCharacterRange: nil)
      let rect = layout.boundingRect(forGlyphRange: glyphs, in: editor.input.textContainer)
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      return UIGraphicsImageRenderer(size: CGSize(width: 40, height: 40), format: format).image {
        _ in
        layout.drawGlyphs(forGlyphRange: glyphs, at: CGPoint(x: 2 - rect.minX, y: 2 - rect.minY))
      }.pngData()
    }
    let before = emojiImage()
    editor.selection = NSRange(location: editor.text.utf16.count, length: 0)
    editor.input.insertText("s")
    await Task.yield()
    #expect(editor.text == "A 🌿 notes")
    #expect(emojiImage() == before)
  }

}
