import Testing

@testable import DailyDoListDrawingCore

@MainActor
@Suite("Elbow routing and fixed segments")
struct ElbowTests {
  @Test func visibilityRouteAvoidsEndpointBoxesAndIsOrthogonal() throws {
    let box = DrawingRect(x: 20, y: -10, width: 40, height: 20)
    let route = try #require(
      OrthogonalRouter.route(from: .zero, to: DrawingPoint(100, 0), avoiding: [box]))
    #expect(route.first == .zero && route.last == DrawingPoint(100, 0))
    #expect(route.count >= 4)
    for pair in zip(route, route.dropFirst()) {
      #expect(pair.0.x == pair.1.x || pair.0.y == pair.1.y)
      let middle = (pair.0 + pair.1) * 0.5
      #expect(
        !(middle.x > box.minX && middle.x < box.maxX && middle.y > box.minY && middle.y < box.maxY))
    }
  }

  @Test func fixedSegmentCoordinatesSurviveRerouteAndUndo() throws {
    var arrow = TestScenes.linear(
      .arrow, id: "arrow", x: 10, y: 20,
      points: [.zero, DrawingPoint(40, 0), DrawingPoint(40, 60), DrawingPoint(100, 60)])
    arrow.elbowed = true
    let editor = DrawingEditor(
      scene: .init(elements: [arrow]), environment: DeterministicDrawingEnvironment())
    editor.select(["arrow"])
    editor.setElbowSegmentFixed("arrow", index: 2, fixed: true)
    let before = try #require(
      editor.element("arrow")?.extraField("fixedSegments")?.arrayValue?.first?.objectValue)
    editor.moveLinearPoint("arrow", index: 3, to: DrawingPoint(150, 100))
    editor.rerouteElbow("arrow")
    let after = try #require(
      editor.element("arrow")?.extraField("fixedSegments")?.arrayValue?.first?.objectValue)
    #expect(after["start"] == before["start"] && after["end"] == before["end"])
    let value = try #require(editor.element("arrow"))
    #expect(value.points.last == DrawingPoint(140, 80))
    for pair in zip(value.points, value.points.dropFirst()) {
      #expect(pair.0.x == pair.1.x || pair.0.y == pair.1.y)
    }
    let index = try #require(after["index"]?.numberValue)
    editor.setElbowSegmentFixed("arrow", index: Int(index), fixed: false)
    #expect(editor.element("arrow")?.extraField("fixedSegments")?.arrayValue?.isEmpty == true)
    editor.undo()
    #expect(editor.element("arrow")?.extraField("fixedSegments")?.arrayValue?.count == 1)
  }

  @Test func nativeElbowBindingsRecordNormalizedFixedPoints() throws {
    let shape = TestScenes.element(.rectangle, id: "shape", x: 0, y: 0, width: 100, height: 80)
    var arrow = TestScenes.linear(
      .arrow, id: "arrow", x: 100, y: 40, points: [.zero, DrawingPoint(100, 0)])
    arrow.elbowed = true
    let binding = ArrowBinding.binding(for: arrow, end: .start, to: shape)
    #expect(binding.extra["fixedPoint"] == .array([.number(1), .number(0.5)]))
  }
  @Test func draggingMidpointFixesSegmentWithoutMovingEndpoints() throws {
    var arrow = TestScenes.linear(
      .arrow, id: "arrow", x: 10, y: 20,
      points: [.zero, DrawingPoint(40, 0), DrawingPoint(40, 60), DrawingPoint(100, 60)])
    arrow.elbowed = true
    let editor = DrawingEditor(
      scene: .init(elements: [arrow]), environment: DeterministicDrawingEnvironment())
    editor.beginLinearEditing("arrow")
    let handle = editor.linearMidpoints[1]
    editor.pointerDown(at: handle)
    editor.pointerDragged(to: handle + DrawingPoint(20, 0))
    editor.pointerUp(at: handle + DrawingPoint(20, 0))
    let value = try #require(editor.element("arrow"))
    #expect(value.points.first == arrow.points.first && value.points.last == arrow.points.last)
    let fixed = try #require(value.extraField("fixedSegments")?.arrayValue?.first?.objectValue)
    #expect(fixed["start"] == .array([.number(60), .number(0)]))
    #expect(fixed["end"] == .array([.number(60), .number(60)]))
    editor.undo()
    #expect(editor.element("arrow")?.points == arrow.points && !editor.canUndo)
  }

}
