import DailyDoListDomain
import DailyDoListDrawingModel
import DailyDoListEditorCore
import DailyDoListMobileKit
import Foundation

extension PhoneWorkspace {
  func backlinks(to path: String) async throws -> EditorBacklinksSnapshot {
    let epoch = generation
    let allPaths = entries.filter {
      $0.kind == .file && $0.path.hasSuffix(".md") && !DrawingFileName.isDrawingPath($0.path)
    }.map(\.path)
    let metadata = Dictionary(
      uniqueKeysWithValues: try await repository.cachedDocumentMetadata().map { ($0.path, $0) })
    let versions = Dictionary(
      entries.map { ($0.path, $0.version) }, uniquingKeysWith: { _, new in new })
    var documents: [String: String] = [:]
    var bytes = 0
    var verified: Set<String> = []
    // Live text is already resident and wins over any older checkpoint. Reserve its budget
    // before asking the repository to open files, with unsaved sessions first.
    let live = sessions.values.filter {
      $0.note.path != path && ($0.hasUncheckpointedEdits || $0.note.state != .synced)
    }.sorted {
      if $0.hasUncheckpointedEdits != $1.hasUncheckpointedEdits { return $0.hasUncheckpointedEdits }
      return $0.note.path < $1.note.path
    }
    for session in live {
      let text = session.editor.text
      guard documents.count < 200, bytes + text.utf8.count <= 16 * 1_024 * 1_024 else { continue }
      documents[session.note.path] = text
      bytes += text.utf8.count
    }
    let cached = try await repository.cachedNoteTexts(
      limits: .init(
        maximumDocuments: 200 - documents.count, maximumBytes: 16 * 1_024 * 1_024 - bytes),
      excludingPaths: Set(documents.keys).union([path]))
    guard generation == epoch else { throw WorkspaceRepositoryError.connectionChanged }
    for note in cached.notes {
      let text = sessions[note.metadata.path]?.editor.text ?? note.content
      guard bytes + text.utf8.count <= 16 * 1_024 * 1_024 else { continue }
      documents[note.metadata.path] = text
      bytes += text.utf8.count
    }
    if let client, online {
      var fetches = 0
      for target in allPaths where target != path {
        try Task.checkCancellation()
        guard generation == epoch else { throw WorkspaceRepositoryError.connectionChanged }
        if let local = metadata[target],
          local.state != .synced || sessions[target]?.hasUncheckpointedEdits == true
            || (versions[target] ?? nil) == local.baseVersion
        {
          if documents[target] != nil { verified.insert(target) }
          continue
        }
        let remaining = 16 * 1_024 * 1_024 - bytes + (documents[target]?.utf8.count ?? 0)
        guard documents.count < 200 || documents[target] != nil, remaining > 0, fetches < 200
        else { break }
        fetches += 1
        do {
          let note = try await client.readNote(
            target, maxBytes: min(1_024 * 1_024, remaining))
          guard generation == epoch else { throw WorkspaceRepositoryError.connectionChanged }
          let text = sessions[target]?.editor.text ?? note.content
          guard text.utf8.count <= remaining else { continue }
          bytes -= documents[target]?.utf8.count ?? 0
          documents[target] = text
          bytes += text.utf8.count
          verified.insert(target)
        } catch {
          if generation != epoch { throw WorkspaceRepositoryError.connectionChanged }
          // An unread note leaves coverage partial, never a false "no mentions" claim.
          bytes -= documents.removeValue(forKey: target)?.utf8.count ?? 0
        }
      }
    }
    guard generation == epoch else { throw WorkspaceRepositoryError.connectionChanged }
    let snapshot = documents
    let mentions = await Task.detached {
      EditorBacklinkIndex.mentions(of: path, notes: snapshot, paths: allPaths)
    }.value
    guard generation == epoch else { throw WorkspaceRepositoryError.connectionChanged }
    let covered = Set(allPaths).subtracting([path]).isSubset(of: verified)
    return EditorBacklinksSnapshot(
      mentions: mentions,
      coverage: online ? (covered ? .complete : .partial) : .cached(updatedAt: nil))
  }
}
