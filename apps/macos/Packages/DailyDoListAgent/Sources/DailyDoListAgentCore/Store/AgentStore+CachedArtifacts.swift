import DailyDoListClient
import DailyDoListModels
import Foundation

public struct AgentArtifactLoad: Sendable {
  public let value: AgentCachedArtifact
  public let fetchedAt: Date
  public let fromCache: Bool
  public let savedOffline: Bool
}

extension AgentStore {
  /// Cached-first unless explicitly refreshed. Every network download uses the streaming cap;
  /// cache absence never becomes a synthetic empty artifact. Failures preserve the older copy.
  public func loadArtifact(threadID: String, artifactID: String, refresh: Bool = false) async throws
    -> AgentArtifactLoad
  {
    let resource = AgentCacheResource.artifact(threadID: threadID, artifactID: artifactID)
    if let contentCache, !refresh || !canFetchContent,
      let saved = try await contentCache.artifact(threadID: threadID, artifactID: artifactID)
    {
      cacheAvailability[resource] = .available(saved.metadata)
      return AgentArtifactLoad(
        value: saved.value, fetchedAt: saved.metadata.fetchedAt, fromCache: true, savedOffline: true
      )
    }
    guard canFetchContent else { throw AgentContentError.unavailableOffline }
    guard let meta = artifactMeta(threadId: threadID, artifactId: artifactID) else {
      throw AgentContentError.unavailableOffline
    }
    let limit: Int
    if let contentCache {
      limit = min(DaemonProtocol.attachmentMaxBytes, await contentCache.artifactMaxBytes)
    } else {
      limit = DaemonProtocol.attachmentMaxBytes
    }
    guard limit > 0, meta.size <= limit else { throw AgentContentError.exceedsLimit(limit) }
    let authority = mutationAuthorityGeneration
    let ticket = try await contentCache?.begin(resource)
    guard contentCache == nil || (authority == mutationAuthorityGeneration && canFetchContent)
    else {
      throw AgentContentError.changedConnection
    }
    let payload = try await client.artifact(
      threadId: threadID, artifactId: artifactID, maxBytes: limit)
    guard !Task.isCancelled,
      contentCache == nil || (authority == mutationAuthorityGeneration && canFetchContent)
    else {
      throw AgentContentError.changedConnection
    }
    var savedOffline = false
    if let contentCache, let ticket {
      do {
        let saved = try await contentCache.storeArtifact(meta, payload: payload, ticket: ticket)
        cacheAvailability[resource] = .available(saved)
        savedOffline = true
      } catch {
        report(error, title: "Artifact opened but wasn't saved offline")
      }
    }
    return AgentArtifactLoad(
      value: AgentCachedArtifact(artifact: meta, payload: payload), fetchedAt: now(),
      fromCache: false, savedOffline: savedOffline)
  }

  /// An explicit download selection. Offline selections stay pinned/missing until the user
  /// retries online; they never claim successful bytes or queue an agent action.
  @discardableResult
  public func downloadArtifact(threadID: String, artifactID: String) async -> Bool {
    let resource = AgentCacheResource.artifact(threadID: threadID, artifactID: artifactID)
    await setContentPinned(resource, pinned: true)
    do {
      let result = try await loadArtifact(threadID: threadID, artifactID: artifactID, refresh: true)
      await refreshCacheAvailability(resource)
      return result.savedOffline
    } catch {
      report(error, title: "Couldn't download the artifact")
      return false
    }
  }
}
