import DailyDoListClient
import DailyDoListDomain
import DailyDoListDrawing
import DailyDoListEditor
import DailyDoListModels
import DailyDoListUI
import Foundation

/// The drawings notes embed (`![[Plan.excalidraw|360|right-wrap]]`): reads each file once through
/// the daemon, keeps it parsed, saves what's drawn in place (debounced, one write in flight, with
/// the version it was read at), and follows changes made elsewhere (the web app, Obsidian, sync).
///
/// When a save finds the file changed elsewhere (409), or a change arrives while edits are unsaved,
/// the two scenes are merged element by element (`SceneMerge`: newer versions win, both sides'
/// new elements stay) over the version both started from, and the merge is saved on top of theirs:
/// neither side's work is lost. Files are written with the previous file, so everything this app
/// doesn't draw (sections, frontmatter, unknown fields) survives.
@MainActor
final class DrawingStore {
  /// Called when a drawing loaded or changed (the editor asks again): coalesced per main-actor turn.
  var onChange: (@MainActor () -> Void)?
  /// Called after a file was written, with its new content and version (a note tab showing the
  /// same file takes it).
  var onWrite: (@MainActor (NoteResponse) -> Void)?
  /// Called when a save failed for good (after retries it keeps trying; the first failure shows).
  var onError: (@MainActor (String, Error) -> Void)?
  /// Resolves an embed's target (`Plan.excalidraw`) to a vault path; nil when there's no such file.
  var resolve: (@MainActor (String) -> String?)?

  private let client: DaemonClient
  private let scheduler: AppScheduler
  private let saveDelay: TimeInterval
  private let retryDelay: TimeInterval
  private var docs: [String: Doc] = [:]
  private var loading: [String: Task<Void, Never>] = [:]
  /// Paths whose read failed (not found, or not a drawing).
  private var failed: [String: EditorDrawingState] = [:]
  private var changeScheduled = false

  init(
    client: DaemonClient, scheduler: AppScheduler, saveDelay: TimeInterval = 0.5,
    retryDelay: TimeInterval = 2
  ) {
    self.client = client
    self.scheduler = scheduler
    self.saveDelay = saveDelay
    self.retryDelay = retryDelay
  }

  // MARK: - Queries

  func has(_ path: String) -> Bool { docs[path] != nil }

  /// The drawing a target names, as the editor shows it. Starts reading it the first time.
  func state(forTarget target: String) -> EditorDrawingState {
    guard let path = resolve?(target) ?? (DrawingFileName.isDrawingPath(target) ? target : nil)
    else { return .missing }
    return state(forPath: path)
  }

  func state(forPath path: String) -> EditorDrawingState {
    if let doc = docs[path] {
      guard doc.document.readable else { return .unreadable }
      return .ready(EditorDrawing(path: path, scene: doc.scene, contentHash: doc.contentHash))
    }
    if let failure = failed[path] { return failure }
    load(path)
    return .loading
  }

  /// The scene as it is now (local edits included).
  func scene(_ path: String) -> ExcalidrawScene? { docs[path]?.scene }

  /// The parsed file as last read or written.
  func document(_ path: String) -> ExcalidrawMarkdown? { docs[path]?.document }

  func version(_ path: String) -> String? { docs[path]?.version }

  func isDirty(_ path: String) -> Bool {
    guard let doc = docs[path] else { return false }
    return doc.localRev != doc.savedRev
  }

  var hasUnsavedChanges: Bool {
    docs.values.contains { $0.localRev != $0.savedRev || $0.inflight != nil }
  }

  // MARK: - Loading

  /// Reads a drawing (once; later calls while it loads share the read).
  @discardableResult
  func load(_ path: String) -> Task<Void, Never> {
    if let pending = loading[path] { return pending }
    let task = Task { [weak self, client] in
      let result: Result<NoteResponse, Error>
      do {
        result = .success(try await client.readNote(path))
      } catch {
        result = .failure(error)
      }
      guard let self else { return }
      self.loading[path] = nil
      switch result {
      case .success(let note): self.adopt(note)
      case .failure(let error):
        self.failed[path] = NotesStore.isNotFound(error) ? .missing : .unreadable
        self.changed()
      }
    }
    loading[path] = task
    return task
  }

