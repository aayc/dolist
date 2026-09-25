import DailyDoListDrawingModel
import Foundation
import Testing

@Suite("Scene codec")
struct SceneCodecTests {
  static func pluginScene() throws -> ExcalidrawScene {
    try SceneCodec.decode(Fixtures.text("scene-plugin.excalidraw"))
  }

  @Test func readsEveryElementType() throws {
    let scene = try Self.pluginScene()
    #expect(scene.elements.count == 12)
    let byId = Dictionary(uniqueKeysWithValues: scene.elements.map { ($0.id, $0) })
    let rectangle = try #require(byId["Rc1a2b3c"])
    #expect(rectangle.type == .rectangle)
    #expect(rectangle.roundness == .adaptive)
    #expect(rectangle.fillStyle == .hachure)
    #expect(rectangle.boundTextId == "Tx1a2b3c")
    #expect(rectangle.extraField("customData")?.objectValue?["note"] == .string("synthetic"))

    let label = try #require(byId["Tx1a2b3c"]?.text)
    #expect(label.containerId == "Rc1a2b3c")
    #expect(label.verticalAlign == .middle)
    #expect(byId["Tx1a2b3c"]?.extraField("rawText") == .string("Plan"))

    let arrow = try #require(byId["Ar1a2b3c"])
    #expect(arrow.points == [DrawingPoint(0, 0), DrawingPoint(170, -5.5)])
    #expect(arrow.startBinding?.elementId == "Rc1a2b3c")
    #expect(arrow.endBinding?.gap == 4.5)
    #expect(arrow.endArrowhead == .arrow)
    #expect(arrow.startArrowhead == nil)

    let freedraw = try #require(byId["Fd1a2b3c"])
    #expect(freedraw.points.count == 9)
    #expect(freedraw.simulatePressure)
    #expect(freedraw.lastCommittedPoint == DrawingPoint(90, 40))

    #expect(byId["Im1a2b3c"]?.fileId == "0123456789abcdef0123456789abcdef01234567")
    #expect(byId["Fr1a2b3c"]?.name == "Group A")
    let sticker = try #require(byId["St1a2b3c"])
    #expect(sticker.type.rawValue == "sticker")
    #expect(!sticker.type.isSupported)
    #expect(byId["Gn1a2b3c"]?.isDeleted == true)
    #expect(scene.visibleElements.count == 11)
    #expect(scene.viewBackgroundColor == "#ffffff")
  }

  @Test func roundTripsUnknownTypesAndFieldsByteForByte() throws {
    let text = try Fixtures.text("scene-plugin.excalidraw")
    let scene = try SceneCodec.decode(text)
    #expect(SceneCodec.encode(scene) == text)
  }

  @Test func changedFieldsAreWrittenInPlaceAndUnknownOnesKept() throws {
    var scene = try Self.pluginScene()
    let index = try #require(scene.elements.firstIndex { $0.id == "St1a2b3c" })
    scene.elements[index].x = 612.5
    let rectangle = try #require(scene.elements.firstIndex { $0.id == "Rc1a2b3c" })
    scene.elements[rectangle].strokeColor = "#2f9e44"
    let object = SceneCodec.encodeObject(scene)
    let elements = try #require(object["elements"]?.arrayValue)
    let sticker = try #require(elements[index].objectValue)
    #expect(sticker["x"] == .number(612.5))
    #expect(sticker["sticker"]?.objectValue?["emoji"] == .string("⭐"))
    #expect(
      sticker["futureField"]
        == .array([.number(1), .number(2.5), .string("x"), .null, .bool(true)]))
    let rect = try #require(elements[rectangle].objectValue)
    #expect(rect.keys.firstIndex(of: "strokeColor") == 7)
    #expect(rect["strokeColor"] == .string("#2f9e44"))
    #expect(rect.keys.last == "customData")
    #expect(object["futureTopLevel"] != nil)
    #expect(object["appState"]?.objectValue?["futureAppStateKey"] == .bool(true))
  }

  @Test func absentFieldsStayAbsentUntilTheyChange() throws {
    let text =
      #"{"type":"excalidraw","version":2,"elements":[{"id":"a","type":"arrow","x":1,"y":2,"points":[[0,0],[10,10]]}],"appState":{}}"#
    var scene = try SceneCodec.decode(text)
    #expect(scene.elements[0].endArrowhead == .arrow, "old arrows end in an arrowhead")
    #expect(scene.elements[0].strokeColor == "#1e1e1e")
    #expect(SceneCodec.encode(scene, indent: "") == text)
    scene.elements[0].strokeWidth = 4
    let written = try #require(
      SceneCodec.encodeObject(scene)["elements"]?.arrayValue?.first?.objectValue)
    #expect(written["strokeWidth"] == .number(4))
    #expect(written["strokeColor"] == nil)
    #expect(written["files"] == nil)
  }

  @Test func unreadableValuesOfKnownFieldsSurvive() throws {
    let text =
      #"{"type":"excalidraw","version":2,"elements":[{"id":"r","type":"rectangle","seed":1.5,"roundness":"round","groupIds":[1]},"not an element"],"appState":{},"files":{}}"#
    let scene = try SceneCodec.decode(text)
    #expect(scene.elements.count == 1)
    #expect(scene.elements[0].seed == 1)
    #expect(scene.elements[0].roundness == nil)
    #expect(SceneCodec.encode(scene, indent: "") == text)
  }

  @Test func newElementsUseExcalidrawsFieldOrder() {
    var element = ExcalidrawElement(id: "n1", type: .text)
    element.text = TextProperties(text: "Hi")
    element.index = "a0"
    let keys = ElementCodecKeys.keys(of: element)
    #expect(keys.prefix(4) == ["id", "type", "x", "y"])
    #expect(
      keys.suffix(9) == [
        "text", "fontSize", "fontFamily", "textAlign", "verticalAlign", "containerId",
        "originalText", "autoResize", "lineHeight",
      ])
  }

  @Test func rejectsWhatIsntAScene() {
    #expect(throws: SceneCodecError.notAnObject) { try SceneCodec.decode("[]") }
    #expect(throws: SceneCodecError.missingElements) { try SceneCodec.decode("{}") }
    #expect(throws: SceneCodecError.self) { try SceneCodec.decode("{") }
  }
}

enum ElementCodecKeys {
  static func keys(of element: ExcalidrawElement) -> [String] {
    ElementCodec.encode(element).keys
  }
}
