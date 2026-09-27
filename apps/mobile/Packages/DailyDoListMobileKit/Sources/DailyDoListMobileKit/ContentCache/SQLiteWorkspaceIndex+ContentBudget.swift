import Foundation
import SQLite3

extension SQLiteWorkspaceIndex {
  func contentUsageUnlocked(budgetBytes: Int) throws -> ContentCacheUsage {
    try statement(
      """
      SELECT coalesce(sum(c.byte_count),0),
        coalesce(sum(CASE WHEN k.pinned=1 THEN c.byte_count ELSE 0 END),0), count(*)
      FROM content_cache c JOIN content_cache_keys k ON k.key=c.key
      """
    ) {
      guard sqlite3_step($0) == SQLITE_ROW else { throw failure() }
      return ContentCacheUsage(
        totalBytes: Int(sqlite3_column_int64($0, 0)),
        pinnedBytes: Int(sqlite3_column_int64($0, 1)),
        entryCount: Int(sqlite3_column_int64($0, 2)), budgetBytes: max(0, budgetBytes))
    }
  }

  func trimContentUnlocked(to budget: Int, excluding protected: String? = nil) throws
    -> ContentCacheUsage
  {
    let usage = try contentUsageUnlocked(budgetBytes: budget)
    guard usage.overBudget else { return usage }
    let victims: [(String, Int)] = try statement(
      """
      SELECT c.key, c.byte_count FROM content_cache c JOIN content_cache_keys k ON c.key=k.key
      WHERE k.pinned=0 ORDER BY c.accessed_at, c.key
      """
    ) {
      var keys: [(String, Int)] = []
      while true {
        switch sqlite3_step($0) {
        case SQLITE_ROW:
          guard let key = sqlite3_column_text($0, 0) else { throw failure() }
          let value = String(cString: key)
          if value != protected { keys.append((value, Int(sqlite3_column_int64($0, 1)))) }
        case SQLITE_DONE: return keys
        default: throw failure()
        }
      }
    }
    var remaining = usage.totalBytes
    for (key, bytes) in victims where remaining > budget {
      try deleteCachedContent(key)
      remaining -= bytes
    }
    return try contentUsageUnlocked(budgetBytes: budget)
  }

  func deleteCachedContent(_ key: String) throws {
    // Removing the key also invalidates any pending reply. The global persisted generation
    // clock prevents reuse when a future fetch recreates it, without keeping per-file tombstones.
    for table in ["content_cache", "content_cache_keys"] {
      try statement("DELETE FROM \(table) WHERE key=?", key: key) {
        guard sqlite3_step($0) == SQLITE_DONE else { throw failure() }
      }
    }
  }
}
