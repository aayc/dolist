import DailyDoListDrawingModel
import Foundation
import Testing

@testable import DailyDoListDrawing

/// The editor driven with pointer and key sequences, in scene coordinates.
@MainActor
@Suite("Editor interactions")
struct EditorInteractionTests {
  typealias P = DrawingPoint

  func makeEditor(_ elements: [ExcalidrawElement] = []) -> (DrawingEditor, Recorder) {
    let editor = DrawingEditor(
      scene: ExcalidrawScene(elements: elements), environment: DeterministicDrawingEnvironment())
    let recorder = Recorder()
    editor.onChange = { recorder.scenes.append($0) }
    return (editor, recorder)
  }

  final class Recorder {
    var scenes: [ExcalidrawScene] = []
  }

  func drag(
    _ editor: DrawingEditor, from start: P, to end: P, steps: Int = 5,
    modifiers: PointerModifiers = []
  ) {
    editor.pointerDown(at: start, modifiers: modifiers)
    for step in 1...steps {
      let t = Double(step) / Double(steps)
      editor.pointerDragged(to: start + (end - start) * t, modifiers: modifiers)
    }
    editor.pointerUp(at: end, modifiers: modifiers)
  }

  @Test func drawsARectangleAndSelectsIt() throws {
    let (editor, recorder) = makeEditor()
    editor.tool = .rectangle
    drag(editor, from: P(10, 20), to: P(110, 80))
    let element = try #require(editor.scene.elements.first)
    #expect(element.type == .rectangle)
    #expect((element.x, element.y, element.width, element.height) == (10, 20, 100, 60))
    #expect(element.roundness == .adaptive, "round edges by default, like Excalidraw")
    #expect(element.strokeColor == "#1e1e1e" && element.strokeWidth == 2 && element.roughness == 1)
    #expect(element.index == "a0")
    #expect(editor.selectedIds == [element.id])
    #expect(editor.tool == .selection)
    #expect(recorder.scenes.count == 1)
    #expect(element.version > 1, "every change bumps the version")
    #expect(element.updated == 1_700_000_000_000)
  }

  @Test func shiftDrawsSquaresAndOptionDrawsFromTheCenter() throws {
    let (editor, _) = makeEditor()
    editor.tool = .ellipse
    drag(editor, from: P(0, 0), to: P(80, 30), modifiers: .shift)
    let circle = try #require(editor.scene.elements.last)
    #expect(circle.width == 80 && circle.height == 80)
    editor.tool = .diamond
    drag(editor, from: P(200, 200), to: P(240, 220), modifiers: .option)
    let diamond = try #require(editor.scene.elements.last)
    #expect((diamond.x, diamond.y, diamond.width, diamond.height) == (160, 180, 80, 40))
  }

  @Test func aClickWithAShapeToolMakesNothing() {
    let (editor, recorder) = makeEditor()
    editor.tool = .rectangle
    editor.pointerDown(at: P(5, 5))
    editor.pointerUp(at: P(5, 5))
    #expect(editor.scene.elements.isEmpty)
    #expect(recorder.scenes.isEmpty)
  }

  @Test func movesAndResizesWithHandles() throws {
    let (editor, _) = makeEditor()
    editor.tool = .rectangle
    drag(editor, from: P(0, 0), to: P(100, 50))
    let id = try #require(editor.selectedIds.first)
    // Grabbed on its outline, away from the handles.
    drag(editor, from: P(25, 0), to: P(55, 30))
    var element = try #require(editor.element(id))
    #expect((element.x, element.y) == (30, 30))
    // The south-east handle sits 5 units outside the corner (at zoom 1).
    let frame = try #require(editor.selectionFrame)
    let handle = try #require(frame.handles[.se])
    #expect(handle == P(135, 85))
    drag(editor, from: handle, to: handle + P(20, 10))
    element = try #require(editor.element(id))
    #expect((element.x, element.y, element.width, element.height) == (30, 30, 120, 60))
    // Shift keeps the proportions.
    let corner = try #require(editor.selectionFrame?.handles[.se])
    drag(editor, from: corner, to: corner + P(60, 0), modifiers: .shift)
    element = try #require(editor.element(id))
    #expect(abs(element.width / element.height - 2) < 1e-9)
    #expect(element.width == 180)
  }

