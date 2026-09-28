import DailyDoListMobileDrawing
import Foundation
import Testing

@MainActor
@Suite("Drawing import safety")
struct DrawingImportSafetyTests {
  @Test func aSupersededPhotoLoadNeverAppliesToTheNextTarget() async {
    let imports = DrawingImageImportSession()
    var applied: [String] = []
    let apply: @MainActor (Data, DrawingImageImportSession.Request) -> Void = { data, request in
      applied.append("\(request.replacing ?? "new"):\(data.first ?? 0)")
    }
    let first = ControlledImageLoad()
    let second = ControlledImageLoad()
    let late = imports.load(
      imports.begin(replacing: "first", at: .zero), bytes: first.bytes, apply: apply)
    let current = imports.load(
      imports.begin(replacing: "second", at: .zero), bytes: second.bytes, apply: apply)
    second.finish(.success(Data([2])))
    await current?.value
    first.finish(.success(Data([1])))
    await late?.value
    #expect(applied == ["second:2"])
    #expect(imports.error == nil)
  }

  @Test func aCancelledLoadIgnoresItsLateSuccessOrError() async {
    let imports = DrawingImageImportSession()
    var applied = 0
    let results: [Result<Data?, any Error>] = [
      .success(Data([1])), .failure(DrawingImageImportError.unreadable),
    ]
    for result in results {
      let load = ControlledImageLoad()
      let task = imports.load(imports.begin(replacing: nil, at: .zero), bytes: load.bytes) {
        _, _ in applied += 1
      }
      imports.cancel()
      load.finish(result)
      await task?.value
    }
    #expect(applied == 0 && imports.error == nil)
  }

  /// The limit applies to the whole write request: preserved Markdown (escaped, multibyte) and the
  /// conditional version count, and a body of exactly the daemon's limit is accepted.
  @Test func importsMustFitTheExactDaemonRequestAndCommitAsOneStep() throws {
    let png = try SyntheticPNG.data()
    let scene = ExcalidrawScene(elements: [ExcalidrawElement(id: "shape", type: .rectangle)])
    let file = ExcalidrawMarkdown.newFile(for: scene)
    func context(padding: Int, version: String = "synthetic-version") -> DrawingImportContext {
      let notes = "Synthetic \"notes\"\tcafé\n" + String(repeating: "x", count: padding) + "\n\n"
      let previous = ExcalidrawMarkdown.parse(
        file.replacingOccurrences(of: "# Excalidraw Data", with: notes + "# Excalidraw Data"))
      return DrawingImportContext(previous: previous, baseVersion: version)
    }
    func editor() -> DrawingEditor {
      let editor = DrawingEditor(scene: scene, environment: DeterministicDrawingEnvironment())
      editor.select(["shape"])
      return editor
    }
    func insert(_ editor: DrawingEditor, within context: DrawingImportContext) throws {
      try editor.validatedImport(validate: context.validate) {
        try $0.insertImage(data: png, mimeType: "image/png", at: .zero)
      }
    }
    let probe = editor()
    try probe.insertImage(data: png, mimeType: "image/png", at: .zero)
    let fits =
      DrawingImportContext.maximumRequestBytes
      - (try context(padding: 0).requestBytes(for: probe.scene))

    for tooLarge in [
      context(padding: fits + 1), context(padding: fits, version: "synthetic-version!"),
    ] {
      let refused = editor()
      var saves = 0
      refused.onChange = { _ in saves += 1 }
      #expect(throws: MobileDrawingImportError.uploadTooLarge) {
        try insert(refused, within: tooLarge)
      }
      #expect(refused.scene == scene && refused.selectedIds == ["shape"])
      #expect(!refused.canUndo && saves == 0)
    }

    let accepted = editor()
    var saves = 0
    accepted.onChange = { _ in saves += 1 }
    try insert(accepted, within: context(padding: fits))
    #expect(saves == 1 && accepted.scene.visibleElements.count == 2)
    accepted.undo()
    #expect(accepted.scene.visibleElements.map(\.id) == ["shape"] && !accepted.canUndo)
  }
}

#if canImport(UIKit)
  @MainActor
  @Suite("Drawing import authority")
  struct DrawingImportAuthorityTests {
    @Test func aPhotoFinishingAfterTheDrawingBecameReadOnlyIsRefused() async throws {
      let controller = MobileDrawingController(scene: .init())
      let imports = DrawingImageImportSession()
      let load = ControlledImageLoad()
      let task = imports.load(imports.begin(replacing: nil, at: .zero), bytes: load.bytes) {
        data, request in
        try controller.insertImage(data, replacing: request.replacing, at: request.point)
      }
      controller.isEditing = false
      load.finish(.success(try SyntheticPNG.data()))
      await task?.value
      #expect(controller.scene.elements.isEmpty && !controller.editor.canUndo)
      #expect(imports.error == MobileDrawingImportError.readOnly.errorDescription)
    }
  }
#endif
