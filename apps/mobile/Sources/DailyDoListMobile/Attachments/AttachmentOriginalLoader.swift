import DailyDoListModels
import Foundation

struct ImportedAttachment: Sendable {
  let data: Data
  let filename: String
}

enum AttachmentImportError: Error, LocalizedError, Equatable {
  case unavailable, notAFile, tooLarge, unsupportedFormat
  var errorDescription: String? {
    switch self {
    case .unavailable:
      "The selected file could not be opened. Download it in Files or Photos and try again."
    case .notAFile: "Choose a file instead of a folder."
    case .tooLarge: "Choose a file of 5 MB or less. The original will not be resized or compressed."
    case .unsupportedFormat:
      "Choose a PNG, JPEG, GIF, WebP, HEIC, HEIF, TIFF, BMP, SVG or PDF file."
    }
  }
}

/// Runs off the main actor. Security-scoped access and file-provider coordination last through
/// the bounded read; no source URL or temporary picker file escapes into the editor.
struct AttachmentOriginalLoader {
  /// Mirrors the editor's supported attachment targets; other files must not be queued with
  /// an embed the editor cannot insert.
  static func validateEmbedFilename(_ filename: String) throws {
    let supported: Set<String> = [
      "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "svg", "pdf",
    ]
    guard supported.contains((filename as NSString).pathExtension.lowercased()) else {
      throw AttachmentImportError.unsupportedFormat
    }
  }

  static func load(_ url: URL) async throws -> ImportedAttachment {
    try await Task.detached(priority: .userInitiated) {
      let scoped = url.startAccessingSecurityScopedResource()
      defer { if scoped { url.stopAccessingSecurityScopedResource() } }
      var failure: NSError?
      var result: Result<ImportedAttachment, Error>?
      NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &failure) {
        coordinated in
        result = Result { try read(coordinated) }
      }
      if let failure { throw failure }
      guard let result else { throw AttachmentImportError.unavailable }
      return try result.get()
    }.value
  }

  static func read(_ url: URL, maximumBytes: Int = DaemonProtocol.attachmentMaxBytes) throws
    -> ImportedAttachment
  {
    let metadata = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
    guard metadata.isRegularFile == true else { throw AttachmentImportError.notAFile }
    guard maximumBytes > 0, (metadata.fileSize ?? 0) <= maximumBytes else {
      throw AttachmentImportError.tooLarge
    }
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    let data = try boundedData(maximumBytes: maximumBytes) { try handle.read(upToCount: $0) }
    return ImportedAttachment(data: data, filename: url.lastPathComponent)
  }

  /// The stream cap remains authoritative if provider metadata is missing or a file grows.
  static func boundedData(maximumBytes: Int, read: (Int) throws -> Data?) throws -> Data {
    guard maximumBytes > 0 else { throw AttachmentImportError.tooLarge }
    var data = Data()
    while true {
      try Task.checkCancellation()
      guard let chunk = try read(min(64 * 1_024, maximumBytes - data.count + 1)), !chunk.isEmpty
      else {
        return data
      }
      guard chunk.count <= maximumBytes - data.count else { throw AttachmentImportError.tooLarge }
      data.append(chunk)
    }
  }
}