  @Test func marqueeAndShiftClickSelect() throws {
    let a = TestScenes.element(.rectangle, id: "a", x: 0, y: 0, width: 50, height: 50) {
      $0.backgroundColor = "#ffc9c9"
    }
    let b = TestScenes.element(.rectangle, id: "b", x: 100, y: 0, width: 50, height: 50) {
      $0.backgroundColor = "#ffc9c9"
    }
    let c = TestScenes.element(.rectangle, id: "c", x: 300, y: 0, width: 50, height: 50) {
      $0.backgroundColor = "#ffc9c9"
    }
    let (editor, _) = makeEditor([a, b, c])
    drag(editor, from: P(-30, -30), to: P(160, 60))
    #expect(editor.selectedIds == ["a", "b"])
    editor.pointerDown(at: P(320, 20), modifiers: .shift)
    editor.pointerUp(at: P(320, 20), modifiers: .shift)
    #expect(editor.selectedIds == ["a", "b", "c"])
    editor.pointerDown(at: P(20, 20), modifiers: .shift)
    editor.pointerUp(at: P(20, 20), modifiers: .shift)
    #expect(editor.selectedIds == ["b", "c"])
    editor.pointerDown(at: P(500, 500))
    editor.pointerUp(at: P(500, 500))
    #expect(editor.selectedIds.isEmpty)
  }

  @Test func outlinesAreHitNearTheStrokeAndFillsInside() {
    let hollow = TestScenes.element(.rectangle, id: "h", x: 0, y: 0, width: 100, height: 100)
    let (editor, _) = makeEditor([hollow])
    editor.pointerDown(at: P(50, 50))
    editor.pointerUp(at: P(50, 50))
    #expect(editor.selectedIds.isEmpty, "a transparent shape isn't hit in its middle")
    editor.pointerDown(at: P(2, 50))
    editor.pointerUp(at: P(2, 50))
    #expect(editor.selectedIds == ["h"])
  }

  @Test func drawsABoundArrowThatFollowsTheShapes() throws {
    let left = TestScenes.element(.rectangle, id: "left", x: 0, y: 0, width: 100, height: 100) {
      $0.backgroundColor = "#a5d8ff"
    }
    let right = TestScenes.element(.ellipse, id: "right", x: 300, y: 0, width: 100, height: 100)
    let (editor, _) = makeEditor([left, right])
    editor.tool = .arrow
    drag(editor, from: P(95, 50), to: P(305, 50))
    let arrow = try #require(editor.scene.elements.last)
    #expect(arrow.type == .arrow)
    #expect(arrow.endArrowhead == .arrow)
    #expect(arrow.startBinding?.elementId == "left")
    #expect(arrow.endBinding?.elementId == "right")
    #expect(editor.element("left")?.boundElements == [BoundElement(id: arrow.id, type: "arrow")])
    #expect(editor.element("right")?.boundElements == [BoundElement(id: arrow.id, type: "arrow")])
    // Ends sit on the outlines, a gap away.
    let start = ArrowBinding.absolutePoint(arrow, 0)
    let end = ArrowBinding.absolutePoint(arrow, arrow.points.count - 1)
    #expect(start.x >= 100 && start.x < 112)
    #expect(end.x <= 300 && end.x > 288)

    // Moving the right shape drags the arrow's end along.
    editor.tool = .selection
    editor.pointerDown(at: P(350, 2))
    editor.pointerDragged(to: P(350, 102))
    editor.pointerUp(at: P(350, 102))
    #expect(editor.element("right")?.y == 100)
    let moved = try #require(editor.element(arrow.id))
    let movedEnd = ArrowBinding.absolutePoint(moved, moved.points.count - 1)
    #expect(movedEnd.y > 60, "the end followed the shape down")
    let rightShape = try #require(editor.element("right"))
    #expect(ArrowBinding.distance(to: rightShape, movedEnd) < 16)
    #expect(moved.endBinding?.elementId == "right")
  }

  @Test func arrowsDrawnClickByClick() throws {
    let (editor, _) = makeEditor()
    editor.tool = .line
    editor.pointerDown(at: P(0, 0))
    editor.pointerUp(at: P(0, 0))
    #expect(editor.multiPointElementId != nil)
    editor.pointerMoved(to: P(100, 0))
    editor.pointerDown(at: P(100, 0))
    editor.pointerUp(at: P(100, 0))
    editor.pointerMoved(to: P(100, 80))
    editor.pointerDown(at: P(100, 80), clickCount: 1)
    editor.pointerUp(at: P(100, 80))
    #expect(editor.handleKey(.enter))
    let line = try #require(editor.scene.elements.last)
    #expect(line.points == [P(0, 0), P(100, 0), P(100, 80)])
    #expect(line.width == 100 && line.height == 80)
    #expect(editor.multiPointElementId == nil)
    #expect(editor.selectedIds == [line.id])
  }

