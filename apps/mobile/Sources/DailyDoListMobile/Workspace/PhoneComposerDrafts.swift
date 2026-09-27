import DailyDoListMobileAgent
import DailyDoListMobileKit
import Foundation

/// Keeps the composer immediately responsive while serializing durable revisions per thread.
/// An acknowledged clear follows every older queued save, so a delayed save cannot revive it.
@MainActor
final class PhoneComposerDrafts {
  private let cache: WorkspaceCache
  private var text: [String: String] = [:]
  private var revisions: [String: Int64] = [:]
  private var pending: [String: Task<Void, Never>] = [:]
  var onError: ((String) -> Void)?

  init(cache: WorkspaceCache) { self.cache = cache }

  var callbacks: MobileAgentDrafts {
    MobileAgentDrafts(
      load: { [self] id in try await load(id) }, save: { [self] id, value in save(id, value) })
  }

  func load(_ id: String) async throws -> String {
    if let current = text[id] { return current }
    let saved = try await cache.composer(.thread(id))
    // A second view can type while this fetch waits on the cache actor.
    if let current = text[id] { return current }
    revisions[id] = saved.revision
    text[id] = saved.text
    return saved.text
  }

  func save(_ id: String, _ value: String) {
    text[id] = value
    let previous = pending[id]
    pending[id] = Task { [self] in
      await previous?.value
      do {
        if revisions[id] == nil { revisions[id] = try await cache.composer(.thread(id)).revision }
        let result = try await cache.saveComposer(
          .thread(id), text: value, replacing: revisions[id] ?? 0)
        revisions[id] = result.revision
      } catch {
        onError?(
          "Your reply is still open, but it could not be saved on this iPhone: \(error.localizedDescription)"
        )
      }
    }
  }

  func flush() async {
    for task in Array(pending.values) { await task.value }
  }
}
