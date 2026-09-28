import DailyDoListMobileDrawing
import Foundation
import Testing

@testable import DailyDoList

@MainActor
@Suite("Phone drawing library file")
struct PhoneDrawingLibraryFileTests {
  @Test func legacyPreferencesMoveIntoOneFileUnderTheStorageRoot() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString, isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let suite = "app.dailydolist.tests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let legacy = DrawingLibraryCodec.encode([
      DrawingLibraryItem(
        id: "synthetic", name: "Synthetic shapes", created: 1,
        scene: ExcalidrawScene(elements: [ExcalidrawElement(id: "shape", type: .rectangle)]))
    ])
    defaults.set(legacy, forKey: "drawing.library.v1")
    let file = PhoneDrawingLibraryFile(rootDirectory: root)

    let library = MobileDrawingLibrary(storage: file.storage, legacy: .userDefaults(defaults))
    library.loadIfNeeded()

    #expect(library.error == nil && library.items.map(\.id) == ["synthetic"])
    #expect(defaults.data(forKey: "drawing.library.v1") == nil)
    #expect(
      try FileManager.default.contentsOfDirectory(atPath: root.path) == [file.url.lastPathComponent]
    )
    #expect(try Data(contentsOf: file.url) == legacy)
  }
}
