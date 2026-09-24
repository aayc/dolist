import AppKit
import DailyDoListClient
import DailyDoListDomain
import DailyDoListModels
import Foundation

extension Workspace {
  // MARK: - Create

  /// New note: `name` (may include folders) or a unique "Untitled" whose title gets focus.
  @discardableResult
  func createNote(in folder: String = "", name: String? = nil, newTab: Bool = true) async -> String? {
    if let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
      let path = VaultPath.ensureMarkdownExtension(VaultPath.normalize(folder.isEmpty ? name : "\(folder)/\(name)"))
      if let problem = NotePaths.validateName(VaultPath.stem(path)) {
        toasts.show(.error, "Invalid note name", body: problem)
        return nil
      }
      return await createNote(at: path, newTab: newTab, focusTitle: false)
    }
    let path = NotePaths.uniquePath(folder: folder, base: "Untitled") { vault.has($0) || notes.has($0) }
    return await createNote(at: path, newTab: newTab, focusTitle: true)
  }

  /// Creates `path` (or opens it if it already exists) and shows it.
  @discardableResult
  func createNote(at path: String, content: String = "", newTab: Bool, focusTitle: Bool) async -> String? {
    if vault.isFile(path) {
      await openNote(path, OpenOptions(newTab: newTab))
      return path
    }
    do {
      let response = try await vault.createNote(path, content: content)
      notes.adopt(NoteResponse(path: response.path, content: content, version: response.version, mtime: response.mtime))
      activate(response.path, OpenOptions(newTab: newTab, focusEditor: !focusTitle))
      if focusTitle { ui.titleFocusPath = response.path }
      return response.path
    } catch DaemonClientError.conflict(let conflict) where conflict.current != nil {
      // Someone created it first: show theirs.
      if let current = conflict.current { notes.adopt(current) }
      vault.addFile(path)
      activate(path, OpenOptions(newTab: newTab))
      return path
    } catch {
      toasts.error("Couldn't create the note", error)
      return nil
    }
  }

  @discardableResult
  func createFolder(in parent: String = "") async -> String? {
    let path = NotePaths.uniquePath(folder: parent, base: "Untitled folder", fileExtension: "") { vault.has($0) }
    do {
      try await vault.createFolder(path)
    } catch {
      toasts.error("Couldn't create the folder", error)
      return nil
    }
    if !parent.isEmpty { ui.setExpanded(parent, true) }
    ui.renamingPath = path
    return path
  }

  // MARK: - Rename

  /// "Rename Note…": focuses the title field, or, for a daily note (whose title is its date and
  /// not editable), the note's inline rename field in the file explorer.
  func beginRename(_ path: String) {
    guard DailyNotes.isDailyNote(path, settings: settings.settings.dailyNotes) else {
      ui.titleFocusPath = path
      return
    }
    ui.sidebarVisible = true
    ui.sidebarMode = .files
    ui.expand(VaultTree.ancestors(of: path))
    ui.renamingPath = path
  }

  /// Title rename: changes the note's file stem in place.
  @discardableResult
  func renameNoteTitle(_ path: String, to title: String) async -> Bool {
    if let problem = NotePaths.validateName(title) {
      toasts.show(.error, "Can't rename", body: problem)
      return false
    }
    let folder = VaultPath.dirname(path)
    let leaf = "\(title.trimmingCharacters(in: .whitespacesAndNewlines)).md"
    return await renamePath(path, to: folder.isEmpty ? leaf : "\(folder)/\(leaf)")
  }

  /// Explorer inline rename of a note or folder.
  @discardableResult
  func renameEntry(_ path: String, to name: String) async -> Bool {
    if let problem = NotePaths.validateName(name) {
      toasts.show(.error, "Can't rename", body: problem)
      return false
    }
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    let leaf = vault.isFolder(path) ? trimmed : VaultPath.ensureMarkdownExtension(trimmed)
    let folder = VaultPath.dirname(path)
    return await renamePath(path, to: folder.isEmpty ? leaf : "\(folder)/\(leaf)")
  }

  @discardableResult
  func renamePath(_ from: String, to: String) async -> Bool {
    guard from != to else { return true }
    if vault.has(to) {
      toasts.show(.error, "Can't rename", body: "“\(VaultPath.basename(to))” already exists")
      return false
    }
    let affected = notes.paths.filter { NotePaths.isSameOrInside($0, from) }
    for path in affected { await notes.flush(path) }
    do {
      _ = try await vault.rename(from: from, to: to)
    } catch {
      toasts.error("Couldn't rename", error)
      return false
    }
    notes.rename(from: from, to: to)
    editor.rename(from: from, to: to)
    tabs.rename(from: from, to: to)
    renameRecent(from: from, to: to)
    ui.renameExpandedFolders(from: from, to: to)
    for path in affected { forgetRecords(path) }
    if let active = activePath {
      refreshRecords(active, force: true)
      editor.recomputeBadges()
    }
    onTabsChanged?()
    return true
  }

  // MARK: - Delete

  /// Asks for confirmation (the window shows a dialog), then soft-deletes.
  func requestDelete(_ path: String) {
    ui.pendingDeletion = PendingDeletion(path: path, isFolder: vault.isFolder(path))
  }

  /// Soft delete: the daemon moves it into the vault's `.trash/`.
  @discardableResult
  func deletePath(_ path: String) async -> Bool {
    let isFolder = vault.isFolder(path)
    let affected = isFolder
      ? Set(vault.files(inside: path) + notes.paths.filter { $0.hasPrefix("\(path)/") })
      : [path]
    do {
      _ = try await vault.delete(path)
    } catch {
      toasts.error("Couldn't delete “\(NotePaths.displayName(path, isFolder: isFolder))”", error)
      return false
    }
    for note in affected { dropNote(note) }
    return true
  }

  /// Removes a note that no longer exists from every cache and tab (without saving it).
  func dropNote(_ path: String) {
    notes.forget(path)
    editor.forget(path)
    forgetRecords(path)
    dropRecent(path)
    closeTab(path)
    tabs.purge(path)
  }

  // MARK: - Finder

  func revealInFinder(_ path: String) {
    guard let url = localURL(for: path) else { return }
    NSWorkspace.shared.activateFileViewerSelecting([url])
  }

  func localURL(for path: String) -> URL? {
    guard let root = localVaultURL else { return nil }
    return path.isEmpty ? root : root.appendingPathComponent(path)
  }
}
