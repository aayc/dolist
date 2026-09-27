import Foundation
import SQLite3

/// System SQLite, WAL and FULL synchronization. The lock also makes injected access in tests
/// safe; normal access is serialized by `WorkspaceRepository` on its own actor executor.
public final class SQLiteWorkspaceIndex: WorkspaceIndex, @unchecked Sendable {
  let database: OpaquePointer
  let lock = NSLock()

  public convenience init(url: URL, scope: WorkspaceScope) throws {
    try self.init(url: url, scope: scope, allowForgotten: false)
  }

  /// Only the recovery owner may reopen a retired handle to finish interrupted file cleanup.
  /// All normal reads and transactions still reject the retired namespace.
  init(url: URL, scope: WorkspaceScope, allowForgotten: Bool) throws {
    guard !scope.workspaceID.isEmpty, !scope.hostID.isEmpty else {
      throw WorkspaceRepositoryError.invalidScope
    }
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    var handle: OpaquePointer?
    guard
      sqlite3_open_v2(
        url.path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
        == SQLITE_OK,
      let handle
    else {
      if let handle { sqlite3_close(handle) }
      throw WorkspaceRepositoryError.storage("Cannot open the offline index.")
    }
    database = handle
    do {
      sqlite3_busy_timeout(database, 5_000)
      try execute("PRAGMA journal_mode=WAL")
      try execute("PRAGMA synchronous=FULL")
      try execute("PRAGMA fullfsync=ON")
      let version = try statement("PRAGMA user_version") { statement in
        guard sqlite3_step(statement) == SQLITE_ROW else { throw failure() }
        return Int(sqlite3_column_int(statement, 0))
      }
      guard (0...6).contains(version) else {
        throw WorkspaceRepositoryError.unsupportedIndexVersion(version)
      }
      try execute("BEGIN IMMEDIATE")
      try execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, body BLOB NOT NULL)")
      try execute(
        "CREATE TABLE IF NOT EXISTS documents (path TEXT PRIMARY KEY, body BLOB NOT NULL)")
      try execute("CREATE TABLE IF NOT EXISTS outbox (path TEXT PRIMARY KEY, body BLOB NOT NULL)")
      try execute(
        """
        CREATE TABLE IF NOT EXISTS workspace_values (
          key TEXT PRIMARY KEY, body BLOB NOT NULL,
          blocks_note_writes INTEGER NOT NULL DEFAULT 0,
          revision INTEGER NOT NULL DEFAULT 0, updated_at REAL NOT NULL DEFAULT 0,
          retention TEXT NOT NULL DEFAULT 'durable', byte_count INTEGER NOT NULL DEFAULT 0
        )
        """)
      try execute(
        "CREATE INDEX IF NOT EXISTS pending_capture_barriers ON workspace_values(blocks_note_writes) WHERE blocks_note_writes=1"
      )
      if let stored: WorkspaceScope = try read("metadata", keyColumn: "key", key: "scope") {
        guard stored == scope else { throw WorkspaceRepositoryError.workspaceMismatch }
        let forgotten: Bool? = try read("metadata", keyColumn: "key", key: "forgotten")
        guard forgotten != true || allowForgotten else {
          throw WorkspaceRepositoryError.workspaceForgotten
        }
      } else {
        guard version == 0 else { throw WorkspaceRepositoryError.corruptIndex }
        try put("metadata", keyColumn: "key", key: "scope", value: scope)
      }
      try createContentCacheSchema()
      try createDocumentHistorySchema()
      try createStorageControlSchema()
      // Version 6 prevents older writers from ignoring attachment upload dependencies.
      try execute("PRAGMA user_version=6")
      try execute("COMMIT")
      #if os(iOS)
        for suffix in ["", "-wal", "-shm"] {
          let path = url.path + suffix
          if FileManager.default.fileExists(atPath: path) {
            try FileManager.default.setAttributes(
              [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
              ofItemAtPath: path)
          }
        }
      #endif
    } catch {
      try? execute("ROLLBACK")
      sqlite3_close(database)
      throw error
    }
  }

  deinit { sqlite3_close(database) }

  public func documents() throws -> [NoteIndexRecord] {
    try locked { try all("documents") }
  }

  public func document(_ path: String) throws -> NoteIndexRecord? {
    try locked {
      let record: NoteIndexRecord? = try read("documents", key: path)
      // An optional LRU timestamp must not make an otherwise readable note fail on disk full.
      if record != nil { try? touchDocument(path) }
      return record
    }
  }

  public func outbox() throws -> [NoteOutboxRecord] {
    try locked { try all("outbox") }
  }

  public func pending(_ path: String) throws -> NoteOutboxRecord? {
    try locked { try read("outbox", key: path) }
  }

  public func commit(
    path: String, document: NoteIndexRecord?, pending: NoteOutboxRecord?, expectedGeneration: Int64?
  ) throws {
    try locked {
      guard document?.path == path || document == nil,
        pending?.path == path || pending == nil, pending == nil || document != nil
      else { throw WorkspaceRepositoryError.corruptIndex }
      try beginTransaction()
      do {
        if let attempt = pending?.attempt {
          let old: NoteOutboxRecord? = try read("outbox", key: path)
          if old?.attempt?.operationID != attempt.operationID {
            for path in attempt.requiredDrawings ?? [] {
              let drawing: NoteIndexRecord? = try read("documents", key: path)
              guard WorkspaceDocumentPath.isDrawing(path), let drawing,
                drawing.baseVersion != nil, drawing.acknowledgedRevision > 0,
                drawing.state == .synced || drawing.state == .waitingToSync
              else { throw WorkspaceRepositoryError.pendingDrawingDependencies }
            }
            try requireAcknowledgedAttachments(attempt.requiredAttachments ?? [])
            let blocked: String? = try statement(
              "SELECT key FROM workspace_values WHERE blocks_note_writes=1 LIMIT 1"
            ) { statement in
              switch sqlite3_step(statement) {
              case SQLITE_ROW: return String(cString: sqlite3_column_text(statement, 0))
              case SQLITE_DONE: return nil as String?
              default: throw failure()
              }
            }
            if let blocked {
              throw blocked.hasPrefix("structural/")
                ? WorkspaceRepositoryError.pendingStructuralChange : .pendingCaptures
            }
          }
        }
        let existing: NoteIndexRecord? = try read("documents", key: path)
        guard existing?.generation == expectedGeneration else {
          throw WorkspaceRepositoryError.concurrentWrite
        }
        let history = try documentHistory(path)
        guard history.generation < Int64.max else {
          throw WorkspaceRepositoryError.corruptIndex
        }
        var next = document
        if let next {
          guard next.revision >= history.revision,
            existing != nil || next.revision > history.revision
          else { throw WorkspaceRepositoryError.concurrentWrite }
        }
        next?.generation = history.generation + 1
        if let next {
          try put("documents", key: path, value: next)
          try rememberDocumentHistory(next)
          try touchDocument(path)
        } else {
          try deleteDocument(path)
        }
        try put("outbox", key: path, value: pending)
        try execute("COMMIT")
      } catch {
        try? execute("ROLLBACK")
        throw error
      }
    }
  }

  func writeStoredValue(_ next: WorkspaceStoredValue?, key: String) throws {
    try put("workspace_values", keyColumn: "key", key: key, value: next)
    if let next {
      try rememberValueRevision(next.revision, key: key)
      guard !next.blocksNoteWrites || next.retention == .durable else {
        throw WorkspaceRepositoryError.corruptIndex
      }
      try statement(
        "UPDATE workspace_values SET blocks_note_writes=?, revision=?, updated_at=?, retention=?, byte_count=? WHERE key=?"
      ) { statement in
        guard sqlite3_bind_int(statement, 1, next.blocksNoteWrites ? 1 : 0) == SQLITE_OK,
          sqlite3_bind_int64(statement, 2, next.revision) == SQLITE_OK,
          sqlite3_bind_double(statement, 3, next.updatedAt.timeIntervalSince1970)
            == SQLITE_OK,
          sqlite3_bind_text(statement, 4, next.retention.rawValue, -1, Self.transient)
            == SQLITE_OK,
          sqlite3_bind_int64(statement, 5, Int64(next.byteCount)) == SQLITE_OK,
          sqlite3_bind_text(statement, 6, next.key, -1, Self.transient) == SQLITE_OK,
          sqlite3_step(statement) == SQLITE_DONE
        else { throw failure() }
      }
    }
  }

  /// A retired namespace remains tombstoned so existing handles cannot revive its data.
  public func isForgotten() throws -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let forgotten: Bool? = try read("metadata", keyColumn: "key", key: "forgotten")
    return forgotten == true
  }

