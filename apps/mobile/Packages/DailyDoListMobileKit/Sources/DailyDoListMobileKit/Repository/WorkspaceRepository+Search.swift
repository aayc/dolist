import DailyDoListDomain
import DailyDoListModels
import Foundation

public struct CachedSearchResult: Sendable {
  public let hits: [SearchHit]
  public let downloadedNotes: Int
}

extension WorkspaceRepository {
  /// Runs on the repository actor after the UI's debounce. Coverage is explicit: unavailable
  /// files never become false negative claims about the whole vault.
  public func search(_ query: String, limit: Int = 100) throws -> CachedSearchResult {
    let documents = try notes()
    let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else {
      return CachedSearchResult(hits: [], downloadedNotes: documents.count)
    }
    let maximum = min(500, max(0, limit))
    var hits = documents.filter { $0.path.localizedCaseInsensitiveContains(query) }.prefix(maximum)
      .map {
        SearchHit(path: $0.path, kind: .name, line: 0, preview: VaultPath.basename($0.path))
      }
    for note in documents where hits.count < maximum {
      try Task.checkCancellation()
      for (line, text) in note.content.components(separatedBy: "\n").enumerated()
      where hits.count < maximum && text.localizedCaseInsensitiveContains(query) {
        hits.append(
          SearchHit(path: note.path, kind: .content, line: line, preview: String(text.prefix(400))))
      }
    }
    return CachedSearchResult(hits: hits, downloadedNotes: documents.count)
  }
}
