import Foundation
import SQLite3

extension SQLiteWorkspaceIndex {
  func createDocumentHistorySchema() throws {
    try execute(
      """
      CREATE TABLE IF NOT EXISTS document_history (
        path TEXT PRIMARY KEY, revision INTEGER NOT NULL, generation INTEGER NOT NULL
      )
      """)
    try execute(
      """
      CREATE TABLE IF NOT EXISTS document_cache_access (
        path TEXT PRIMARY KEY, accessed_at REAL NOT NULL
      )
      """)
    let documents: [NoteIndexRecord] = try all("documents")
    for document in documents {
      try rememberDocumentHistory(document)
      try statement(
        "INSERT OR IGNORE INTO document_cache_access(path, accessed_at) VALUES (?, 0)",
        key: document.path
      ) { statement in
        guard sqlite3_step(statement) == SQLITE_DONE else { throw failure() }
      }
    }
  }

  public func lastDocumentRevision(_ path: String) throws -> Int64 {
    try locked { try documentHistory(path).revision }
  }

  func documentHistory(_ path: String) throws -> (revision: Int64, generation: Int64) {
    try statement("SELECT revision, generation FROM document_history WHERE path=?", key: path) {
      statement in
      switch sqlite3_step(statement) {
      case SQLITE_ROW:
        return (sqlite3_column_int64(statement, 0), sqlite3_column_int64(statement, 1))
      case SQLITE_DONE: return (0, 0)
      default: throw failure()
      }
    }
  }

  func rememberDocumentHistory(_ record: NoteIndexRecord) throws {
    try statement(
      """
      INSERT INTO document_history(path, revision, generation) VALUES (?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        revision=MAX(revision, excluded.revision), generation=MAX(generation, excluded.generation)
      """, key: record.path
    ) { statement in
      guard sqlite3_bind_int64(statement, 2, record.revision) == SQLITE_OK,
        sqlite3_bind_int64(statement, 3, record.generation) == SQLITE_OK,
        sqlite3_step(statement) == SQLITE_DONE
      else { throw failure() }
    }
  }

  func touchDocument(_ path: String) throws {
    try statement(
      """
      INSERT INTO document_cache_access(path, accessed_at) VALUES (?, ?)
      ON CONFLICT(path) DO UPDATE SET accessed_at=excluded.accessed_at
      """, key: path
    ) { statement in
      guard sqlite3_bind_double(statement, 2, Date().timeIntervalSince1970) == SQLITE_OK,
        sqlite3_step(statement) == SQLITE_DONE
      else { throw failure() }
    }
  }

  func deleteDocument(_ path: String) throws {
    try put("documents", key: path, value: nil as NoteIndexRecord?)
    try statement("DELETE FROM document_cache_access WHERE path=?", key: path) { statement in
      guard sqlite3_step(statement) == SQLITE_DONE else { throw failure() }
    }
    // History outlives cache rows: stale editors and metadata transactions must never pass CAS
    // after eviction, remote deletion, local discard or a structural move away and back.
  }
}