  func beginTransaction() throws {
    try execute("BEGIN IMMEDIATE")
    do {
      let forgotten: Bool? = try read("metadata", keyColumn: "key", key: "forgotten")
      guard forgotten != true else { throw WorkspaceRepositoryError.workspaceForgotten }
    } catch {
      try? execute("ROLLBACK")
      throw error
    }
  }

  func hasStructuralBarrier() throws -> Bool {
    try statement(
      "SELECT 1 FROM workspace_values WHERE blocks_note_writes=1 AND instr(key, 'structural/')=1 LIMIT 1"
    ) { statement in
      switch sqlite3_step(statement) {
      case SQLITE_ROW: return true
      case SQLITE_DONE: return false
      default: throw failure()
      }
    }
  }

  func locked<T>(_ action: () throws -> T) throws -> T {
    lock.lock()
    defer { lock.unlock() }
    let forgotten: Bool? = try read("metadata", keyColumn: "key", key: "forgotten")
    guard forgotten != true else { throw WorkspaceRepositoryError.workspaceForgotten }
    return try action()
  }

  func all<Value: Decodable>(_ table: String, keyColumn: String = "path") throws -> [Value] {
    try statement("SELECT body FROM \(table) ORDER BY \(keyColumn)") { statement in
      var result: [Value] = []
      while true {
        switch sqlite3_step(statement) {
        case SQLITE_ROW: result.append(try decode(statement))
        case SQLITE_DONE: return result
        default: throw failure()
        }
      }
    }
  }

