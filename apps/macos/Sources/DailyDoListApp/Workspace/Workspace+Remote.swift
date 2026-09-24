import DailyDoListAgent
import DailyDoListClient
import DailyDoListDomain
import DailyDoListEditor
import DailyDoListModels
import Foundation

extension Workspace {
  // MARK: - Remote vault changes

  /// Applies a `vault.changed` from someone else: the tree updates at once (and is re-fetched,
  /// debounced, for consistency) and open notes refetch — applied to the editor only when they have
  /// no pending local edits. Our own echoes are ignored.
  func handleVaultChanged(_ event: VaultChangedEvent) {
    if let origin = event.clientId, origin == client.clientId { return }
    for change in event.changes where !VaultPath.isHidden(change.path) {
      switch change.kind {
      case .deleted:
        let nested = notes.paths.filter { $0.hasPrefix("\(change.path)/") }
        for path in [change.path] + nested { notes.handleRemoteDelete(path) }
        vault.remove(change.path)
      case .created, .modified:
        if !vault.has(change.path), !VaultPath.extname(change.path).isEmpty {
          vault.addFile(change.path, version: change.version)
        }
        if notes.has(change.path) {
          let path = change.path
          let version = change.version
          Task { await self.notes.handleRemoteChange(path, version: version) }
        }
      }
    }
    treeRefresh.poke()
  }

  func refreshTree() async {
    guard let tree = try? await client.tree() else { return }
    applyTree(tree)
  }

  /// Replaces the tree, keeping notes we know exist (the snapshot may predate a creation).
  func applyTree(_ tree: VaultTreeResponse) {
    vault.setTree(tree, keeping: notes.paths.map { ($0, notes.version($0)) })
  }

  /// After a reconnect events may have been missed: re-validate everything shown. (The agent
  /// store's own `refresh` refetches the records of every note loaded through it.)
  func resync() async {
    await refreshTree()
    for path in notes.paths { await notes.handleRemoteChange(path) }
  }

  // MARK: - Agent records

  /// Fetches a note's task records once (events keep them current afterwards).
  func refreshRecords(_ notePath: String, force: Bool = false) {
    guard let agent, force || !recordNotes.contains(notePath) else { return }
    recordNotes.insert(notePath)
    Task {
      await agent.loadRecords(for: notePath, force: force)
      editor.recordsDidChange(for: notePath)
    }
  }

  /// Stops tracking a note's records (renamed or deleted).
  func forgetRecords(_ notePath: String) {
    recordNotes.remove(notePath)
    agent?.forgetRecords(for: notePath)
  }

  /// "Show in Note" from a thread: opens the note and scrolls to the task's current line (re-resolved
  /// against local edits).
  func revealTask(notePath: String, record: TaskAgentRecord?) async {
    guard await openNote(notePath) else { return }
    guard let record else { return }
    let anchor = TaskAnchor(taskId: record.taskId, text: record.text, line: record.line)
    let line = TaskAnchors.resolve(editor.controller.text, anchors: [anchor])[record.taskId] ?? record.line
    editor.scrollToLine(line)
    editor.focus()
  }

  /// Badge click: open the task's thread (or the inbox until the orchestrator creates one).
  func openTaskThread(_ badge: EditorBadge) {
    let threadId = badge.threadId
      ?? activePath.flatMap { path in agent?.records(for: path).first { $0.taskId == badge.id }?.threadId }
    if let threadId {
      ui.showThread(threadId)
    } else {
      ui.showInbox()
    }
  }
}

// MARK: - NotesStoreDelegate

extension Workspace: NotesStoreDelegate {
  func notesStore(_ store: NotesStore, liveContentOf path: String) -> String? {
    editor.liveText(for: path)
  }

  func notesStore(_ store: NotesStore, applyRemote content: String, to path: String) {
    editor.applyRemote(content, to: path)
  }

  func notesStore(_ store: NotesStore, didSaveConflictCopy copyPath: String, of path: String) {
    vault.addFile(copyPath)
    toasts.show(
      .warning, "“\(VaultPath.stem(path))” changed elsewhere",
      body: "Kept your version. The other version was saved as “\(VaultPath.stem(copyPath))”.",
      actionLabel: "Open", timeout: 10
    ) { [weak self] in
      Task { await self?.openNote(copyPath, OpenOptions(newTab: true)) }
    }
  }

  func notesStore(_ store: NotesStore, noteWasDeletedRemotely path: String, restored: Bool) {
    if restored {
      vault.addFile(path)
      toasts.show(
        .warning, "“\(VaultPath.stem(path))” was deleted elsewhere",
        body: "Your unsaved edits were written back, so the note was restored.")
      return
    }
    let wasOpen = tabs.tabs.contains(path)
    dropNote(path)
    if wasOpen { toasts.show(.info, "“\(VaultPath.stem(path))” was deleted", timeout: 3) }
  }

  func notesStore(_ store: NotesStore, didFailToSave path: String, error: Error) {
    guard errorToasted.insert(path).inserted else { return }
    toasts.show(
      .error, "Couldn't save “\(VaultPath.stem(path))”",
      body: "\(ToastStore.message(for: error)) — retrying automatically.")
  }

  func notesStore(_ store: NotesStore, pathExists path: String) -> Bool {
    vault.has(path)
  }
}

// MARK: - EditorCoordinatorHost

extension Workspace: EditorCoordinatorHost {
  func editorDidEdit(_ path: String) {
    notes.markDirty(path)
    presence.edited(path: path)
  }

  func editorRecords(for path: String) -> [TaskAgentRecord] {
    agent?.records(for: path) ?? []
  }

  func editorDidClickBadge(_ badge: EditorBadge) {
    openTaskThread(badge)
  }

  func editorDidClickWikiLink(_ target: String, newTab: Bool) {
    Task { await openWikiLink(target, newTab: newTab) }
  }

  func editorDidMoveCursor(_ path: String, line: Int) {
    presence.cursorMoved(path: path, line: line)
  }

  func editorDidRequestSave(_ path: String) {
    notes.saveNow(path)
  }
}
