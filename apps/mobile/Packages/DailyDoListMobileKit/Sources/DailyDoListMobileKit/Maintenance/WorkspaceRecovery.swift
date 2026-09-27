import Foundation

/// User-invoked export and forget. Neither is part of background sync. The connection owner
/// deletes its profile/Keychain credential only after `forget` succeeds.
public actor WorkspaceRecovery {
  public nonisolated let scope: WorkspaceScope
  let store: any WorkspaceMaintenanceStore
  let checkpoints: any NoteCheckpointStore
  let files: any RecoveryFileSystem
  let checkpointDirectory: URL
  let clock: @Sendable () -> Date

  public init(
    rootDirectory: URL, scope: WorkspaceScope,
    files: any RecoveryFileSystem = FoundationRecoveryFileSystem(),
    clock: @escaping @Sendable () -> Date = { Date() }
  ) throws {
    self.scope = scope
    self.files = files
    self.clock = clock
    let directory = WorkspaceDirectory.url(root: rootDirectory, scope: scope)
    self.checkpointDirectory = directory.appendingPathComponent("markdown")
    self.store = try SQLiteWorkspaceIndex(
      url: directory.appendingPathComponent("index.sqlite"), scope: scope, allowForgotten: true)
    self.checkpoints = try MarkdownCheckpointStore(directory: checkpointDirectory)
  }

  public func summary() throws -> WorkspaceRecoverySummary {
    WorkspaceRecoverySummary(snapshot: try store.recoverySnapshot())
  }

  /// Explicitly discard this local record after the user has chosen to abandon its edits or
  /// exported/copied them. Never deletes remotely; any attempted write must reconcile first.
  public func discardLocalNote(path: String, expectedRevision: Int64) throws {
    try store.discardLocalNote(path: path, expectedRevision: expectedRevision)
  }

  public func export(to parent: URL) throws -> RecoveryExportResult {
    let internalPath = checkpointDirectory.deletingLastPathComponent().resolvingSymlinksInPath()
      .standardizedFileURL.path
    let parentPath = parent.resolvingSymlinksInPath().standardizedFileURL.path
    guard parentPath != internalPath, !parentPath.hasPrefix(internalPath + "/") else {
      throw WorkspaceMaintenanceError.invalidExportDestination
    }
    let snapshot = try store.recoverySnapshot()
    let location = try files.beginExport(in: parent, id: UUID())
    var finished = false
    defer { if !finished { files.abandonExport(location) } }
    var entries: [RecoveryExportEntry] = []
    func append(
      _ text: String, kind: String, path: String? = nil, revision: Int64? = nil,
      baseVersion: String? = nil, context: String? = nil
    ) throws {
      let data = Data(text.utf8)
      let hash = MarkdownCheckpointStore.digest(data)
      let relative =
        "markdown/" + String(format: "%08d", entries.count + 1) + "-" + String(hash.prefix(12))
        + ".md"
      try files.write(data, relativePath: relative, to: location)
      entries.append(
        RecoveryExportEntry(
          kind: kind, sourcePath: path, relativePath: relative, contentHash: hash,
          revision: revision, baseVersion: baseVersion, context: context))
    }
    for record in snapshot.documents.sorted(by: { $0.path < $1.path }) {
      if record.state != .synced {
        try append(
          checkpoints.read(record.working), kind: "working", path: record.path,
          revision: record.revision, baseVersion: record.baseVersion)
        if let base = record.base {
          try append(
            checkpoints.read(base), kind: "base", path: record.path, baseVersion: record.baseVersion
          )
        }
      }
      for copy in record.recoveryCopies {
        try append(checkpoints.read(copy), kind: "recovery", path: record.path)
      }
    }
    for pending in snapshot.pendingWrites {
      if let attempt = pending.attempt {
        try append(
          checkpoints.read(attempt.checkpoint), kind: "attempted-write", path: pending.path,
          revision: attempt.revision, baseVersion: attempt.baseVersion,
          context: attempt.operationID.uuidString)
      }
    }
    var captures: [QueuedCapture] = []
    var operations: [WorkspaceStructuralOperation] = []
    var unsupported = 0
    for value in snapshot.values where value.retention == .durable {
      if value.key.hasPrefix("composer/") {
        let text = try JSONDecoder().decode(String.self, from: value.data)
        if !text.isEmpty {
          try append(text, kind: "composer", revision: value.revision, context: value.key)
        }
      } else if value.key.hasPrefix("capture/") {
        var capture = try JSONDecoder().decode(QueuedCapture.self, from: value.data)
        capture.revision = value.revision
        if capture.state.blocksNoteWrites {
          captures.append(capture)
          try append(
            capture.operation.text, kind: "capture", revision: value.revision,
            context: capture.id.uuidString)
        }
      } else if value.key.hasPrefix("structural/") {
        let operation = try WorkspaceStructuralCoordinator.decode(value, scope: scope)
        if operation.state.unresolved { operations.append(operation) }
        for record in operation.cachedNotes {
          if operation.state.unresolved {
            try append(
              checkpoints.read(record.working), kind: "structural-original", path: record.path,
              revision: record.revision, baseVersion: record.baseVersion,
              context: operation.id.uuidString)
          }
          for copy in record.recoveryCopies {
            try append(checkpoints.read(copy), kind: "recovery", path: record.path)
          }
        }
      } else if value.key != "notifications" {
        unsupported += 1
      }
    }
    let manifest = RecoveryExportManifest(
      formatVersion: 1, scope: scope, createdAt: clock(), entries: entries,
      captures: captures, structuralOperations: operations, unsupportedRecordCount: unsupported)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try files.write(encoder.encode(manifest), relativePath: "manifest.json", to: location)
    let directory = try files.finishExport(location)
    finished = true
    return RecoveryExportResult(directory: directory, manifest: manifest)
  }

  /// Default refusal includes unsent composers and unresolved captures/structural operations.
  /// Pass true only for the user's explicit discard choice, after offering export or sync.
  public func forget(discardUnsyncedWork: Bool = false) throws {
    if try !store.isForgotten() { try store.forget(discardUnsyncedWork: discardUnsyncedWork) }
    try files.removeCheckpoints(at: checkpointDirectory)
  }
}
