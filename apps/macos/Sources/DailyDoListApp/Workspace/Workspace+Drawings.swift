import AppKit
import DailyDoListClient
import DailyDoListDomain
import DailyDoListDrawing
import DailyDoListEditor
import DailyDoListModels
import Foundation

extension Workspace {
  // MARK: - Wiring

  /// Connects the drawing store to the vault and the editor (called once from `init`).
  func setUpDrawings() {
    drawings.resolve = { [weak self] target in
      guard let self else { return nil }
      return WikiLinks.resolve(NotePaths.wikiLinkTarget(target), in: self.vault.files)
    }
    drawings.onChange = { [weak self] in
      guard let self else { return }
      self.editor.controller.drawingsDidChange()
      self.drawingsDidChange()
    }
    drawings.onWrite = { [weak self] note in
      guard let self, self.notes.has(note.path) else { return }
      self.notes.adopt(note)
    }
    drawings.onError = { [weak self] path, error in
      self?.toasts.show(
        .error, "Couldn't save “\(DrawingFileName.title(fromPath: path))”",
        body: "\(ToastStore.message(for: error)) — retrying automatically.")
    }
  }

  /// Whether a vault path is a drawing file (opened as a drawing, not as text).
  func isDrawing(_ path: String?) -> Bool {
    path.map(DrawingFileName.isDrawingPath) ?? false
  }

  // MARK: - Insert Drawing

  /// Whether Insert Drawing applies: a note (not a drawing) is open in the editor.
  var canInsertDrawing: Bool {
    guard let path = activePath else { return false }
    return !isDrawing(path) && editor.controller.configuration.isEditable
  }

  /// Insert Drawing: creates `Excalidraw/Drawing <date>.excalidraw.md` through the daemon (a
  /// unique name), embeds it at the caret's line floating right, 360 wide (`![[…|360|right-wrap]]`)
  /// and starts editing it in place. Returns the new drawing's path.
  @discardableResult
  func insertDrawing() async -> String? {
    guard canInsertDrawing, let notePath = activePath else { return nil }
    let content = ExcalidrawMarkdown.newFile(for: ExcalidrawScene())
    let name = DrawingFileName.name(at: now())
    var created: WriteNoteResponse?
    for _ in 0..<5 {
      let path = DrawingFileName.uniquePath(forName: name) { vault.has($0) || drawings.has($0) }
      do {
        created = try await vault.createNote(path, content: content)
        break
      } catch DaemonClientError.conflict {
        vault.addFile(path)
      } catch {
        toasts.error("Couldn't create the drawing", error)
        return nil
      }
    }
    guard let created else {
      toasts.show(.error, "Couldn't create the drawing", body: "Every name tried was taken.")
      return nil
    }
    drawings.adopt(
      NoteResponse(
        path: created.path, content: content, version: created.version, mtime: created.mtime))
    guard activePath == notePath else { return created.path }
    let target = Self.linkTarget(forDrawing: created.path, in: vault.files)
    let controller = editor.controller
    guard let line = controller.insertDrawingEmbed(DrawingEmbed.newDrawing(target: target).markdown)
    else { return created.path }
    controller.drawingsDidChange()
    controller.beginEditingDrawing(atLine: line)
    return created.path
  }

  /// How a note links to a drawing, like Obsidian's "shortest path when possible": the file name
  /// without `.md`, or the whole path when another file has the same name.
  static func linkTarget(forDrawing path: String, in paths: [String]) -> String {
    let withoutMd = path.hasSuffix(".md") ? String(path.dropLast(3)) : path
    let name = VaultPath.basename(path).lowercased()
    let clash = paths.contains { $0 != path && VaultPath.basename($0).lowercased() == name }
    return clash ? withoutMd : VaultPath.basename(withoutMd)
  }

  // MARK: - Drawings opened on their own

  /// A drawing open on its own, as its pane shows it (`revision` is what SwiftUI observes).
  func drawingState(forDocument path: String, revision: Int) -> EditorDrawingState {
    drawings.state(forPath: path)
  }

  /// Whether the drawing open on its own shows its Markdown source.
  func showsDrawingSource(_ path: String) -> Bool {
    drawingSourcePaths.contains(path)
  }

  /// Switches a drawing open on its own between the drawing and its Markdown source. Each side
  /// saves before the other shows, so both show the same file.
  func setShowsDrawingSource(_ show: Bool, for path: String) async {
    if show {
      await drawings.flush(path)
      drawingSourcePaths.insert(path)
      if activePath == path { editor.focus() }
    } else {
      await notes.flush(path)
      drawingSourcePaths.remove(path)
      await drawings.handleRemoteChange(path)
    }
  }

  // MARK: - Editor callbacks

  func drawingState(for target: String) -> EditorDrawingState? {
    drawings.state(forTarget: target)
  }

  func drawingWasEdited(_ drawing: EditorDrawing) {
    drawings.edit(drawing.path, scene: drawing.scene)
  }

  func drawingEditingEnded(_ path: String) {
    drawings.saveNow(path)
  }

  /// The editor's context menu gets Insert Drawing (with its shortcut from the command table).
  func addDrawingItems(to menu: NSMenu) {
    guard canInsertDrawing else { return }
    let item = CommandMenuItem(.insertDrawing, title: "Insert Drawing") { [weak self] in
      guard let self else { return }
      Task { await self.insertDrawing() }
    }
    menu.insertItem(item, at: 0)
    menu.insertItem(.separator(), at: 1)
  }

  // MARK: - Vault changes

  /// Drawings among the paths a `vault.changed` touched: reload the open ones, and let embeds of
  /// missing drawings look again when files come and go.
  func handleDrawingChanges(_ event: VaultChangedEvent) {
    var filesCameOrWent = false
    for change in event.changes where DrawingFileName.isDrawingPath(change.path) {
      switch change.kind {
      case .deleted:
        drawings.handleRemoteDelete(change.path)
        filesCameOrWent = true
      case .created, .modified:
        if !drawings.has(change.path) { filesCameOrWent = true }
        let path = change.path
        let version = change.version
        Task { await self.drawings.handleRemoteChange(path, version: version) }
      }
    }
    if filesCameOrWent { drawings.vaultDidChange() }
  }
}
