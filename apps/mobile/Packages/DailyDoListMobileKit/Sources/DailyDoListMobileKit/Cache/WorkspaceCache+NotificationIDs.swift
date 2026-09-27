import Foundation

extension WorkspaceCache {
  /// Approval alerts share the existing cursor's bounded deduplication history. No independent
  /// durable namespace can strand a workspace during Forget or recovery export.
  @discardableResult
  public func rememberNotificationIDs(_ ids: [String], replacing revision: Int64?) throws -> Int64 {
    let current = try notifications()
    guard current?.revision == revision else { throw WorkspaceRepositoryError.concurrentWrite }
    var state = current?.value ?? NotificationCache(items: [], seenIDs: [])
    var known = Set(state.seenIDs)
    for id in ids where !id.isEmpty && known.insert(id).inserted { state.seenIDs.append(id) }
    state.seenIDs = Array(state.seenIDs.suffix(2_000))
    let value = WorkspaceStoredValue(
      key: "notifications", data: try JSONEncoder().encode(state), updatedAt: clock(),
      retention: .durable)
    let revisions = try store.commitValues([
      WorkspaceValueMutation(key: "notifications", value: value, expectedRevision: revision)
    ])
    guard let result = revisions["notifications"] else {
      throw WorkspaceRepositoryError.corruptIndex
    }
    return result
  }
}
