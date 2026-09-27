import Foundation
import SQLite3

/// System SQLite, WAL and FULL synchronization. The lock also makes injected access in tests
/// safe; normal access is serialized by `WorkspaceRepository` on its own actor executor.
public final class SQLiteWorkspaceIndex: WorkspaceIndex, @unchecked Sendable {
  private let database: OpaquePointer
  private let lock = NSLock()

  public init(url: URL, scope: WorkspaceScope) throws {
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
      guard (0...2).contains(version) else {
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
      } else {
        guard version == 0 else { throw WorkspaceRepositoryError.corruptIndex }
        try put("metadata", keyColumn: "key", key: "scope", value: scope)
      }
      try execute("PRAGMA user_version=2")
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
    try locked { try read("documents", key: path) }
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
      try execute("BEGIN IMMEDIATE")
      do {
        if let attempt = pending?.attempt {
          let old: NoteOutboxRecord? = try read("outbox", key: path)
          if old?.attempt?.operationID != attempt.operationID {
            let blocked = try statement(
              "SELECT 1 FROM workspace_values WHERE blocks_note_writes=1 LIMIT 1"
            ) { statement in
              switch sqlite3_step(statement) {
              case SQLITE_ROW: return true
              case SQLITE_DONE: return false
              default: throw failure()
              }
            }
            guard !blocked else { throw WorkspaceRepositoryError.pendingCaptures }
          }
        }
        let existing: NoteIndexRecord? = try read("documents", key: path)
        guard existing?.generation == expectedGeneration else {
          throw WorkspaceRepositoryError.concurrentWrite
        }
        guard (expectedGeneration ?? 0) < Int64.max else {
          throw WorkspaceRepositoryError.corruptIndex
        }
        var next = document
        next?.generation = (expectedGeneration ?? 0) + 1
        try put("documents", key: path, value: next)
        try put("outbox", key: path, value: pending)
        try execute("COMMIT")
      } catch {
        try? execute("ROLLBACK")
        throw error
      }
    }
  }

  public func value(_ key: String) throws -> WorkspaceStoredValue? {
    try locked { try read("workspace_values", keyColumn: "key", key: key) }
  }

  public func values(prefix: String) throws -> [WorkspaceStoredValue] {
    try locked {
      try statement(
        "SELECT body FROM workspace_values WHERE instr(key, ?)=1 ORDER BY key", key: prefix
      ) { statement in
        var result: [WorkspaceStoredValue] = []
        while true {
          switch sqlite3_step(statement) {
          case SQLITE_ROW: result.append(try decode(statement))
          case SQLITE_DONE: return result
          default: throw failure()
          }
        }
      }
    }
  }

  public func valueSummaries() throws -> [WorkspaceValueSummary] {
    try locked {
      try statement(
        "SELECT key, revision, updated_at, retention, byte_count, blocks_note_writes FROM workspace_values"
      ) { statement in
        var result: [WorkspaceValueSummary] = []
        while true {
          switch sqlite3_step(statement) {
          case SQLITE_ROW:
            guard let key = sqlite3_column_text(statement, 0),
              let raw = sqlite3_column_text(statement, 3),
              let retention = WorkspaceValueRetention(rawValue: String(cString: raw))
            else { throw WorkspaceRepositoryError.corruptIndex }
            result.append(
              WorkspaceValueSummary(
                key: String(cString: key), revision: sqlite3_column_int64(statement, 1),
                updatedAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 2)),
                retention: retention,
                byteCount: Int(sqlite3_column_int64(statement, 4)),
                blocksNoteWrites: sqlite3_column_int(statement, 5) != 0))
          case SQLITE_DONE: return result
          default: throw failure()
          }
        }
      }
    }
  }

  public func commitValues(_ changes: [WorkspaceValueMutation]) throws {
    try locked {
      guard Set(changes.map(\.key)).count == changes.count else {
        throw WorkspaceRepositoryError.corruptIndex
      }
      try execute("BEGIN IMMEDIATE")
      do {
        if changes.contains(where: \.requiresIdleNoteWrites) {
          let attempts: [NoteOutboxRecord] = try all("outbox")
          guard !attempts.contains(where: { $0.attempt != nil }) else {
            throw WorkspaceRepositoryError.pendingNoteWrites
          }
        }
        for change in changes {
          let old: WorkspaceStoredValue? = try read(
            "workspace_values", keyColumn: "key", key: change.key)
          guard old?.revision == change.expectedRevision else {
            throw WorkspaceRepositoryError.concurrentWrite
          }
          guard change.value?.key == change.key || change.value == nil,
            (change.expectedRevision ?? 0) < Int64.max
          else { throw WorkspaceRepositoryError.corruptIndex }
          var next = change.value
          next?.revision = (change.expectedRevision ?? 0) + 1
          try put("workspace_values", keyColumn: "key", key: change.key, value: next)
          if let next {
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
        try execute("COMMIT")
      } catch {
        try? execute("ROLLBACK")
        throw error
      }
    }
  }

  private func locked<T>(_ action: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try action()
  }

  private func all<Value: Decodable>(_ table: String, keyColumn: String = "path") throws -> [Value]
  {
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

  private func read<Value: Decodable>(_ table: String, keyColumn: String = "path", key: String)
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

  private func put<Value: Encodable>(
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

  private func decode<Value: Decodable>(_ statement: OpaquePointer) throws -> Value {
    guard let bytes = sqlite3_column_blob(statement, 0) else {
      throw WorkspaceRepositoryError.corruptIndex
    }
    let body = Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, 0)))
    do { return try JSONDecoder().decode(Value.self, from: body) } catch {
      throw WorkspaceRepositoryError.corruptIndex
    }
  }

  private func execute(_ sql: String) throws {
    guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else { throw failure() }
  }

  private func statement<T>(_ sql: String, key: String? = nil, action: (OpaquePointer) throws -> T)
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

  private func failure() -> WorkspaceRepositoryError {
    // Do not put SQL parameters or note contents into errors/logs.
    .storage("Offline index error \(sqlite3_extended_errcode(database)).")
  }

  private static var transient: sqlite3_destructor_type {
    unsafeBitCast(-1, to: sqlite3_destructor_type.self)
  }
}
