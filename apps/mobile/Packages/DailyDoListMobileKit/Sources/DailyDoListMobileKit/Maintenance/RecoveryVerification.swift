import CryptoKit
import Darwin
import Foundation

extension WorkspaceRecoverySnapshot {
  func fingerprint(scope: WorkspaceScope) throws -> String {
    struct Snapshot: Encodable {
      let scope: WorkspaceScope
      let documents: [NoteIndexRecord]
      let pendingWrites: [NoteOutboxRecord]
      let values: [WorkspaceStoredValue]
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(
      Snapshot(
        scope: scope,
        documents: documents.sorted { $0.path.utf8.lexicographicallyPrecedes($1.path.utf8) },
        pendingWrites: pendingWrites.sorted {
          $0.path.utf8.lexicographicallyPrecedes($1.path.utf8)
        },
        values: values.sorted { $0.key.utf8.lexicographicallyPrecedes($1.key.utf8) }))
    return MarkdownCheckpointStore.digest(data)
  }
}

extension WorkspaceRecovery {
  /// Call with the completed destination from the document picker's delegate, never merely
  /// because its sheet closed. A cancelled or partial Files export cannot grant this proof.
  public func verifyExport(_ exported: RecoveryExportResult, at copiedDirectory: URL) throws
    -> VerifiedRecoveryExport
  {
    guard exported.manifest.scope == scope else { throw WorkspaceRepositoryError.workspaceMismatch }
    guard exported.manifest.unsupportedRecordCount == 0 else {
      throw WorkspaceMaintenanceError.incompleteExport
    }
    let proof = VerifiedRecoveryExport(directory: copiedDirectory, exported: exported)
    try verifyCopy(proof)
    return proof
  }

  public func forget(afterExport proof: VerifiedRecoveryExport) throws {
    guard proof.scope == scope else { throw WorkspaceRepositoryError.workspaceMismatch }
    try verifyCopy(proof)
    let checkpointStore = try MarkdownCheckpointStore(directory: checkpointDirectory)
    let access = try checkpointStore.beginExclusiveAccess(wait: true)
    defer { access?.release() }
    if try !store.isForgotten() {
      // BEGIN IMMEDIATE covers fingerprint comparison and retirement. A second SQLite handle
      // (including Siri capture) either commits first and invalidates this export or is fenced.
      try store.forget(
        expectedFingerprint: proof.exported.manifest.snapshotFingerprint, scope: scope)
    }
    try files.removeCheckpoints(at: checkpointDirectory)
  }

  private func verifyCopy(_ proof: VerifiedRecoveryExport) throws {
    let directory = proof.directory
    guard directory.isFileURL else { throw WorkspaceMaintenanceError.invalidExportDestination }
    let access = directory.startAccessingSecurityScopedResource()
    defer { if access { directory.stopAccessingSecurityScopedResource() } }
    let path = directory.resolvingSymlinksInPath().standardizedFileURL.path
    let internalPath = checkpointDirectory.deletingLastPathComponent().resolvingSymlinksInPath()
      .standardizedFileURL.path
    let originalPath = proof.exported.directory.resolvingSymlinksInPath().standardizedFileURL.path
    guard path != originalPath, path != internalPath, !path.hasPrefix(internalPath + "/") else {
      throw WorkspaceMaintenanceError.invalidExportDestination
    }
    try requireDirectory(directory)
    try requireDirectory(directory.appendingPathComponent("markdown"))
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let manifestBytes = try encoder.encode(proof.exported.manifest).count
    try verifyFile(
      directory.appendingPathComponent("manifest.json"),
      byteCount: manifestBytes, hash: proof.exported.manifestHash)
    for entry in proof.exported.manifest.entries {
      try verifyFile(
        directory.appendingPathComponent(entry.relativePath),
        byteCount: entry.byteCount, hash: entry.contentHash)
    }
  }

  private func requireDirectory(_ url: URL) throws {
    let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    guard values.isDirectory == true, values.isSymbolicLink != true else {
      throw WorkspaceMaintenanceError.invalidExport
    }
  }

  private func verifyFile(_ url: URL, byteCount: Int, hash: String) throws {
    let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw WorkspaceMaintenanceError.invalidExport }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? handle.close() }
    var info = stat()
    guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
      info.st_size == byteCount
    else { throw WorkspaceMaintenanceError.invalidExport }
    var digest = SHA256()
    var count = 0
    while let data = try handle.read(upToCount: 65_536), !data.isEmpty {
      count += data.count
      guard count <= byteCount else { throw WorkspaceMaintenanceError.invalidExport }
      digest.update(data: data)
    }
    guard count == byteCount,
      digest.finalize().map({ String(format: "%02x", $0) }).joined() == hash
    else {
      throw WorkspaceMaintenanceError.invalidExport
    }
  }
}

extension WorkspaceMaintenanceError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .incompleteExport:
      "Some protected records use an unsupported format. Keep this connection until they can be recovered."
    case .invalidExport:
      "The exported folder is missing files or its contents changed. Export a new copy before forgetting."
    case .exportChanged:
      "New local work was saved after this export. Export a fresh copy before forgetting."
    case .invalidExportDestination:
      "Save the recovery folder to a separate location in Files."
    case .unsyncedWork:
      "This connection has protected local work. Export and verify it before forgetting."
    case .dirtyAffectedNotes: "Save or review affected local notes first."
    case .destinationCollision: "A note already exists at this destination."
    case .missingOperation: "The original operation is no longer available."
    case .operationAlreadyResolved: "This operation was already reviewed."
    case .invalidStructuralAction: "This move or deletion is not valid."
    }
  }
}
