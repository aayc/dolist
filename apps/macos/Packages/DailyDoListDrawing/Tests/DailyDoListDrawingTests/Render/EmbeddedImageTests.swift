import CoreGraphics
import Foundation
import ImageIO
import Testing

@testable import DailyDoListDrawingCore

@MainActor
@Suite("Embedded drawing images")
struct EmbeddedImageTests {
  private func imageData(red: Bool) throws -> Data {
    let context = try #require(
      CGContext(
        data: nil, width: 8, height: 4, bitsPerComponent: 8, bytesPerRow: 32,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.setFillColor(CGColor(red: red ? 1 : 0, green: 0, blue: red ? 0 : 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: 8, height: 4))
    let bytes = NSMutableData()
    let destination = try #require(
      CGImageDestinationCreateWithData(bytes, "public.png" as CFString, 1, nil))
    CGImageDestinationAddImage(destination, try #require(context.makeImage()), nil)
    #expect(CGImageDestinationFinalize(destination))
    return bytes as Data
  }

  @Test func insertionCropReplaceAndUndoPreserveFilesAndUnknownMetadata() throws {
    let originalFiles = JSONObject([
      ("synthetic", .object(JSONObject([("unknown", .string("preserved"))])))
    ])
    let editor = DrawingEditor(
      scene: ExcalidrawScene(files: .object(originalFiles)),
      environment: DeterministicDrawingEnvironment())
    let id = try editor.insertImage(data: imageData(red: true), mimeType: "image/png", at: .zero)
    let fileId = try #require(editor.element(id)?.fileId)
    #expect(editor.scene.files.objectValue?["synthetic"] == originalFiles["synthetic"])
    editor.cropImage(id, rect: DrawingRect(minX: 0, minY: 0, maxX: 0.5, maxY: 1))
    #expect(editor.element(id)?.height == 8)
    editor.cropImage(id, rect: nil)
    #expect(editor.element(id)?.height == 4)
    try editor.insertImage(
      data: imageData(red: false), mimeType: "image/png", at: .zero, replacing: id)
    let replacementFile = try #require(editor.element(id)?.fileId)
    #expect(replacementFile != fileId)
    #expect(editor.scene.files.objectValue?[fileId] != nil)
    editor.undo()
    #expect(editor.element(id)?.fileId == fileId)
    editor.undo()
    editor.undo()
    editor.undo()
    #expect(editor.element(id)?.isDeleted == true)
    #expect(editor.scene.files.objectValue?[replacementFile] != nil)
    editor.redo()
    #expect(editor.element(id)?.isDeleted == false)
  }

  @Test func rendererDecodesBytesAndInvalidatesAReplacedFileWithTheSameID() throws {
    let editor = DrawingEditor(
      scene: ExcalidrawScene(), environment: DeterministicDrawingEnvironment())
    let id = try editor.insertImage(data: imageData(red: true), mimeType: "image/png", at: .zero)
    let renderer = SceneRenderer()
    let bounds = DrawingRect(x: 0, y: 0, width: 8, height: 4)
    let red = try #require(
      DrawingImage.render(editor.scene, scale: 4, theme: .light, renderer: renderer, bounds: bounds)
    )
    let redPixel = Pixels.color(red, x: 16, y: 8)
    #expect(redPixel.r > 250 && redPixel.b < 5)
    var scene = editor.scene
    let fileId = try #require(editor.element(id)?.fileId)
    var files = try #require(scene.files.objectValue)
    var file = try #require(files[fileId]?.objectValue)
    file["dataURL"] = .string(
      "data:image/png;base64,\(try imageData(red: false).base64EncodedString())")
    files[fileId] = .object(file)
    scene.files = .object(files)
    let blue = try #require(
      DrawingImage.render(scene, scale: 4, theme: .light, renderer: renderer, bounds: bounds))
    let bluePixel = Pixels.color(blue, x: 16, y: 8)
    #expect(bluePixel.b > 250 && bluePixel.r < 5)
  }

  @Test func unreadableInputsDoNotMutateTheSceneOrFetchURLs() throws {
    #expect(EmbeddedDrawingImages.data(from: "https://example.invalid/image.png") == nil)
    #expect(EmbeddedDrawingImages.data(from: "data:text/plain;base64,SGVsbG8=") == nil)
    let scene = ExcalidrawScene(files: .string("unknown file representation"))
    let editor = DrawingEditor(scene: scene)
    #expect(throws: DrawingImageImportError.self) {
      try editor.insertImage(data: imageData(red: true), mimeType: "image/png", at: .zero)
    }
    #expect(editor.scene == scene)
    #expect(!editor.canUndo)
    #expect(DrawingImage.render(scene, scale: .infinity, theme: .light) == nil)
    #expect(DrawingPreviewCache().image(for: scene, width: .infinity, theme: .light) == nil)
  }
}
