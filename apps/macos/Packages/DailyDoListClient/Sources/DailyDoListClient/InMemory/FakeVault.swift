import DailyDoListModels
import Foundation

/// The vault of the fake daemon, with the semantics of `@ddl/storage`'s `MemoryStorageProvider`
/// (content-hash versions, folders that outlive their files, no file where a folder must be) and
/// the daemon's multi-file operations (`apps/daemon/src/vault-ops.ts`). Paths are canonical;
/// hidden paths (`.trash/…`) are stored but never listed.
struct FakeVault: Sendable {
  struct File: Hashable, Sendable {
    var content: String
    var version: String
    var mtime: EpochMillis
    var size: Int { content.utf8.count }
  }

  struct Move: Hashable, Sendable {
    let from: String
    let to: String
    let version: String
  }

  /// A storage error the daemon doesn't map (it answers 500 `internal_error`).
  struct StorageFailure: Error {}

  private(set) var files: [String: File] = [:]
  private(set) var folders: Set<String> = []

  func file(_ path: String) -> File? { files[path] }

  func isFolder(_ path: String) -> Bool { folders.contains(path) }

  /// Visible folders, then visible files, each in code-point order (like the tree route).
  func entries() -> [VaultEntry] {
    let visibleFolders = folders.filter { !FakeVaultPaths.isHidden($0) }.sorted(by: Self.codePointOrder)
    let visibleFiles = files.keys.filter { !FakeVaultPaths.isHidden($0) }.sorted(by: Self.codePointOrder)
    return visibleFolders.map { VaultEntry(path: $0, kind: .folder) }
      + visibleFiles.compactMap { path in
        files[path].map { VaultEntry(path: path, kind: .file, size: $0.size, mtime: $0.mtime, version: $0.version) }
      }
  }

  var searchableNotes: [FakeVaultSearch.Note] {
    files.map { FakeVaultSearch.Note(path: $0.key, content: $0.value.content, mtime: $0.value.mtime, size: $0.value.size) }
  }

  /// Writes without preconditions (seeding and external edits).
  @discardableResult
  mutating func store(_ path: String, _ content: String, mtime: EpochMillis) -> (file: File, created: Bool) {
    let file = File(content: content, version: ContentHash.version(of: content), mtime: mtime)
    let created = files[path] == nil
    files[path] = file
    for folder in FakeVaultPaths.ancestors(path) { folders.insert(folder) }
    return (file, created)
  }

  enum WriteFailure: Error {
    /// `baseVersion` doesn't match (`current` is the note there now, if any).
    case conflict(current: File?)
    case storage
  }

  /// `StorageProvider.write` with the `ifMatch` precondition of `baseVersion`.
  mutating func write(
    _ path: String, _ content: String, base: BaseVersion, mtime: EpochMillis
  ) throws(WriteFailure) -> (file: File, created: Bool) {
    if folders.contains(path) || !canHoldFile(path) { throw .storage }
    let existing = files[path]
    switch base {
    case .unconditional: break
    case .createOnly: if existing != nil { throw .conflict(current: existing) }
    case .match(let version): if existing?.version != version { throw .conflict(current: existing) }
    }
    return store(path, content, mtime: mtime)
  }

  enum RenameFailure: Error {
    case notFound
    /// The target is taken (`current` is the note there, nil for a folder).
    case conflict(current: File?)
    case storage
  }

  /// Moves a file, keeping its content, version and mtime.
  mutating func rename(_ from: String, to: String) throws(RenameFailure) -> File {
    guard let file = files[from] else { throw .notFound }
    if let existing = files[to] { throw .conflict(current: existing) }
    if folders.contains(to) { throw .conflict(current: nil) }
    if !canHoldFile(to) { throw .storage }
    files[from] = nil
    files[to] = file
    for folder in FakeVaultPaths.ancestors(to) { folders.insert(folder) }
    return file
  }

  /// Permanently removes a file (another program deleting it; the daemon itself only trashes).
  mutating func removeFile(_ path: String) {
    files[path] = nil
  }

  mutating func createFolder(_ path: String) throws(StorageFailure) {
    if folders.contains(path) { return }
    if files[path] != nil || !canHoldFile(path) { throw StorageFailure() }
    for folder in FakeVaultPaths.ancestors(path) + [path] { folders.insert(folder) }
  }

  /// Files under `folder` (any depth), in code-point order.
  func files(under folder: String) -> [String] {
    files.keys.filter { $0.hasPrefix(folder + "/") }.sorted(by: Self.codePointOrder)
  }

