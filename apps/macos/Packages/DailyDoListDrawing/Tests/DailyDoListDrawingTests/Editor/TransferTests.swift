import Foundation
import Testing

@testable import DailyDoListDrawingCore

@MainActor
@Suite("Drawing clipboard and library")
struct TransferTests {
  @Test func pasteRemapsDependenciesAndCollidingFilesWithoutOverwriting() throws {
    var frame = TestScenes.element(.frame, id: "frame", x: 0, y: 0, width: 200, height: 100)
    frame.name = "Synthetic frame"
    var shape = TestScenes.element(.rectangle, id: "shape", x: 20, y: 20, width: 50, height: 40)
    shape.frameId = "frame"
    shape.groupIds = ["group"]
    shape.boundElements = [.init(id: "label", type: "text"), .init(id: "arrow", type: "arrow")]
    shape.setExtraField("pluginExtra", .string("keep"))
    var label = TestScenes.element(.text, id: "label", x: 25, y: 25, width: 40, height: 20)
    label.text = .init(text: "Synthetic label", containerId: "shape")
    label.frameId = "frame"
    var arrow = TestScenes.linear(
      .arrow, id: "arrow", x: 80, y: 40, points: [.zero, DrawingPoint(80, 0)])
    arrow.startBinding = .init(elementId: "shape", focus: 0, gap: 10)
    arrow.endBinding = .init(elementId: "outside", focus: 0, gap: 10)
    arrow.frameId = "frame"
    var image = TestScenes.element(.image, id: "image", x: 100, y: 50, width: 30, height: 30)
    image.setExtraField("fileId", .string("file"))
    image.frameId = "frame"
    let incoming = JSONValue.object(
      JSONObject([
        ("id", .string("file")), ("dataURL", .string("synthetic incoming")),
        ("future", .bool(true)),
      ]))
    let source = DrawingEditor(
      scene: .init(
        elements: [frame, shape, label, arrow, image],
        files: .object(JSONObject([("file", incoming)]))),
      environment: DeterministicDrawingEnvironment())
    source.select(["frame"])
    let copied = try #require(source.copiedScene())
    let decoded = try DrawingClipboard.decode(DrawingClipboard.encode(copied))
    let previous = JSONValue.object(JSONObject([("dataURL", .string("synthetic existing"))]))
    let target = DrawingEditor(
      scene: .init(files: .object(JSONObject([("file", previous)]))),
      environment: DeterministicDrawingEnvironment())
    let selected = try target.paste(decoded, at: DrawingPoint(300, 200))
    #expect(selected.count == 1)
    let nextFrame = try #require(target.selectedElements.first)
    #expect(nextFrame.type == .frame && nextFrame.id != "frame")
    let nextShape = try #require(target.scene.visibleElements.first { $0.type == .rectangle })
    let nextLabel = try #require(target.scene.visibleElements.first { $0.type == .text })
    let nextArrow = try #require(target.scene.visibleElements.first { $0.type == .arrow })
    let nextImage = try #require(target.scene.visibleElements.first { $0.type == .image })
    #expect(nextShape.frameId == nextFrame.id && nextImage.frameId == nextFrame.id)
    #expect(nextLabel.containerId == nextShape.id)
    #expect(nextShape.boundTextId == nextLabel.id)
    #expect(nextArrow.startBinding?.elementId == nextShape.id && nextArrow.endBinding == nil)
    #expect(nextShape.groupIds != shape.groupIds && !nextShape.groupIds.isEmpty)
    #expect(nextShape.extraField("pluginExtra") == .string("keep"))
    #expect(nextImage.fileId != "file")
    #expect(target.scene.files.objectValue?["file"] == previous)
    #expect(
      target.scene.files.objectValue?[nextImage.fileId!]?.objectValue?["future"] == .bool(true))
    target.undo()
    #expect(target.scene.visibleElements.isEmpty)
    #expect(target.scene.elements.allSatisfy { $0.isDeleted })
    target.redo()
    #expect(target.scene.visibleElements.count == 5)
  }

  @Test func libraryRoundTripRetainsUnknownMetadataAndLegacyItems() throws {
    var item = DrawingLibraryItem(
      id: "synthetic", name: "Reusable", created: 123,
      scene: .init(elements: [TestScenes.element(.diamond, id: "diamond", x: 0, y: 0)]))
    item.metadata["futureLibraryField"] = .array([.number(1), .bool(true)])
    let encoded = DrawingLibraryCodec.encode([item])
    let decoded = try DrawingLibraryCodec.decode(encoded)
    #expect(decoded.count == 1 && decoded[0].name == item.name)
    #expect(decoded[0].metadata["futureLibraryField"] == item.metadata["futureLibraryField"])
    let decodedElements = decoded[0].scene.elements.map { ElementCodec.encode($0) }
    let originalElements = item.scene.elements.map { ElementCodec.encode($0) }
    #expect(decodedElements == originalElements)
    #expect(decoded[0].scene.files == item.scene.files)
    let legacy = JSONObject([
      ("type", .string("excalidrawlib")), ("version", .number(1)),
      ("library", .array([.array([.object(ElementCodec.encode(item.scene.elements[0]))])])),
    ])
    #expect(
      try DrawingLibraryCodec.decode(Data(JSONWriter.string(.object(legacy)).utf8)).count == 1)
    #expect(throws: (any Error).self) {
      try DrawingClipboard.decode("{\"type\":\"other\",\"elements\":[]}")
    }
  }

  @Test func styleAndLinkChangesPreserveContentAndUndo() throws {
    var source = TestScenes.element(.rectangle, id: "source", x: 0, y: 0)
    source.strokeColor = "#ff0000"
    source.opacity = 50
    source.strokeWidth = 4
    let original = TestScenes.element(.ellipse, id: "target", x: 100, y: 100, width: 50, height: 50)
    let editor = DrawingEditor(
      scene: .init(elements: [original]), environment: DeterministicDrawingEnvironment())
    editor.select(["target"])
    editor.pasteStyle(from: source)
    #expect(editor.element("target")?.strokeColor == "#ff0000")
    #expect(editor.element("target")?.x == 100 && editor.element("target")?.type == .ellipse)
    editor.setSelectionLink("  [[Synthetic Note]]  ")
    #expect(editor.element("target")?.link == "[[Synthetic Note]]")
    editor.undo()
    editor.undo()
    #expect(editor.element("target")?.link == nil)
    #expect(editor.element("target")?.strokeColor == original.strokeColor)
  }
}
