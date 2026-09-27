import DailyDoListModels
import Foundation

/// Local-only storage controls. The host schedules authenticated bounded reads; no method here
/// starts a network request, queues an agent action or discards protected user work.
public actor WorkspaceStorageMaintenance {
  public nonisolated let scope: WorkspaceScope
  public let budgetBytes: Int
  let store: any WorkspaceStorageControlStore
  let checkpoints: MarkdownCheckpointStore
  let files: any CheckpointFileSystem
  let clock: @Sendable () -> Date

  public init(
    rootDirectory: URL, scope: WorkspaceScope, budgetBytes: Int = 128 * 1_024 * 1_024,
    clock: @escaping @Sendable () -> Date = { Date() }
  ) throws {
    let directory = WorkspaceDirectory.url(root: rootDirectory, scope: scope)
    self.scope = scope
    self.budgetBytes = max(0, budgetBytes)
    self.clock = clock
    store = try SQLiteWorkspaceIndex(
      url: directory.appendingPathComponent("index.sqlite"), scope: scope)
    checkpoints = try MarkdownCheckpointStore(
      directory: directory.appendingPathComponent("markdown"))
    files = FoundationCheckpointFileSystem(directory: checkpoints.directory)
  }

  public init(
    scope: WorkspaceScope, store: any WorkspaceStorageControlStore,
    checkpoints: MarkdownCheckpointStore, files: any CheckpointFileSystem,
    budgetBytes: Int, clock: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.scope = scope
    self.store = store
    self.checkpoints = checkpoints
    self.files = files
    self.budgetBytes = max(0, budgetBytes)
    self.clock = clock
  }

  public func inventory(protecting activePaths: Set<String> = []) throws
    -> WorkspaceStorageInventory
  {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    let snapshot = try store.storageSnapshot()
    let graph = try StorageReferenceGraph(
      snapshot: snapshot, scope: scope, activePaths: activePaths)
    for reference in graph.references { _ = try checkpoints.fileURL(reference) }
    let files = try files.files()
    let sizes = Dictionary(uniqueKeysWithValues: files.map { ($0.reference, $0.bytes) })
    func size(_ references: Set<String>) -> Int { references.reduce(0) { $0 + (sizes[$1] ?? 0) } }
    let documents = snapshot.documents.map { record in
      CachedDocumentEntry(
        path: record.path, revision: record.revision, generation: record.generation,
        state: record.state,
        bytes: size(StorageReferenceGraph.references(record)),
        available: sizes[record.working] != nil && (record.base.map { sizes[$0] != nil } ?? true),
        accessedAt: snapshot.accessedAt[record.path] ?? .distantPast,
        protections: graph.protections[record.path] ?? [])
    }.sorted { $0.path < $1.path }
    let retained = size(graph.references)
    let protected = size(graph.protectedReferences)
    return WorkspaceStorageInventory(
      documents: documents, selections: snapshot.selections, downloads: snapshot.downloads,
      usage: MarkdownStorageUsage(
        checkpointBytes: files.reduce(0) { $0 + $1.bytes }, referencedBytes: retained,
        protectedBytes: protected, cachedBytes: retained - protected,
        orphanBytes: files.filter { !graph.references.contains($0.reference) }.reduce(0) {
          $0 + $1.bytes
        },
        budgetBytes: budgetBytes), unsupportedProtectedRecords: graph.unsupportedProtectedRecords)
  }

  public func setPinned(_ selection: OfflineDownloadSelection, pinned: Bool) throws {
    try store.selectOffline(selection, selected: pinned)
  }

  /// Pass a fresh or explicitly labeled cached tree's markdown paths. Folder selection is
  /// boundary-aware; binary attachments have a separate bounded content cache/transport.
  @discardableResult
  public func requestDownload(
    _ selection: OfflineDownloadSelection, paths: [String],
    maxBytes: Int = DaemonProtocol.attachmentMaxBytes
  ) throws -> [DocumentDownloadRequest] {
    try store.requestDownloads(selection, paths: paths, maxBytes: maxBytes, at: clock())
  }

  public func beginDownload(_ path: String) throws -> DocumentDownloadTicket {
    try store.beginDownload(path, at: clock())
  }

  /// After a guarded repository refresh, verify the exact durable revision before calling the
  /// download complete. A cancelled/replaced ticket, newer edit or missing file fails closed.
  public func completeDownload(_ ticket: DocumentDownloadTicket, expectedRevision: Int64) throws {
    guard ticket.scope == scope else { throw WorkspaceRepositoryError.workspaceMismatch }
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    guard let record = try store.document(ticket.path), record.revision == expectedRevision else {
      throw WorkspaceStorageError.staleDownload
    }
    guard let file = try files.files().first(where: { $0.reference == record.working }) else {
      throw WorkspaceStorageError.unavailableCheckpoint
    }
    guard file.bytes <= ticket.maxBytes else {
      throw WorkspaceStorageError.downloadTooLarge(maxBytes: ticket.maxBytes)
    }
    _ = try checkpoints.read(record.working)
    try store.completeDownload(ticket, document: record, bytes: file.bytes, at: clock())
  }

  public func failDownload(_ ticket: DocumentDownloadTicket, failure: DocumentDownloadFailure)
    throws
  {
    guard ticket.scope == scope else { throw WorkspaceRepositoryError.workspaceMismatch }
    try store.failDownload(ticket, failure: failure, at: clock())
  }

  public func cancelDownload(_ path: String, id: UUID) throws {
    try store.cancelDownload(path, id: id, at: clock())
  }

  /// Evicts index entries only. Call collectGarbage separately to reclaim their unshared files.
  /// Root UI must pass every live editor path, including uncheckpointed clean-to-dirty sessions.
  public func evict(_ paths: Set<String>, protecting activePaths: Set<String> = []) throws
    -> StorageTrimResult
  {
    guard let access = try checkpoints.beginExclusiveAccess() else {
      return StorageTrimResult(
        evictedPaths: [], skippedPaths: paths.sorted(), busy: true, unsupportedProtectedRecords: 0)
    }
    defer { access.release() }
    let snapshot = try store.storageSnapshot()
    let targets = snapshot.documents.filter { paths.contains($0.path) }
    return try store.evictDocuments(
      Dictionary(uniqueKeysWithValues: targets.map { ($0.path, $0.generation) }),
      protecting: activePaths)
  }

  /// Least-recently accessed clean unpinned documents are eligible. Pins and work needed for
  /// reconciliation remain even when they exceed the configured cache budget.
  public func trim(protecting activePaths: Set<String> = []) throws -> StorageTrimResult {
    guard let access = try checkpoints.beginExclusiveAccess() else {
      return StorageTrimResult(
        evictedPaths: [], skippedPaths: [], busy: true, unsupportedProtectedRecords: 0)
    }
    defer { access.release() }
    let snapshot = try store.storageSnapshot()
    let graph = try StorageReferenceGraph(
      snapshot: snapshot, scope: scope, activePaths: activePaths)
    guard graph.unsupportedProtectedRecords == 0 else {
      return StorageTrimResult(
        evictedPaths: [], skippedPaths: [], busy: false,
        unsupportedProtectedRecords: graph.unsupportedProtectedRecords)
    }
    let sizes = Dictionary(uniqueKeysWithValues: try files.files().map { ($0.reference, $0.bytes) })
    var bytes = graph.references.subtracting(graph.protectedReferences).reduce(0) {
      $0 + (sizes[$1] ?? 0)
    }
    var owners: [String: Int] = [:]
    for record in snapshot.documents {
      for reference in StorageReferenceGraph.references(record) {
        owners[reference, default: 0] += 1
      }
    }
    let candidates = snapshot.documents.filter { graph.protections[$0.path]?.isEmpty == true }
      .sorted {
        let first = snapshot.accessedAt[$0.path] ?? .distantPast
        let second = snapshot.accessedAt[$1.path] ?? .distantPast
        return first == second ? $0.path < $1.path : first < second
      }
    var selected: [String: Int64] = [:]
    for record in candidates where bytes > budgetBytes {
      selected[record.path] = record.generation
      for reference in StorageReferenceGraph.references(record) {
        owners[reference, default: 0] -= 1
        if owners[reference] == 0 && !graph.protectedReferences.contains(reference) {
          bytes -= sizes[reference] ?? 0
        }
      }
    }
    return try store.evictDocuments(selected, protecting: activePaths)
  }

  /// Unknown filenames/symlinks are untouched. An interrupted or failed unlink leaves either
  /// the old unused file or a removed unused file; no referenced content changes in either case.
  public func collectGarbage(maximumFiles: Int = 200) throws -> CheckpointCollectionResult {
    guard maximumFiles > 0 else { throw WorkspaceStorageError.invalidLimit }
    guard let access = try checkpoints.beginExclusiveAccess() else {
      return CheckpointCollectionResult(
        removedFiles: 0, removedBytes: 0, remainingOrphanFiles: 0,
        busy: true, unsupportedProtectedRecords: 0)
    }
    defer { access.release() }
    let snapshot = try store.storageSnapshot()
    let graph = try StorageReferenceGraph(snapshot: snapshot, scope: scope, activePaths: [])
    guard graph.unsupportedProtectedRecords == 0 else {
      return CheckpointCollectionResult(
        removedFiles: 0, removedBytes: 0, remainingOrphanFiles: 0,
        busy: false, unsupportedProtectedRecords: graph.unsupportedProtectedRecords)
    }
    for reference in graph.references { _ = try checkpoints.fileURL(reference) }
    let unused = try files.files().filter { !graph.references.contains($0.reference) }
    let selected = unused.prefix(maximumFiles)
    var removed = 0
    var bytes = 0
    for file in selected {
      try Task.checkCancellation()
      try files.remove(file.reference)
      removed += 1
      bytes += file.bytes
    }
    if removed > 0 { try files.synchronize() }
    return CheckpointCollectionResult(
      removedFiles: removed, removedBytes: bytes,
      remainingOrphanFiles: unused.count - removed, busy: false, unsupportedProtectedRecords: 0)
  }
}