  @Test func shiftSnapsLinesTo15DegreeSteps() throws {
    let (editor, _) = makeEditor()
    editor.tool = .line
    drag(editor, from: P(0, 0), to: P(100, 8), modifiers: .shift)
    let line = try #require(editor.scene.elements.last)
    #expect(abs(line.points[1].y) < 1e-9)
  }

  @Test func freehandStrokesKeepEveryPoint() throws {
    let (editor, _) = makeEditor()
    editor.tool = .freedraw
    editor.pointerDown(at: P(10, 10))
    for i in 1...20 { editor.pointerDragged(to: P(10 + Double(i) * 3, 10 + sin(Double(i)) * 5)) }
    editor.pointerUp(at: P(70, 10))
    let stroke = try #require(editor.scene.elements.last)
    #expect(stroke.type == .freedraw)
    #expect(stroke.points.count == 21)
    #expect(stroke.points.first == .zero)
    #expect(stroke.simulatePressure)
    #expect(stroke.lastCommittedPoint == stroke.points.last)
    #expect(editor.tool == .freedraw, "the pen stays in hand, like Excalidraw")
  }

  @Test func addsTextAndLabels() throws {
    let box = TestScenes.element(.rectangle, id: "box", x: 0, y: 0, width: 120, height: 60)
    let (editor, recorder) = makeEditor([box])
    var begun: [String] = []
    editor.onBeginTextEditing = { begun.append($0) }
    editor.tool = .text
    editor.pointerDown(at: P(300, 100))
    let textId = try #require(editor.editingTextId)
    editor.updateEditingText("Hello")
    editor.endTextEditing()
    let text = try #require(editor.element(textId))
    #expect(text.text?.text == "Hello")
    #expect(text.width > 30)
    #expect(recorder.scenes.count == 1)

    // Double-clicking the box adds a centered label.
    editor.pointerDown(at: P(1, 30), clickCount: 2)
    let labelId = try #require(editor.editingTextId)
    editor.updateEditingText("A long label that has to wrap inside the box")
    editor.endTextEditing()
    let label = try #require(editor.element(labelId))
    #expect(label.containerId == "box")
    #expect(label.text?.textAlign == .center && label.text?.verticalAlign == .middle)
    #expect(label.text?.text.contains("\n") == true, "wrapped to the box")
    #expect(editor.element("box")?.boundTextId == labelId)
    #expect(editor.element("box")!.height >= label.height + 10, "the box grew to fit")
    #expect(begun == [textId, labelId])
  }

  @Test func emptyTextIsDiscarded() {
    let (editor, recorder) = makeEditor()
    editor.tool = .text
    editor.pointerDown(at: P(10, 10))
    editor.endTextEditing()
    #expect(editor.scene.elements.isEmpty)
    #expect(recorder.scenes.isEmpty)
  }

  @Test func undoAndRedoRestoreEachStep() throws {
    let (editor, _) = makeEditor()
    editor.tool = .rectangle
    drag(editor, from: P(0, 0), to: P(50, 50))
    let id = try #require(editor.selectedIds.first)
    drag(editor, from: P(12, 0), to: P(112, 0))
    #expect(editor.element(id)?.x == 100)
    #expect(editor.canUndo)
    editor.undo()
    #expect(editor.element(id)?.x == 0)
    let versionAfterUndo = try #require(editor.element(id)?.version)
    editor.undo()
    #expect(editor.element(id)?.isDeleted == true, "undoing a creation leaves a tombstone")
    #expect(editor.scene.visibleElements.isEmpty)
    editor.redo()
    #expect(editor.element(id)?.isDeleted == false)
    editor.redo()
    #expect(editor.element(id)?.x == 100)
    #expect(
      try #require(editor.element(id)?.version) > versionAfterUndo, "undo and redo bump versions")
    #expect(!editor.canRedo)
    #expect(editor.handleKey(.character("z"), modifiers: .command))
    #expect(editor.element(id)?.x == 0)
    #expect(editor.handleKey(.character("z"), modifiers: [.command, .shift]))
    #expect(editor.element(id)?.x == 100)
  }

