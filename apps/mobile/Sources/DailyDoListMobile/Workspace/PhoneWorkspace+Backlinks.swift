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
    let cached = try await repository.notes()
    var documents: [String: String] = [:]
    var bytes = 0
    var verified: Set<String> = []
    // A full on-demand scan is bounded by count and bytes, and explicitly reports partial
    // coverage. Live editors win over snapshots without being checkpointed or changed here.
    for note in cached {
      let text = sessions[note.path]?.editor.text ?? note.content
      guard documents.count < 200, bytes + text.utf8.count <= 16 * 1_024 * 1_024 else { continue }
      documents[note.path] = text
      bytes += text.utf8.count
    }
    if let client, online {
      for target in allPaths where target != path {
        try Task.checkCancellation()
        guard generation == epoch else { throw WorkspaceRepositoryError.connectionChanged }
        if let local = cached.first(where: { $0.path == target }),
          local.state != .synced
            || entries.first(where: { $0.path == target })?.version == local.baseVersion
        {
          if documents[target] != nil { verified.insert(target) }
          continue
        }
        guard documents.count < 200 || documents[target] != nil,
          bytes < 16 * 1_024 * 1_024
        else { break }
        do {
          let note = try await client.readNote(
            target, maxBytes: min(1_024 * 1_024, 16 * 1_024 * 1_024 - bytes))
          guard generation == epoch else { throw WorkspaceRepositoryError.connectionChanged }
          bytes -= documents[target]?.utf8.count ?? 0
          documents[target] = sessions[target]?.editor.text ?? note.content
          bytes += documents[target]?.utf8.count ?? 0
          verified.insert(target)
        } catch {
          if generation != epoch { throw WorkspaceRepositoryError.connectionChanged }
          // An unread note leaves coverage partial, never a false "no mentions" claim.
          documents[target] = nil
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
