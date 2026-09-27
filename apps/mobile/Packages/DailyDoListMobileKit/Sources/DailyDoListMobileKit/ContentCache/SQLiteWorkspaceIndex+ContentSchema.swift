import Foundation
import SQLite3

extension SQLiteWorkspaceIndex {
  func createContentCacheSchema() throws {
    try execute(
      """
      CREATE TABLE IF NOT EXISTS workspace_value_revisions (
        key TEXT PRIMARY KEY, revision INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO workspace_value_revisions SELECT key, revision FROM workspace_values;
      CREATE TABLE IF NOT EXISTS content_cache_keys (
        key TEXT PRIMARY KEY, resource BLOB NOT NULL, generation INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS content_cache (
        key TEXT PRIMARY KEY, body BLOB NOT NULL, descriptor BLOB NOT NULL, data BLOB NOT NULL,
        byte_count INTEGER NOT NULL, accessed_at REAL NOT NULL
      );
      """)
  }

  func lastValueRevision(_ key: String) throws -> Int64 {
    try statement("SELECT revision FROM workspace_value_revisions WHERE key=?", key: key) {
      switch sqlite3_step($0) {
      case SQLITE_ROW: return sqlite3_column_int64($0, 0)
      case SQLITE_DONE: return 0
      default: throw failure()
      }
    }
  }

  func rememberValueRevision(_ revision: Int64, key: String) throws {
    guard revision > 0, revision > (try lastValueRevision(key)) else {
      throw WorkspaceRepositoryError.corruptIndex
    }
    try statement(
      "INSERT INTO workspace_value_revisions (key, revision) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision",
      key: key
    ) {
      guard sqlite3_bind_int64($0, 2, revision) == SQLITE_OK,
        sqlite3_step($0) == SQLITE_DONE
      else { throw failure() }
    }
  }

  func nextContentGeneration() throws -> Int64 {
    let previous: Int64 = try read("metadata", keyColumn: "key", key: "content-cache-clock") ?? 0
    guard previous >= 0, previous < Int64.max else { throw WorkspaceRepositoryError.corruptIndex }
    let next = previous + 1
    try put("metadata", keyColumn: "key", key: "content-cache-clock", value: next)
    return next
  }

  func contentKey(_ key: String) throws -> (generation: Int64, pinned: Bool)? {
    try statement("SELECT generation, pinned FROM content_cache_keys WHERE key=?", key: key) {
      switch sqlite3_step($0) {
      case SQLITE_ROW: return (sqlite3_column_int64($0, 0), sqlite3_column_int($0, 1) != 0)
      case SQLITE_DONE: return nil
      default: throw failure()
      }
    }
  }

  func writeContentKey(_ resource: CachedContentResource, generation: Int64, pinned: Bool) throws {
    try statement(
      "INSERT OR REPLACE INTO content_cache_keys (key, generation, pinned, resource) VALUES (?, ?, ?, ?)",
      key: resource.key
    ) {
      try bindContentBlob(JSONEncoder().encode(resource), statement: $0, column: 4)
      guard sqlite3_bind_int64($0, 2, generation) == SQLITE_OK,
        sqlite3_bind_int($0, 3, pinned ? 1 : 0) == SQLITE_OK,
        sqlite3_step($0) == SQLITE_DONE
      else { throw failure() }
    }
  }

  func contentMetadata(_ resource: CachedContentResource) throws -> CachedContentMetadata? {
    guard
      var metadata: CachedContentMetadata = try read(
        "content_cache", keyColumn: "key", key: resource.key)
    else {
      return nil
    }
    guard metadata.resource == resource, let state = try contentKey(resource.key),
      metadata.generation > 0, metadata.generation <= state.generation, metadata.byteCount >= 0
    else { throw WorkspaceContentCacheError.corruptContent }
    metadata.pinned = state.pinned
    return metadata
  }

  func bindContentBlob(_ data: Data, statement: OpaquePointer, column: Int32) throws {
    let status: Int32
    if data.isEmpty {
      status = sqlite3_bind_zeroblob(statement, column, 0)
    } else {
      guard data.count <= Int(Int32.max) else { throw WorkspaceContentCacheError.invalidContent }
      status = data.withUnsafeBytes {
        sqlite3_bind_blob(statement, column, $0.baseAddress, Int32($0.count), Self.transient)
      }
    }
    guard status == SQLITE_OK else { throw failure() }
  }

  func contentBlob(_ statement: OpaquePointer, column: Int32) throws -> Data {
    let count = Int(sqlite3_column_bytes(statement, column))
    if count == 0 { return Data() }
    guard let pointer = sqlite3_column_blob(statement, column) else {
      throw WorkspaceContentCacheError.corruptContent
    }
    return Data(bytes: pointer, count: count)
  }
}
