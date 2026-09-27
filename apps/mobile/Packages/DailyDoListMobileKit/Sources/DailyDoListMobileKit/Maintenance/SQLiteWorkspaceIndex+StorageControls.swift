import Foundation
import SQLite3

extension SQLiteWorkspaceIndex: WorkspaceStorageControlStore {
  func createStorageControlSchema() throws {
    try execute(
      "CREATE TABLE IF NOT EXISTS document_download_selections (key TEXT PRIMARY KEY, body BLOB NOT NULL)"
    )
    try execute(
      "CREATE TABLE IF NOT EXISTS document_download_requests (path TEXT PRIMARY KEY, body BLOB NOT NULL)"
    )
  }

  func clearStorageControlState() throws {
    try execute("DELETE FROM document_download_selections")
    try execute("DELETE FROM document_download_requests")
  }

  public func storageSnapshot() throws -> WorkspaceStorageSnapshot {
    try locked { try transaction { try storageSnapshotInTransaction() } }
  }

  func storageSnapshotInTransaction() throws -> WorkspaceStorageSnapshot {
    let accessedAt: [String: Date] = try statement(
      "SELECT path, accessed_at FROM document_cache_access"
    ) { statement in
      var result: [String: Date] = [:]
      while true {
        switch sqlite3_step(statement) {
        case SQLITE_ROW:
          guard let path = sqlite3_column_text(statement, 0) else { throw failure() }
          result[String(cString: path)] = Date(
            timeIntervalSince1970: sqlite3_column_double(statement, 1))
        case SQLITE_DONE: return result
        default: throw failure()
        }
      }
    }
    return try WorkspaceStorageSnapshot(
      documents: all("documents"), pending: all("outbox"),
      values: all("workspace_values", keyColumn: "key"),
      selections: all("document_download_selections", keyColumn: "key"),
      downloads: all("document_download_requests"), accessedAt: accessedAt)
  }

  public func selectOffline(_ selection: OfflineDownloadSelection, selected: Bool) throws {
    try selection.validate()
    try locked {
      try transaction {
        try put(
          "document_download_selections", keyColumn: "key", key: selection.key,
          value: selected ? selection : nil)
      }
    }
  }

  public func requestDownloads(
    _ selection: OfflineDownloadSelection, paths: [String], maxBytes: Int, at: Date
  ) throws -> [DocumentDownloadRequest] {
    try selection.validate()
    guard maxBytes > 0 else { throw WorkspaceStorageError.invalidLimit }
    let selected = Set(paths.filter(selection.contains)).sorted()
    for path in selected { try WorkspaceDocumentPath.validate(path) }
    return try locked {
      try transaction {
        try put(
          "document_download_selections", keyColumn: "key", key: selection.key, value: selection)
        return try selected.map { path in
          let request = DocumentDownloadRequest(
            id: UUID(), path: path, maxBytes: maxBytes, state: .requested,
            requestedAt: at, updatedAt: at)
          try put("document_download_requests", key: path, value: request)
          return request
        }
      }
    }
  }

  public func beginDownload(_ path: String, at: Date) throws -> DocumentDownloadTicket {
    try WorkspaceDocumentPath.validate(path)
    return try locked {
      try transaction {
        guard
          var request: DocumentDownloadRequest = try read("document_download_requests", key: path),
          request.state == .requested,
          let scope: WorkspaceScope = try read("metadata", keyColumn: "key", key: "scope")
        else { throw WorkspaceStorageError.staleDownload }
        request.state = .attempting
        request.updatedAt = at
        try put("document_download_requests", key: path, value: request)
        return DocumentDownloadTicket(
          scope: scope, id: request.id, path: path, maxBytes: request.maxBytes)
      }
    }
  }

  public func completeDownload(
    _ ticket: DocumentDownloadTicket, document: NoteIndexRecord, bytes: Int, at: Date
  ) throws {
    try locked {
      try transaction {
        var request = try requireDownload(ticket)
        let current: NoteIndexRecord? = try read("documents", key: ticket.path)
        guard current?.generation == document.generation,
          current?.revision == document.revision, current?.working == document.working,
          document.path == ticket.path, bytes >= 0, bytes <= ticket.maxBytes
        else { throw WorkspaceStorageError.staleDownload }
        request.state = .available
        request.updatedAt = at
        request.completedBytes = bytes
        request.documentRevision = document.revision
        request.failure = nil
        try put("document_download_requests", key: ticket.path, value: request)
      }
    }
  }

  public func failDownload(
    _ ticket: DocumentDownloadTicket, failure: DocumentDownloadFailure, at: Date
  ) throws {
    try locked {
      try transaction {
        var request = try requireDownload(ticket)
        request.state = .failed
        request.failure = failure
        request.updatedAt = at
        try put("document_download_requests", key: ticket.path, value: request)
      }
    }
  }

  public func cancelDownload(_ path: String, id: UUID, at: Date) throws {
    try locked {
      try transaction {
        guard
          var request: DocumentDownloadRequest = try read("document_download_requests", key: path),
          request.id == id
        else {
          throw WorkspaceStorageError.staleDownload
        }
        request.state = .cancelled
        request.updatedAt = at
        try put("document_download_requests", key: path, value: request)
      }
    }
  }

  public func evictDocuments(_ generations: [String: Int64], protecting activePaths: Set<String>)
    throws -> StorageTrimResult
  {
    try locked {
      try transaction {
        guard let scope: WorkspaceScope = try read("metadata", keyColumn: "key", key: "scope")
        else {
          throw WorkspaceRepositoryError.corruptIndex
        }
        let snapshot = try storageSnapshotInTransaction()
        let graph = try StorageReferenceGraph(
          snapshot: snapshot, scope: scope, activePaths: activePaths)
        guard graph.unsupportedProtectedRecords == 0 else {
          return StorageTrimResult(
            evictedPaths: [], skippedPaths: generations.keys.sorted(), busy: false,
            unsupportedProtectedRecords: graph.unsupportedProtectedRecords)
        }
        let documents = Dictionary(uniqueKeysWithValues: snapshot.documents.map { ($0.path, $0) })
        var evicted: [String] = []
        var skipped: [String] = []
        for path in generations.keys.sorted() {
          guard let record = documents[path], record.generation == generations[path],
            graph.protections[path]?.isEmpty == true
          else {
            skipped.append(path)
            continue
          }
          try deleteDocument(path)
          evicted.append(path)
        }
        return StorageTrimResult(
          evictedPaths: evicted, skippedPaths: skipped, busy: false,
          unsupportedProtectedRecords: 0)
      }
    }
  }

  private func requireDownload(_ ticket: DocumentDownloadTicket) throws -> DocumentDownloadRequest {
    let scope: WorkspaceScope? = try read("metadata", keyColumn: "key", key: "scope")
    guard scope == ticket.scope else { throw WorkspaceRepositoryError.workspaceMismatch }
    guard
      let request: DocumentDownloadRequest = try read(
        "document_download_requests", key: ticket.path),
      request.id == ticket.id, request.state == .attempting, request.maxBytes == ticket.maxBytes
    else { throw WorkspaceStorageError.staleDownload }
    return request
  }
}
