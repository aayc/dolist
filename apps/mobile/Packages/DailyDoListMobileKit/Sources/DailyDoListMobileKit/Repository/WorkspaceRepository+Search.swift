import DailyDoListDomain
import DailyDoListModels
import Foundation

public struct CachedSearchResult: Sendable {
  public let hits: [SearchHit]
  public let downloadedNotes: Int
  public let searchedNotes: Int
  public let isComplete: Bool
}

extension WorkspaceRepository {
  /// Runs on the repository actor after the UI's debounce. Coverage is explicit: unavailable
  /// files never become false negative claims about the whole vault.
  public func search(
    _ query: String, limit: Int = 100, scanLimits: CachedNoteScanLimits = .init()
  ) throws -> CachedSearchResult {
    let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let maximum = min(500, max(0, limit))
    guard !query.isEmpty, maximum > 0 else {
      let count = try index.documents().filter { !WorkspaceDocumentPath.isDrawing($0.path) }.count
      return CachedSearchResult(
        hits: [], downloadedNotes: count, searchedNotes: 0, isComplete: count == 0)
    }
    var hits: [SearchHit] = []
    let scan = try scanCachedNotes(limits: scanLimits) { metadata, content in
      if metadata.path.localizedCaseInsensitiveContains(query) {
        hits.append(
          SearchHit(
            path: metadata.path, kind: .name, line: 0, preview: VaultPath.basename(metadata.path)))
      }
      if let content, hits.count < maximum {
        // Visit line slices lazily, keeping the source's empty lines and zero-based positions.
        var start = content.startIndex
        var line = 0
        while hits.count < maximum {
          let end = content[start...].firstIndex(of: "\n") ?? content.endIndex
          let text = content[start..<end]
          if text.localizedCaseInsensitiveContains(query) {
            hits.append(
              SearchHit(
                path: metadata.path, kind: .content, line: line, preview: String(text.prefix(400))))
          }
          guard end < content.endIndex else { break }
          start = content.index(after: end)
          line += 1
        }
      }
      return hits.count < maximum
    }
    return CachedSearchResult(
      hits: hits, downloadedNotes: scan.downloadedNotes,
      searchedNotes: scan.scannedNotes, isComplete: scan.isComplete && hits.count < maximum)
  }
}
