import Foundation

/// Bounds filesystem work and resident text before it is read. These read-only scans never
/// affect checkpoints, downloads, pending edits or recovery; incomplete coverage stays explicit.
public struct CachedNoteScanLimits: Sendable {
  public let maximumDocuments: Int
  public let maximumBytes: Int
  public let maximumDocumentBytes: Int

  public init(
    maximumDocuments: Int = 1_000, maximumBytes: Int = 16 * 1_024 * 1_024,
    maximumDocumentBytes: Int = 1_024 * 1_024
  ) {
    self.maximumDocuments = min(10_000, max(0, maximumDocuments))
    self.maximumBytes = min(16 * 1_024 * 1_024, max(0, maximumBytes))
    self.maximumDocumentBytes = min(5 * 1_024 * 1_024, max(0, maximumDocumentBytes))
  }
}

public struct CachedNoteText: Sendable {
  public let metadata: CachedDocumentMetadata
  public let content: String
}

public struct CachedNoteTextSnapshot: Sendable {
  public let notes: [CachedNoteText]
  public let downloadedNotes: Int
  public let isComplete: Bool
}

extension WorkspaceRepository {
  /// Dirty notes are visited first. `excludingPaths` lets callers account for live editors in
  /// the same budget without loading their older checkpoint a second time.
  public func cachedNoteTexts(
    limits: CachedNoteScanLimits = .init(), excludingPaths: Set<String> = []
  ) throws -> CachedNoteTextSnapshot {
    var notes: [CachedNoteText] = []
    let scan = try scanCachedNotes(limits: limits, excludingPaths: excludingPaths) {
      metadata, text in
      if let text { notes.append(CachedNoteText(metadata: metadata, content: text)) }
      return true
    }
    return CachedNoteTextSnapshot(
      notes: notes, downloadedNotes: scan.downloadedNotes, isComplete: scan.isComplete)
  }

  struct TextScanCoverage {
    let downloadedNotes: Int
    let scannedNotes: Int
    let isComplete: Bool
  }

  /// Only this loop loads text. Metadata remains cheap; each body is checked against the
  /// remaining byte budget before allocation, and only the working file is needed for reading.
  func scanCachedNotes(
    limits: CachedNoteScanLimits, excludingPaths: Set<String> = [],
    visit: (CachedDocumentMetadata, String?) -> Bool
  ) throws -> TextScanCoverage {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    let records = try index.documents().filter {
      !WorkspaceDocumentPath.isDrawing($0.path) && !excludingPaths.contains($0.path)
    }.sorted {
      if ($0.state == .synced) != ($1.state == .synced) { return $0.state != .synced }
      return $0.path < $1.path
    }
    var remainingBytes = limits.maximumBytes
    var attempts = 0
    var scanned = 0
    var complete = true
    for (offset, record) in records.enumerated() {
      try Task.checkCancellation()
      var text: String?
      if attempts < limits.maximumDocuments, remainingBytes > 0,
        limits.maximumDocumentBytes > 0
      {
        attempts += 1
        text = try checkpoints.read(
          record.working, maxBytes: min(remainingBytes, limits.maximumDocumentBytes))
      }
      if let text {
        remainingBytes -= text.utf8.count
        scanned += 1
      } else {
        complete = false
      }
      if !visit(CachedDocumentMetadata(record), text) {
        if offset + 1 < records.count { complete = false }
        break
      }
    }
    return TextScanCoverage(
      downloadedNotes: records.count, scannedNotes: scanned, isComplete: complete)
  }
}
