import Foundation
import SQLite3

extension SQLiteWorkspaceIndex: WorkspaceContentStore {
  public func beginContentFetch(
    _ resource: CachedContentResource, scope: WorkspaceScope, replacing generation: Int64?
  ) throws -> ContentFetchTicket {
    try resource.validate()
    return try locked {
      try transaction {
        let storedScope: WorkspaceScope? = try read("metadata", keyColumn: "key", key: "scope")
        guard storedScope == scope else { throw WorkspaceRepositoryError.workspaceMismatch }
        if let generation {
          guard try contentMetadata(resource)?.generation == generation else {
            throw WorkspaceRepositoryError.concurrentWrite
          }
        }
        let next = try nextContentGeneration()
        let pinned = try contentKey(resource.key)?.pinned ?? false
        try writeContentKey(resource, generation: next, pinned: pinned)
        return ContentFetchTicket(scope: scope, resource: resource, generation: next)
      }
    }
  }

  public func contentResources(pinnedOnly: Bool) throws -> [CachedContentResource] {
    try locked {
      try statement(
        "SELECT resource FROM content_cache_keys" + (pinnedOnly ? " WHERE pinned=1" : "")
          + " ORDER BY key"
      ) {
        var resources: [CachedContentResource] = []
        while true {
          switch sqlite3_step($0) {
          case SQLITE_ROW: resources.append(try decode($0))
          case SQLITE_DONE: return resources
          default: throw failure()
          }
        }
      }
    }
  }

  public func contentAvailability(_ resource: CachedContentResource) throws
    -> ContentCacheAvailability
  {
    try locked {
      try transaction {
        if let metadata = try contentMetadata(resource) { return .available(metadata) }
        return .missing(pinned: try contentKey(resource.key)?.pinned ?? false)
      }
    }
  }

  public func readContent(_ resource: CachedContentResource, maxBytes: Int, at: Date) throws
    -> StoredCachedContent?
  {
    try locked {
      try transaction {
        guard let prior = try contentMetadata(resource) else { return nil }
        // Enforce the configured read cap before SQLite materializes the BLOB into Swift Data.
        guard prior.byteCount <= maxBytes else {
          throw WorkspaceContentCacheError.payloadTooLarge(limit: maxBytes)
        }
        try statement(
          "SELECT length(data), length(descriptor) FROM content_cache WHERE key=?",
          key: resource.key
        ) {
          guard sqlite3_step($0) == SQLITE_ROW,
            sqlite3_column_int64($0, 0) == prior.byteCount,
            sqlite3_column_int64($0, 1) <= 65_536
          else { throw WorkspaceContentCacheError.corruptContent }
        }
        let stored: (Data, Data) = try statement(
          "SELECT data, descriptor FROM content_cache WHERE key=?", key: resource.key
        ) {
          guard sqlite3_step($0) == SQLITE_ROW else {
            throw WorkspaceContentCacheError.corruptContent
          }
          return (try contentBlob($0, column: 0), try contentBlob($0, column: 1))
        }
        guard MarkdownCheckpointStore.digest(stored.0) == prior.sha256 else {
          throw WorkspaceContentCacheError.corruptContent
        }
        let metadata = CachedContentMetadata(
          resource: resource, generation: prior.generation, fetchedAt: prior.fetchedAt,
          accessedAt: at, byteCount: prior.byteCount, sha256: prior.sha256, pinned: prior.pinned)
        try statement(
          "UPDATE content_cache SET body=?, accessed_at=?, byte_count=length(data)+length(descriptor)+? WHERE key=?"
        ) {
          let body = try JSONEncoder().encode(metadata)
          try bindContentBlob(body, statement: $0, column: 1)
          guard sqlite3_bind_double($0, 2, at.timeIntervalSince1970) == SQLITE_OK,
            sqlite3_bind_int64($0, 3, Int64(body.count)) == SQLITE_OK,
            sqlite3_bind_text($0, 4, resource.key, -1, Self.transient) == SQLITE_OK,
            sqlite3_step($0) == SQLITE_DONE
          else { throw failure() }
        }
        return StoredCachedContent(metadata: metadata, descriptor: stored.1, data: stored.0)
      }
    }
  }

  public func commitContent(
    _ data: Data, descriptor: Data, ticket: ContentFetchTicket, at: Date,
    limits: ContentCacheLimits
  ) throws -> CachedContentMetadata {
    try ticket.resource.validate()
    let maximum = limits.maximum(for: ticket.resource)
    guard data.count <= maximum else {
      throw WorkspaceContentCacheError.payloadTooLarge(limit: maximum)
    }
    guard descriptor.count <= 65_536, at.timeIntervalSince1970.isFinite else {
      throw WorkspaceContentCacheError.invalidContent
    }
    let hash = MarkdownCheckpointStore.digest(data)
    return try locked {
      try transaction {
        let storedScope: WorkspaceScope? = try read("metadata", keyColumn: "key", key: "scope")
        guard storedScope == ticket.scope else { throw WorkspaceRepositoryError.workspaceMismatch }
        guard let key = try contentKey(ticket.resource.key), key.generation == ticket.generation
        else {
          throw WorkspaceContentCacheError.staleFetch
        }
        let generation = try nextContentGeneration()
        let metadata = CachedContentMetadata(
          resource: ticket.resource, generation: generation, fetchedAt: at, accessedAt: at,
          byteCount: data.count, sha256: hash, pinned: key.pinned)
        let body = try JSONEncoder().encode(metadata)
        let size = data.count + descriptor.count + body.count
        guard size <= limits.totalBytes else { throw WorkspaceContentCacheError.budgetExceeded }
        try writeContentKey(ticket.resource, generation: generation, pinned: key.pinned)
        try statement(
          "INSERT OR REPLACE INTO content_cache (key, body, descriptor, data, byte_count, accessed_at) VALUES (?, ?, ?, ?, ?, ?)",
          key: ticket.resource.key
        ) {
          try bindContentBlob(body, statement: $0, column: 2)
          try bindContentBlob(descriptor, statement: $0, column: 3)
          try bindContentBlob(data, statement: $0, column: 4)
          guard sqlite3_bind_int64($0, 5, Int64(size)) == SQLITE_OK,
            sqlite3_bind_double($0, 6, at.timeIntervalSince1970) == SQLITE_OK,
            sqlite3_step($0) == SQLITE_DONE
          else { throw failure() }
        }
        // Protect this insertion while making room; if only pinned entries remain, rollback
        // the entire transaction (including evictions) instead of acknowledging absent bytes.
        let usage = try trimContentUnlocked(to: limits.totalBytes, excluding: ticket.resource.key)
        guard !usage.overBudget else { throw WorkspaceContentCacheError.budgetExceeded }
        return metadata
      }
    }
  }

  public func setContentPinned(_ resource: CachedContentResource, pinned: Bool) throws {
    try locked {
      try transaction {
        let existing = try contentKey(resource.key)
        let generation = try existing?.generation ?? nextContentGeneration()
        try writeContentKey(resource, generation: generation, pinned: pinned)
      }
    }
  }

  public func removeContent(_ resource: CachedContentResource) throws {
    try locked { try transaction { try deleteCachedContent(resource.key) } }
  }

  public func trimContent(to budgetBytes: Int) throws -> ContentCacheUsage {
    try locked { try transaction { try trimContentUnlocked(to: max(0, budgetBytes)) } }
  }

  public func contentUsage(budgetBytes: Int) throws -> ContentCacheUsage {
    try locked { try contentUsageUnlocked(budgetBytes: budgetBytes) }
  }
}
