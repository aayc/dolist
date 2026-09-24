import DailyDoListClient
import DailyDoListDomain
import DailyDoListModels
import Foundation
import Observation

/// The vault's file/folder tree. Structural changes rebuild the sorted file list and explorer tree
/// (never per keystroke). Server operations are optimistic: the tree changes immediately and is
/// rolled back if the daemon refuses.
@MainActor
@Observable
final class VaultStore {
  private(set) var vaultName = ""
  private(set) var isLoaded = false
  private(set) var entries: [String: VaultEntry] = [:]
  /// Sorted file paths.
  private(set) var files: [String] = []
  /// Explorer tree (folders first, natural order).
  private(set) var tree: [VaultTreeNode] = []

  @ObservationIgnored let client: DaemonClient

  init(client: DaemonClient) {
    self.client = client
  }

  // MARK: - Queries

  func has(_ path: String) -> Bool { entries[path] != nil }
  func isFolder(_ path: String) -> Bool { entries[path]?.kind == .folder }
  func isFile(_ path: String) -> Bool { entries[path]?.kind == .file }

  /// Files inside `folder` (recursively).
  func files(inside folder: String) -> [String] {
    files.filter { $0.hasPrefix("\(folder)/") }
  }

  // MARK: - Local mutations

  /// Replaces the tree with a snapshot, keeping `known` files that the snapshot may predate.
  func setTree(_ response: VaultTreeResponse, keeping known: [(path: String, version: String?)] = []) {
    var next: [String: VaultEntry] = [:]
    for entry in response.entries where !entry.path.isEmpty && !VaultPath.isHidden(entry.path) {
      next[entry.path] = entry
      Self.addAncestors(of: entry.path, to: &next)
    }
    for (path, version) in known where next[path] == nil && !VaultPath.isHidden(path) {
      next[path] = VaultEntry(path: path, kind: .file, version: version)
      Self.addAncestors(of: path, to: &next)
    }
    vaultName = response.vaultName
    isLoaded = true
    commit(next)
  }

  func addFile(_ path: String, version: String? = nil) {
    guard !VaultPath.isHidden(path), entries[path]?.kind != .file else { return }
    var next = entries
    next[path] = VaultEntry(path: path, kind: .file, version: version)
    Self.addAncestors(of: path, to: &next)
    commit(next)
  }

  func addFolder(_ path: String) {
    guard !path.isEmpty, !VaultPath.isHidden(path), entries[path] == nil else { return }
    var next = entries
    next[path] = VaultEntry(path: path, kind: .folder)
    Self.addAncestors(of: path, to: &next)
    commit(next)
  }

  /// Removes `path` and (for folders) everything inside it; returns what was removed.
  @discardableResult
  func remove(_ path: String) -> [VaultEntry] {
    let removed = entries.values.filter { NotePaths.isSameOrInside($0.path, path) }
    guard !removed.isEmpty else { return [] }
    var next = entries
    for entry in removed { next[entry.path] = nil }
    commit(next)
    return removed
  }

  /// Moves `from` (and everything inside it) to `to`.
  func move(from: String, to: String) {
    guard from != to else { return }
    let moving = entries.values.filter { NotePaths.isSameOrInside($0.path, from) }
    guard !moving.isEmpty else { return }
    var next = entries
    for entry in moving { next[entry.path] = nil }
    for entry in moving {
      guard let target = NotePaths.renamed(entry.path, from: from, to: to) else { continue }
      next[target] = VaultEntry(path: target, kind: entry.kind, size: entry.size, mtime: entry.mtime, version: entry.version)
    }
    Self.addAncestors(of: to, to: &next)
    commit(next)
  }

  func restore(_ removed: [VaultEntry]) {
    guard !removed.isEmpty else { return }
    var next = entries
    for entry in removed {
      next[entry.path] = entry
      Self.addAncestors(of: entry.path, to: &next)
    }
    commit(next)
  }

  // MARK: - Server operations (optimistic)

  /// Creates a note (`baseVersion: null`). Throws `.conflict` (with the existing note) if it exists.
  func createNote(_ path: String, content: String = "") async throws -> WriteNoteResponse {
    let existed = has(path)
    addFile(path)
    do {
      let response = try await client.writeNote(path, content: content, baseVersion: .createOnly)
      if response.path != path {
        remove(path)
        addFile(response.path, version: response.version)
      }
      return response
    } catch {
      if !existed, !Self.isConflict(error) { remove(path) }
      throw error
    }
  }

  func createFolder(_ path: String) async throws {
    let existed = has(path)
    addFolder(path)
    do {
      _ = try await client.createFolder(path)
    } catch {
      if !existed { remove(path) }
      throw error
    }
  }

  func rename(from: String, to: String) async throws -> RenameResponse {
    let before = entries
    let snapshot = before.values.filter { NotePaths.isSameOrInside($0.path, from) }
    move(from: from, to: to)
    do {
      return try await client.rename(from: from, to: to)
    } catch {
      // Undo exactly what the move added (the target and folders it implied), then restore.
      let implied = Set(VaultPath.ancestorFolders(to))
      var next = entries
      for key in next.keys where before[key] == nil && (NotePaths.isSameOrInside(key, to) || implied.contains(key)) {
        next[key] = nil
      }
      for entry in snapshot { next[entry.path] = entry }
      commit(next)
      throw error
    }
  }

  /// Soft delete (the daemon moves it into `.trash/`).
  func delete(_ path: String) async throws -> TrashResponse {
    let wasFolder = isFolder(path)
    let removed = remove(path)
    do {
      return wasFolder ? try await client.deleteFolder(path) : try await client.deleteNote(path)
    } catch {
      restore(removed)
      throw error
    }
  }

  // MARK: - Helpers

  private func commit(_ next: [String: VaultEntry]) {
    entries = next
    files = next.values.filter { $0.kind == .file }.map(\.path).sorted()
    tree = VaultTree.build(next.values)
  }

  private static func addAncestors(of path: String, to entries: inout [String: VaultEntry]) {
    for folder in VaultPath.ancestorFolders(path) where entries[folder] == nil {
      entries[folder] = VaultEntry(path: folder, kind: .folder)
    }
  }

  static func isConflict(_ error: Error) -> Bool {
    if case .conflict = error as? DaemonClientError { return true }
    return false
  }
}