  /// Registers a drawing read or written elsewhere (a new drawing just created). Never replaces
  /// unsaved edits.
  func adopt(_ note: NoteResponse) {
    failed[note.path] = nil
    if let doc = docs[note.path] {
      guard doc.version != note.version, doc.localRev == doc.savedRev, doc.inflight == nil else {
        return
      }
      doc.take(ExcalidrawMarkdown.parse(note.content), version: note.version)
    } else {
      let doc = Doc(
        path: note.path, document: ExcalidrawMarkdown.parse(note.content), version: note.version)
      doc.saveTimer = IdleTimer(scheduler: scheduler, delay: saveDelay) { [weak self, weak doc] in
        if let self, let doc { self.save(doc) }
      }
      docs[note.path] = doc
    }
    changed()
  }

  // MARK: - Editing

  /// A change made in place: kept at once (the editor's previews follow), saved debounced.
  func edit(_ path: String, scene: ExcalidrawScene) {
    guard let doc = docs[path], doc.document.readable else { return }
    doc.scene = scene
    doc.contentHash = DrawingContentHash.hash(scene)
    doc.localRev += 1
    doc.saveTimer?.poke()
  }

  /// Saves pending edits now; the task finishes when they're written (or failed).
  @discardableResult
  func saveNow(_ path: String) -> Task<Void, Never>? {
    docs[path].flatMap { save($0) }
  }

  func flush(_ path: String) async {
    await saveNow(path)?.value
  }

  func flushAll() async {
    for task in docs.values.compactMap({ save($0) }) { await task.value }
  }

  // MARK: - Changes made elsewhere

  /// A `vault.changed` from someone else touched a drawing: read it and show it, merged with
  /// unsaved edits (which are then saved on top of it).
  func handleRemoteChange(_ path: String, version: String? = nil) async {
    if docs[path] == nil {
      if failed.removeValue(forKey: path) != nil { load(path) }
      return
    }
    guard let doc = docs[path] else { return }
    if let version, version == doc.version { return }
    if doc.inflight != nil {
      doc.recheck = true
      return
    }
    let fresh: NoteResponse
    do {
      fresh = try await client.readNote(path)
    } catch {
      if NotesStore.isNotFound(error) { handleRemoteDelete(path) }
      return
    }
    guard docs[path] === doc, fresh.version != doc.version else { return }
    if doc.inflight != nil {
      doc.recheck = true
      return
    }
    let theirs = ExcalidrawMarkdown.parse(fresh.content)
    if doc.localRev == doc.savedRev || !theirs.readable || !doc.document.readable {
      doc.take(theirs, version: fresh.version)
      doc.savedRev = doc.localRev
      changed()
      return
    }
    doc.merge(theirs, version: fresh.version)
    changed()
    save(doc)
  }

  func handleRemoteDelete(_ path: String) {
    guard let doc = docs[path] else { return }
    if doc.localRev != doc.savedRev || doc.inflight != nil { return }
    docs[path] = nil
    failed[path] = .missing
    changed()
  }

  func rename(from: String, to: String) {
    for doc in Array(docs.values) {
      guard let next = NotePaths.renamed(doc.path, from: from, to: to) else { continue }
      docs[doc.path] = nil
      doc.path = next
      docs[next] = doc
    }
    for key in Array(failed.keys) where NotePaths.renamed(key, from: from, to: to) != nil {
      failed[key] = nil
    }
    changed()
  }

  /// A file appeared or went away: forget failed reads so embeds look again.
  func vaultDidChange() {
    guard !failed.isEmpty else { return }
    failed.removeAll()
    changed()
  }

  // MARK: - Saving

  @discardableResult
  private func save(_ doc: Doc) -> Task<Void, Never>? {
    doc.saveTimer?.cancel()
    if let inflight = doc.inflight {
      if doc.localRev == doc.savedRev { return inflight }
      doc.resave = true
      return Task { [weak doc] in
        await inflight.value
        await doc?.inflight?.value
      }
    }
    guard doc.localRev != doc.savedRev, doc.document.readable else { return nil }
    let task = Task { [weak self] in
      guard let self else { return }
      await self.write(doc, depth: 0)
      self.finishWrite(doc)
    }
    doc.inflight = task
    return task
  }

