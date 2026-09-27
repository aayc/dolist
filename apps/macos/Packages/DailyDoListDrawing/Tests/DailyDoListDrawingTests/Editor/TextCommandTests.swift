import Testing

@testable import DailyDoListDrawingCore

@MainActor
@Suite("Text binding commands")
struct TextCommandTests {
  @Test func bindAlignUnbindAndWrapPreserveWordsAndUndo() throws {
    var text = TestScenes.element(.text, id: "text", x: 20, y: 20, width: 80, height: 25)
    text.text = .init(text: "Synthetic words")
    let shape = TestScenes.element(.rectangle, id: "shape", x: 0, y: 0, width: 150, height: 120)
    let editor = DrawingEditor(
      scene: .init(elements: [shape, text]), environment: DeterministicDrawingEnvironment())
    editor.select(["shape", "text"])
    #expect(editor.bindSelectedText())
    #expect(editor.element("text")?.containerId == "shape")
    #expect(editor.element("shape")?.boundTextId == "text")
    editor.setTextVerticalAlignment(.bottom)
    let bottom = try #require(editor.element("text"))
    #expect(bottom.y > 60)
    #expect(bottom.text?.originalText == "Synthetic words")
    editor.unbindSelectedText()
    #expect(editor.element("text")?.containerId == nil)
    #expect(editor.element("shape")?.boundTextId == nil)
    editor.select(["text"])
    editor.wrapSelectedText()
    let wrapped = try #require(editor.element("text")?.containerId)
    #expect(wrapped != "shape")
    #expect(editor.element(wrapped)?.boundTextId == "text")
    #expect(
      editor.scene.visibleElements.firstIndex { $0.id == wrapped }! < editor.scene.visibleElements
        .firstIndex { $0.id == "text" }!)
    editor.undo()
    #expect(editor.element(wrapped)?.isDeleted == true)
    #expect(editor.element("text")?.containerId == nil)
    #expect(editor.element("text")?.text?.originalText == "Synthetic words")
  }

  @Test func autoWidthRestoresOriginalTextAfterWrapping() throws {
    var text = TestScenes.element(.text, id: "text", x: 20, y: 20, width: 50, height: 25)
    text.text = .init(text: "A long synthetic sentence that wraps")
    let editor = DrawingEditor(
      scene: .init(elements: [text]), environment: DeterministicDrawingEnvironment())
    editor.select(["text"])
    editor.setTextAutoResize(false)
    #expect(editor.element("text")?.text?.text.contains("\n") == true)
    #expect(editor.element("text")?.width == 50)
    editor.setTextAutoResize(true)
    #expect(editor.element("text")?.text?.text == text.text?.originalText)
    #expect(editor.element("text")!.width > 50)
    editor.undo()
    #expect(editor.element("text")?.text?.autoResize == false)
  }
}