  /// Removes `folder`, its subfolders and any files left in them.
  mutating func removeFolderTree(_ folder: String) {
    folders = folders.filter { $0 != folder && !$0.hasPrefix(folder + "/") }
    for path in files(under: folder) { files[path] = nil }
  }

  // MARK: - Daemon operations (vault-ops.ts)

  /// The `attempt`-th `.trash/` candidate for `path`: the same relative path, then with a
  /// ` (YYYY-MM-DD HHmmss)` suffix, then with the suffix and a counter.
  static func trashCandidate(_ path: String, isFolder: Bool, stamp: String, attempt: Int) -> String {
    let target = FakeVaultPaths.trash + "/" + path
    guard attempt > 0 else { return target }
    let suffix = attempt == 1 ? " (\(stamp))" : " (\(stamp) \(attempt))"
    let ext = isFolder ? "" : FakeVaultPaths.extname(target)
    let slash = target.lastIndex(of: "/").map { target.index(after: $0) } ?? target.startIndex
    let name = String(target[slash...].dropLast(ext.count))
    let budget = 255 - suffix.utf8.count - ext.utf8.count
    return String(target[..<slash]) + FakeVaultPaths.truncateUTF8(name, maxBytes: budget) + suffix + ext
  }

  /// `moveNoteToTrash`: the first free candidate.
  mutating func trashNote(_ path: String, stamp: String) throws(StorageFailure) -> Move {
    for attempt in 0..<100 {
      let to = Self.trashCandidate(path, isFolder: false, stamp: stamp, attempt: attempt)
      if files[to] != nil { continue }
      do {
        let file = try rename(path, to: to)
        return Move(from: path, to: to, version: file.version)
      } catch .conflict {
        continue
      } catch {
        throw StorageFailure()
      }
    }
    throw StorageFailure()
  }

  /// `moveFolderToTrash`: the first candidate none of whose destination files exists (an existing
  /// trash folder is merged into, like the daemon does). Returns the moves and the trash folder.
  mutating func trashFolder(_ folder: String, stamp: String) throws(StorageFailure) -> (moves: [Move], trashedTo: String) {
    for attempt in 0..<100 {
      let to = Self.trashCandidate(folder, isFolder: true, stamp: stamp, attempt: attempt)
      guard let plan = planFolderMove(folder, to: to) else { continue }
      return (executeFolderMove(folder, to: to, plan: plan), to)
    }
    throw StorageFailure()
  }

  enum FolderRenameFailure: Error {
    case targetExists
    case targetInsideSource
  }

  /// Renames a folder with everything in it (the daemon's `renameFolder`).
  mutating func renameFolder(_ from: String, to: String) throws(FolderRenameFailure) -> [Move] {
    if from.lowercased() != to.lowercased() && folders.contains(to) { throw .targetExists }
    guard let plan = planFolderMove(from, to: to) else { throw .targetInsideSource }
    return executeFolderMove(from, to: to, plan: plan)
  }

  /// `planFolderMove`: nil when a destination is taken or `to` is inside `from`.
  private func planFolderMove(_ from: String, to: String) -> [(from: String, to: String)]? {
    let fromKey = from.lowercased()
    let toKey = to.lowercased()
    if toKey.hasPrefix(fromKey + "/") || to == from { return nil }
    if toKey == fromKey && folders.contains(to) { return nil }
    for path in FakeVaultPaths.ancestors(to) + [to] where files[path] != nil { return nil }
    let plan = files(under: from).map { (from: $0, to: to + $0.dropFirst(from.count)) }
    if plan.contains(where: { files[$0.to] != nil }) { return nil }
    return plan
  }

  private mutating func executeFolderMove(_ from: String, to: String, plan: [(from: String, to: String)]) -> [Move] {
    var moves: [Move] = []
    for step in plan {
      if let file = try? rename(step.from, to: step.to) {
        moves.append(Move(from: step.from, to: step.to, version: file.version))
      }
    }
    try? createFolder(to)
    removeFolderTree(from)
    return moves
  }

  /// Like a disk: no file may sit where a folder for `path` would have to be.
  private func canHoldFile(_ path: String) -> Bool {
    !FakeVaultPaths.ancestors(path).contains { files[$0] != nil }
  }

  static func codePointOrder(_ a: String, _ b: String) -> Bool {
    a.unicodeScalars.lexicographicallyPrecedes(b.unicodeScalars)
  }
}