  @Test func deletesAndDuplicatesWithTheirLabels() throws {
    let box = TestScenes.element(.rectangle, id: "box", x: 0, y: 0, width: 120, height: 60) {
      $0.boundElements = [BoundElement(id: "label", type: "text")]
    }
    let label = TestScenes.text("Hi", id: "label", x: 40, y: 18, container: "box")
    let (editor, _) = makeEditor([box, label])
    editor.select(["box"])
    #expect(editor.handleKey(.character("d"), modifiers: .command))
    #expect(editor.scene.elements.count == 4)
    let copyId = try #require(editor.selectedIds.first)
    let copy = try #require(editor.element(copyId))
    #expect(copy.id != "box" && copy.x == 10 && copy.y == 10)
    #expect(copy.seed != box.seed)
    let copiedLabelId = try #require(copy.boundTextId)
    let copiedLabel = try #require(editor.element(copiedLabelId))
    #expect(copiedLabel.containerId == copyId && copiedLabel.x == 50)
    #expect(editor.handleKey(.delete))
    #expect(editor.element(copyId)?.isDeleted == true)
    #expect(editor.element(copiedLabel.id)?.isDeleted == true)
    #expect(editor.scene.visibleElements.count == 2)
  }

  @Test func toolShortcutsMatchExcalidraw() {
    let (editor, _) = makeEditor()
    let expected: [(Character, DrawingTool)] = [
      ("r", .rectangle), ("2", .rectangle), ("d", .diamond), ("3", .diamond), ("o", .ellipse),
      ("4", .ellipse), ("a", .arrow), ("5", .arrow), ("l", .line), ("6", .line), ("p", .freedraw),
      ("x", .freedraw), ("7", .freedraw), ("t", .text), ("8", .text), ("e", .eraser),
      ("0", .eraser),
      ("h", .hand), ("v", .selection), ("1", .selection), ("R", .rectangle),
    ]
    for (key, tool) in expected {
      #expect(editor.handleKey(.character(key)))
      #expect(editor.tool == tool, "\(key)")
    }
    #expect(editor.handleKey(.character("q")))
    #expect(editor.isToolLocked)
    #expect(!editor.handleKey(.character("k")))
  }

  @Test func theEraserRemovesWhatItTouches() {
    let a = TestScenes.element(.rectangle, id: "a", x: 0, y: 0, width: 50, height: 50)
    let b = TestScenes.element(.rectangle, id: "b", x: 100, y: 0, width: 50, height: 50)
    let (editor, _) = makeEditor([a, b])
    editor.tool = .eraser
    editor.pointerDown(at: P(-20, 25))
    editor.pointerDragged(to: P(10, 25))
    #expect(editor.erasingIds == ["a"])
    editor.pointerUp(at: P(10, 25))
    #expect(editor.element("a")?.isDeleted == true)
    #expect(editor.element("b")?.isDeleted == false)
  }

  @Test func stylesApplyToTheSelectionAndNewElements() throws {
    let (editor, _) = makeEditor()
    editor.tool = .rectangle
    drag(editor, from: P(0, 0), to: P(50, 50))
    let id = try #require(editor.selectedIds.first)
    editor.applyStyle {
      $0.strokeColor = "#e03131"
      $0.backgroundColor = "#ffc9c9"
      $0.fillStyle = .hachure
      $0.strokeWidth = 4
      $0.strokeStyle = .dashed
      $0.roughness = 2
      $0.opacity = 60
    }
    let element = try #require(editor.element(id))
    #expect(element.strokeColor == "#e03131" && element.backgroundColor == "#ffc9c9")
    #expect(
      element.fillStyle == .hachure && element.strokeWidth == 4 && element.strokeStyle == .dashed)
    #expect(element.roughness == 2 && element.opacity == 60)
    editor.clearSelection()
    editor.tool = .ellipse
    drag(editor, from: P(100, 0), to: P(150, 50))
    let ellipse = try #require(editor.scene.elements.last)
    #expect(ellipse.strokeColor == "#e03131" && ellipse.strokeWidth == 4)
  }

  @Test func escapeLeavesToolsThenSelection() {
    let (editor, _) = makeEditor([TestScenes.element(.rectangle, id: "a", x: 0, y: 0)])
    editor.select(["a"])
    editor.tool = .selection
    #expect(editor.handleKey(.escape))
    #expect(editor.selectedIds.isEmpty)
    #expect(!editor.handleKey(.escape), "nothing left: the host ends editing")
    editor.tool = .rectangle
    #expect(editor.handleKey(.escape))
    #expect(editor.tool == .selection)
  }
}
