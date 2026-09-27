import Testing

@testable import DailyDoListDrawingCore

@MainActor
@Suite("Shared frames and precision")
struct PrecisionTests {
  @Test func frameMembershipAndUndoPreserveChildren() throws {
    var child = TestScenes.element(.rectangle, id: "shape", x: 30, y: 30, width: 50, height: 30)
    child.setExtraField("futureShapeData", .string("preserved"))
    let editor = DrawingEditor(
      scene: .init(elements: [child]), environment: DeterministicDrawingEnvironment())
    editor.tool = .frame
    editor.pointerDown(at: .zero)
    editor.pointerDragged(to: DrawingPoint(120, 120))
    editor.pointerUp(at: DrawingPoint(120, 120))
    let frame = try #require(editor.selectedIds.first)
    #expect(editor.element(frame)?.type == .frame)
    #expect(editor.element("shape")?.frameId == frame)
    editor.renameFrame(frame, name: "Synthetic frame")
    editor.nudgeSelection(dx: 10, dy: 20)
    #expect(editor.element("shape")?.x == 40)
    #expect(editor.element("shape")?.y == 50)
    editor.removeFrameChildren(frame)
    #expect(editor.element("shape")?.frameId == nil)
    editor.undo()
    #expect(editor.element("shape")?.frameId == frame)
    #expect(editor.element("shape")?.extraField("futureShapeData") == .string("preserved"))
    editor.selectFrameChildren(frame)
    #expect(editor.selectedIds == ["shape"])
    editor.undo()
    editor.undo()
    editor.undo()
    #expect(editor.element(frame)?.isDeleted == true)
    #expect(editor.element("shape")?.frameId == nil)
  }

  @Test func wrapsSelectionAndFrameResizeReleasesOutsideChildren() throws {
    let editor = DrawingEditor(
      scene: .init(elements: [
        TestScenes.element(.rectangle, id: "a", x: 50, y: 50, width: 40, height: 30),
        TestScenes.element(.ellipse, id: "b", x: 150, y: 50, width: 40, height: 30),
      ]), environment: DeterministicDrawingEnvironment())
    editor.selectAll()
    let frame = try #require(editor.frameSelection())
    #expect(editor.element("a")?.frameId == frame && editor.element("b")?.frameId == frame)
    let handle = try #require(editor.selectionFrame?.handles[.e])
    editor.pointerDown(at: handle)
    editor.pointerDragged(to: DrawingPoint(110, handle.y))
    editor.pointerUp(at: DrawingPoint(110, handle.y))
    #expect(editor.element("a")?.frameId == frame)
    #expect(editor.element("b")?.frameId == nil)
    #expect(editor.element("b")?.x == 150)
  }

  @Test func pointInsertionMovementDeletionAreUndoable() throws {
    let line = TestScenes.linear(
      .line, id: "line", x: 10, y: 10, points: [.zero, DrawingPoint(100, 0)])
    let editor = DrawingEditor(
      scene: .init(elements: [line]), environment: DeterministicDrawingEnvironment())
    editor.beginLinearEditing("line")
    editor.insertLinearPoint("line", after: 0)
    #expect(editor.element("line")?.points == [.zero, DrawingPoint(50, 0), DrawingPoint(100, 0)])
    editor.moveLinearPoint("line", index: 1, to: DrawingPoint(60, 50))
    #expect(editor.element("line")?.points[1] == DrawingPoint(50, 40))
    editor.deleteLinearPoint("line", index: 1)
    #expect(editor.element("line")?.points == line.points)
    editor.undo()
    #expect(editor.element("line")?.points.count == 3)
    editor.undo()
    editor.undo()
    #expect(editor.element("line")?.points == line.points)
    #expect(editor.element("line")?.version ?? 0 > line.version)
  }

  @Test func elbowsRemainOrthogonalAfterCreationAndEndpointEdits() throws {
    let editor = DrawingEditor(scene: .init(), environment: DeterministicDrawingEnvironment())
    editor.setArrowShape(.elbow)
    editor.tool = .arrow
    editor.pointerDown(at: DrawingPoint(10, 20))
    editor.pointerDragged(to: DrawingPoint(100, 70))
    editor.pointerDragged(to: DrawingPoint(130, 80))
    editor.pointerUp(at: DrawingPoint(130, 80))
    let id = try #require(editor.selectedIds.first)
    let arrow = try #require(editor.element(id))
    #expect(arrow.elbowed)
    #expect(ArrowBinding.absolutePoint(arrow, arrow.points.count - 1) == DrawingPoint(130, 80))
    editor.moveLinearPoint(id, index: 0, to: DrawingPoint(0, 40))
    let changed = try #require(editor.element(id))
    #expect(
      zip(changed.points, changed.points.dropFirst()).allSatisfy { $0.x == $1.x || $0.y == $1.y })
    editor.setArrowShape(.round)
    #expect(editor.element(id)?.elbowed == false)
    #expect(editor.element(id)?.roundness != nil)
    editor.undo()
    #expect(editor.element(id)?.elbowed == true)
  }

  @Test func objectSnappingAlignsAnEdgeAndGridPreferencesRoundTripUndo() {
    let source = TestScenes.element(.rectangle, id: "source", x: 0, y: 0, width: 20, height: 20)
    let target = TestScenes.element(.rectangle, id: "target", x: 80, y: 50, width: 40, height: 40)
    let editor = DrawingEditor(
      scene: .init(elements: [source, target]), environment: DeterministicDrawingEnvironment())
    editor.objectsSnapEnabled = true
    editor.moveSelection(originals: ["source": source], by: DrawingPoint(57, 0), snapAxis: false)
    #expect(editor.element("source")?.x == 60)
    editor.commit()
    editor.gridSize = 25
    editor.gridEnabled = true
    #expect(editor.scene.appState["gridModeEnabled"] == .bool(true))
    #expect(editor.scene.appState["gridSize"] == .number(25))
    editor.undo()
    #expect(!editor.gridEnabled)
    editor.undo()
    #expect(editor.gridSize == 20)
  }

  @Test func snapsCreationMovementAndCanvasSettingsUndo() throws {
    let editor = DrawingEditor(scene: .init(), environment: DeterministicDrawingEnvironment())
    editor.gridEnabled = true
    editor.tool = .rectangle
    editor.pointerDown(at: DrawingPoint(7, 8))
    editor.pointerDragged(to: DrawingPoint(87, 49))
    editor.pointerUp(at: DrawingPoint(87, 49))
    let id = try #require(editor.selectedIds.first)
    #expect(editor.element(id)?.x == 0 && editor.element(id)?.width == 80)
    #expect(editor.element(id)?.height == 40)
    editor.setCanvasBackground("#ffeedd")
    #expect(editor.scene.viewBackgroundColor == "#ffeedd")
    editor.undo()
    #expect(editor.scene.viewBackgroundColor == "#ffffff")
    editor.redo()
    #expect(editor.scene.viewBackgroundColor == "#ffeedd")
  }
}
