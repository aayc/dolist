import Foundation
import Testing

@testable import DailyDoList

struct AttachmentOriginalLoaderTests {
  @Test func fileImportsPreserveBytesAndRejectFoldersOrOversizedSources() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let source = root.appendingPathComponent("Synthetic original.bin")
    let bytes = Data([0, 255, 128, 1])
    try bytes.write(to: source)
    let imported = try await AttachmentOriginalLoader.load(source)
    #expect(imported.data == bytes)
    #expect(imported.filename == source.lastPathComponent)
    #expect(throws: AttachmentImportError.unsupportedFormat) {
      try AttachmentOriginalLoader.validateEmbedFilename(imported.filename)
    }
    try AttachmentOriginalLoader.validateEmbedFilename("Synthetic.PDF")
    #expect(throws: AttachmentImportError.tooLarge) {
      try AttachmentOriginalLoader.read(source, maximumBytes: 3)
    }
    #expect(throws: AttachmentImportError.notAFile) {
      try AttachmentOriginalLoader.read(root)
    }
  }

  @Test func streamingCapRejectsGrowthEvenWhenProviderMetadataWasSmaller() throws {
    var chunks = [Data([1, 2, 3]), Data([4, 5])]
    var requested: [Int] = []
    #expect(throws: AttachmentImportError.tooLarge) {
      try AttachmentOriginalLoader.boundedData(maximumBytes: 4) { count in
        requested.append(count)
        return chunks.removeFirst()
      }
    }
    #expect(requested == [5, 2])
    var exact = [Data([1, 2, 3, 4]), Data()]
    #expect(
      try AttachmentOriginalLoader.boundedData(maximumBytes: 4) { _ in exact.removeFirst() }
        == Data([1, 2, 3, 4]))
  }
}
