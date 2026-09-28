import DailyDoListMobileDrawing
import Foundation
import Testing

enum DrawingLibraryStorageFailure: CaseIterable, Sendable {
  case load, save, unverified
}

@MainActor
@Suite("Drawing library persistence")
struct DrawingLibraryPersistenceTests {
  /// The protected file, failing on demand.
  final class File {
    var data: Data?
    var failure: DrawingLibraryStorageFailure?
    var storage: MobileDrawingLibrary.Storage {
      MobileDrawingLibrary.Storage(
        load: { [self] in
          if failure == .load { throw CocoaError(.fileReadUnknown) }
          return data
        },
        save: { [self] bytes in
          switch failure {
          case .save: throw CocoaError(.fileWriteOutOfSpace)
          case .unverified: data = Data("{}".utf8)
          case .load, nil: data = bytes
          }
        })
    }
  }
  final class Preferences {
    var data: Data?
    init(data: Data?) { self.data = data }
    var legacy: MobileDrawingLibrary.LegacyStorage {
      MobileDrawingLibrary.LegacyStorage(load: { [self] in data }, remove: { [self] in data = nil })
    }
  }

  let legacyBytes = DrawingLibraryCodec.encode([
    DrawingLibraryItem(
      id: "synthetic", name: "Synthetic shapes", created: 1,
      scene: ExcalidrawScene(elements: [ExcalidrawElement(id: "shape", type: .rectangle)]))
  ])
  let added = ExcalidrawScene(elements: [ExcalidrawElement(id: "added", type: .ellipse)])

  @Test func theLegacyLibraryMovesOnlyOnceItsProtectedCopyReadsBack() throws {
    let file = File()
    file.failure = .save
    let preferences = Preferences(data: legacyBytes)
    let library = MobileDrawingLibrary(storage: file.storage, legacy: preferences.legacy)
    library.loadIfNeeded()
    #expect(preferences.data == legacyBytes && library.error != nil)

    file.failure = nil
    try library.add(added, name: "Added")
    #expect(preferences.data == nil && library.error == nil)
    #expect(library.items.map(\.name) == ["Synthetic shapes", "Added"])
    #expect(
      try DrawingLibraryCodec.decode(try #require(file.data)).map(\.name) == [
        "Synthetic shapes", "Added",
      ])
  }

  @Test(arguments: DrawingLibraryStorageFailure.allCases)
  func aFailedMoveKeepsTheLegacyBytesUsable(_ failure: DrawingLibraryStorageFailure) {
    let file = File()
    file.failure = failure
    let preferences = Preferences(data: legacyBytes)
    let library = MobileDrawingLibrary(storage: file.storage, legacy: preferences.legacy)
    library.loadIfNeeded()
    #expect(preferences.data == legacyBytes)
    #expect(library.error != nil && library.items.map(\.id) == ["synthetic"])
    #expect(library.exportData == legacyBytes)
    #expect(throws: MobileDrawingLibraryError.unavailable) { try library.add(added, name: "") }
    #expect(preferences.data == legacyBytes)
  }
}