  private func write(_ doc: Doc, depth: Int) async {
    let scene = doc.scene
    let rev = doc.localRev
    let content: String
    do {
      content = try ExcalidrawMarkdown.serialize(scene, previous: doc.document)
    } catch {
      fail(doc, error)
      return
    }
    do {
      let response = try await client.writeNote(
        doc.path, content: content, baseVersion: .match(doc.version))
      acknowledge(doc, scene: scene, content: content, rev: rev, version: response.version)
      onWrite?(
        NoteResponse(
          path: doc.path, content: content, version: response.version, mtime: response.mtime))
    } catch {
      guard docs[doc.path] === doc else { return }
      guard case .conflict(let conflict) = error as? DaemonClientError, depth < 3 else {
        fail(doc, error)
        return
      }
      guard let current = conflict.current else {
        // Deleted elsewhere while we drew: write it back.
        doc.version = ""
        do {
          let response = try await client.writeNote(
            doc.path, content: content, baseVersion: .createOnly)
          acknowledge(doc, scene: scene, content: content, rev: rev, version: response.version)
        } catch {
          fail(doc, error)
        }
        return
      }
      let theirs = ExcalidrawMarkdown.parse(current.content)
      guard theirs.readable else {
        // Their file can't be read: never write over it.
        fail(doc, DrawingStoreError.changedToUnreadable(doc.path))
        return
      }
      doc.merge(theirs, version: current.version)
      changed()
      await write(doc, depth: depth + 1)
    }
  }

  private func acknowledge(
    _ doc: Doc, scene: ExcalidrawScene, content: String, rev: Int, version: String
  ) {
    doc.version = version
    doc.baseScene = scene
    doc.savedRev = max(doc.savedRev, rev)
    doc.failures = 0
    doc.failed = false
  }

  private func finishWrite(_ doc: Doc) {
    doc.inflight = nil
    guard docs[doc.path] === doc else { return }
    if doc.recheck {
      doc.recheck = false
      Task { await self.handleRemoteChange(doc.path) }
    }
    if doc.localRev != doc.savedRev, !doc.failed {
      if doc.resave {
        doc.resave = false
        save(doc)
      } else {
        doc.saveTimer?.schedule()
      }
    }
  }

  private func fail(_ doc: Doc, _ error: Error) {
    guard docs[doc.path] === doc else { return }
    doc.failed = true
    doc.failures += 1
    if doc.failures == 1 { onError?(doc.path, error) }
    let delay = min(30, retryDelay * pow(2, Double(doc.failures - 1)))
    scheduler.schedule(after: delay) { [weak self, weak doc] in
      guard let self, let doc, self.docs[doc.path] === doc, doc.localRev != doc.savedRev else {
        return
      }
      doc.failed = false
      self.save(doc)
    }
  }

  /// Tells the editor once per main-actor turn, however many drawings changed.
  private func changed() {
    guard !changeScheduled else { return }
    changeScheduled = true
    scheduler.schedule(after: 0) { [weak self] in
      guard let self else { return }
      self.changeScheduled = false
      self.onChange?()
    }
  }
}

enum DrawingStoreError: LocalizedError {
  case changedToUnreadable(String)

  var errorDescription: String? {
    switch self {
    case .changedToUnreadable:
      "The drawing was changed elsewhere into something this app can't read, so it wasn't overwritten."
    }
  }
}

/// One drawing file's state (a class: identity tells a reloaded drawing apart).
@MainActor
private final class Doc {
  var path: String
  /// The file as last read (what's written back around the scene).
  var document: ExcalidrawMarkdown
  /// The scene as of `version` on disk: the base of a merge.
  var baseScene: ExcalidrawScene
  /// The scene now, local edits included.
  var scene: ExcalidrawScene
  var contentHash: UInt64
  var version: String
  var localRev = 0
  var savedRev = 0
  /// Saves once the drawing has been left alone for the store's delay.
  var saveTimer: IdleTimer?
  var inflight: Task<Void, Never>?
  var resave = false
  var recheck = false
  var failed = false
  var failures = 0

  init(path: String, document: ExcalidrawMarkdown, version: String) {
    self.path = path
    self.document = document
    baseScene = document.scene
    scene = document.scene
    contentHash = DrawingContentHash.hash(document.scene)
    self.version = version
  }

  /// A newer file with no local edits to keep.
  func take(_ document: ExcalidrawMarkdown, version: String) {
    self.document = document
    baseScene = document.scene
    scene = document.scene
    contentHash = DrawingContentHash.hash(document.scene)
    self.version = version
  }

  /// A newer file while local edits are unsaved: theirs becomes the base, ours are merged in.
  func merge(_ theirs: ExcalidrawMarkdown, version: String) {
    let merged = SceneMerge.merge(base: baseScene, local: scene, remote: theirs.scene)
    document = theirs
    baseScene = theirs.scene
    scene = merged
    contentHash = DrawingContentHash.hash(merged)
    self.version = version
  }
}