  func read<Value: Decodable>(_ table: String, keyColumn: String = "path", key: String)
    throws -> Value?
  {
    try statement("SELECT body FROM \(table) WHERE \(keyColumn)=?", key: key) { statement in
      switch sqlite3_step(statement) {
      case SQLITE_ROW: return try decode(statement)
      case SQLITE_DONE: return nil
      default: throw failure()
      }
    }
  }

  func put<Value: Encodable>(
    _ table: String, keyColumn: String = "path", key: String, value: Value?
  ) throws {
    guard let value else {
      try statement("DELETE FROM \(table) WHERE \(keyColumn)=?", key: key) { statement in
        guard sqlite3_step(statement) == SQLITE_DONE else { throw failure() }
      }
      return
    }
    let body = try JSONEncoder().encode(value)
    try statement("INSERT OR REPLACE INTO \(table) (\(keyColumn), body) VALUES (?, ?)", key: key) {
      statement in
      try body.withUnsafeBytes { buffer in
        guard
          sqlite3_bind_blob(statement, 2, buffer.baseAddress, Int32(buffer.count), Self.transient)
            == SQLITE_OK,
          sqlite3_step(statement) == SQLITE_DONE
        else { throw failure() }
      }
    }
  }

  func decode<Value: Decodable>(_ statement: OpaquePointer) throws -> Value {
    guard let bytes = sqlite3_column_blob(statement, 0) else {
      throw WorkspaceRepositoryError.corruptIndex
    }
    let body = Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, 0)))
    do { return try JSONDecoder().decode(Value.self, from: body) } catch {
      throw WorkspaceRepositoryError.corruptIndex
    }
  }

  func execute(_ sql: String) throws {
    guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else { throw failure() }
  }

  func statement<T>(_ sql: String, key: String? = nil, action: (OpaquePointer) throws -> T)
    throws -> T
  {
    var prepared: OpaquePointer?
    guard sqlite3_prepare_v2(database, sql, -1, &prepared, nil) == SQLITE_OK, let prepared else {
      throw failure()
    }
    defer { sqlite3_finalize(prepared) }
    if let key {
      guard sqlite3_bind_text(prepared, 1, key, -1, Self.transient) == SQLITE_OK else {
        throw failure()
      }
    }
    return try action(prepared)
  }

  func failure() -> WorkspaceRepositoryError {
    // Do not put SQL parameters or note contents into errors/logs.
    .storage("Offline index error \(sqlite3_extended_errcode(database)).")
  }

  static var transient: sqlite3_destructor_type {
    unsafeBitCast(-1, to: sqlite3_destructor_type.self)
  }
}
