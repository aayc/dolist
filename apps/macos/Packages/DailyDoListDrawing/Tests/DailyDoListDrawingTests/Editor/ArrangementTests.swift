import Foundation
import Testing

@testable import DailyDoListDrawingCore

@MainActor
@Suite("Shared drawing arrangement")
struct ArrangementTests {
  private func editor() -> DrawingEditor {
    DrawingEditor(
      scene: ExcalidrawScene(elements: [
        TestScenes.element(.rectangle, id: "a", x: 0, y: 0, width: 20, height: 10),
        TestScenes.element(.ellipse, id: "b", x: 50, y: 25, width: 30, height: 20),
        TestScenes.element(.diamond, id: "c", x: 160, y: 90, width: 40, height: 30),
      ]), environment: DeterministicDrawingEnvironment())
  }

  @Test(arguments: [DrawingLayer.back, .backward, .forward, .front])
  func layersKeepFractionalOrderAndUndo(_ layer: DrawingLayer) throws {
    let editor = editor()
    editor.select(["b"])
    editor.moveSelection(to: layer)
    let ids = editor.scene.elements.map(\.id)
    #expect(ids == (layer == .back || layer == .backward ? ["b", "a", "c"] : ["a", "c", "b"]))
    let keys = try editor.scene.elements.map { try #require($0.index) }
    #expect(keys == keys.sorted())
    editor.undo()
    #expect(editor.scene.elements.map(\.id) == ["a", "b", "c"])
    editor.redo()
    #expect(editor.scene.elements.map(\.id) == ids)
  }

  @Test func groupsMoveAsUnitsAndLockCanBeUndone() throws {
    let editor = editor()
    editor.select(["a", "b"])
    editor.groupSelection()
    let group = try #require(editor.element("a")?.groupIds.last)
    #expect(editor.element("b")?.groupIds.last == group)
    editor.select(["a"])
    #expect(editor.selectedIds == ["a", "b"])
    editor.selectAll()
    editor.alignSelection(.bottom)
    #expect(editor.element("a")?.y == 75)
    #expect(editor.element("b")?.y == 100)
    editor.lockSelection()
    #expect(editor.selectedIds.isEmpty)
    #expect(editor.scene.visibleElements.allSatisfy { $0.locked })
    editor.undo()
    #expect(editor.scene.visibleElements.allSatisfy { !$0.locked })
    editor.select(["a"])
    editor.ungroupSelection()
    #expect(editor.element("a")?.groupIds.isEmpty == true)
    #expect(editor.element("b")?.groupIds.isEmpty == true)
  }

  @Test func distributionUsesEqualGapsAndPreservesOuterEdges() {
    let editor = editor()
    editor.selectAll()
    editor.distributeSelection(horizontally: true)
    #expect(editor.element("a")?.x == 0)
    #expect(editor.element("b")?.x == 75)
    #expect(editor.element("c")?.x == 160)
    editor.undo()
    #expect(editor.element("b")?.x == 50)
  }

  @Test func rotationAndFlipRetainUnknownFieldsAndUndo() throws {
    var element = TestScenes.linear(
      .line, id: "path", x: 10, y: 20,
      points: [.zero, DrawingPoint(30, 10), DrawingPoint(80, 5)])
    element.setExtraField("syntheticPluginData", .object(JSONObject([("kept", .bool(true))])))
    let editor = DrawingEditor(
      scene: ExcalidrawScene(elements: [element]), environment: DeterministicDrawingEnvironment())
    editor.select(["path"])
    editor.rotateSelection(by: .pi / 2)
    #expect(abs((editor.element("path")?.angle ?? 0) - .pi / 2) < 1e-9)
    editor.flipSelection(horizontally: true)
    editor.flipSelection(horizontally: true)
    let flippedTwice = try #require(editor.element("path"))
    #expect(flippedTwice.points == element.points)
    #expect(
      flippedTwice.extraField("syntheticPluginData") == element.extraField("syntheticPluginData"))
    editor.undo()
    editor.undo()
    editor.undo()
    let restored = try #require(editor.element("path"))
    #expect(restored.x == element.x && restored.y == element.y && restored.angle == element.angle)
    #expect(restored.points == element.points)
    #expect(restored.version > element.version)
  }
}
