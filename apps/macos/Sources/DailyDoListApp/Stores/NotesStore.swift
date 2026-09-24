import DailyDoListClient
import DailyDoListDomain
import DailyDoListModels
import Foundation
import Observation

/// Owns persistence of open notes: debounced autosave with optimistic concurrency (`baseVersion`),
/// ONE write in flight per note (edits made during a write are coalesced into the next one),
/// conflict resolution and external-change handling — the same algorithm as the web app's
/// `NotesController`. The editor stays the source of truth for live text: content is only read (via
/// the delegate) when a save actually happens, so a keystroke costs O(1) here.
///
/// When someone else (e.g. the agent) changes a note that has unsaved local edits — announced by
/// `vault.changed`, or found by a save's 409 — the two are merged line by line (`TextMerge`, base =
/// the last server version we know). Without a conflict the editor gets only the other side's
/// changes and the merged text is saved on top of their version; a conflict keeps ours and saves
/// theirs as a conflict copy.
@MainActor
@Observable
final class NotesStore {
  /// Save state per open note (drives the status bar and tab dots).
  private(set) var saveStates: [String: SaveState] = [:]

  @ObservationIgnored weak var delegate: NotesStoreDelegate?
  /// Called when a note's save state changes (nil = no longer tracked).
  @ObservationIgnored var onStateChange: (@MainActor (String, SaveState?) -> Void)?
  @ObservationIgnored private let client: DaemonClient
  @ObservationIgnored private let scheduler: AppScheduler
  @ObservationIgnored private let saveDelay: TimeInterval
  @ObservationIgnored private let retryDelay: TimeInterval
  @ObservationIgnored private var docs: [String: NoteDoc] = [:]
  @ObservationIgnored private var loading: [String: Task<Void, Error>] = [:]

  init(client: DaemonClient, scheduler: AppScheduler, saveDelay: TimeInterval = 0.3, retryDelay: TimeInterval = 2) {
    self.client = client
    self.scheduler = scheduler
    self.saveDelay = saveDelay
    self.retryDelay = retryDelay
  }

  // MARK: - Queries

  func has(_ path: String) -> Bool { docs[path] != nil }
  var paths: [String] { Array(docs.keys) }
  func serverContent(_ path: String) -> String? { docs[path]?.serverContent }
  func version(_ path: String) -> String? { docs[path]?.version }
  /// Unsaved local content captured from the editor (nil when clean).
  func pendingContent(_ path: String) -> String? { docs[path]?.pendingContent }

  func isDirty(_ path: String) -> Bool {
    guard let doc = docs[path] else { return false }
    return doc.localRev != doc.savedRev
  }

  /// Dirty or mid-save: must not be evicted or overwritten.
  func isBusy(_ path: String) -> Bool {
    guard let doc = docs[path] else { return false }
    return doc.localRev != doc.savedRev || doc.inflight != nil
  }

  var hasUnsavedChanges: Bool { docs.keys.contains { isBusy($0) } }

  func state(_ path: String) -> NoteState? {
    guard let doc = docs[path] else { return nil }
    let dirty = doc.localRev != doc.savedRev
    let local = dirty ? (delegate?.notesStore(self, liveContentOf: path) ?? doc.pendingContent) : nil
    return NoteState(
      path: path, content: local ?? doc.serverContent, version: doc.version, dirty: dirty,
      saving: doc.inflight != nil, conflict: doc.conflict)
  }

  // MARK: - Loading

  func load(_ path: String) async throws {
    if docs[path] != nil { return }
    if let pending = loading[path] {
      try await pending.value
      return
    }
    let task = Task { [client] in
      let note = try await client.readNote(path)
      self.adopt(note)
    }
    loading[path] = task
    defer { loading[path] = nil }
    try await task.value
  }

  /// Registers a note fetched elsewhere (daily-note endpoint, creation). Never clobbers local edits.
  func adopt(_ note: NoteResponse) {
    guard let doc = docs[note.path] else {
      let doc = NoteDoc(note: note)
      docs[note.path] = doc
      updateStatus(doc)
      return
    }
    if doc.version == note.version || isBusy(note.path) { return }
    doc.serverContent = note.content
    doc.version = note.version
    doc.mtime = note.mtime
    delegate?.notesStore(self, applyRemote: note.content, to: note.path)
  }

  // MARK: - Editing

  /// Called for every local edit. O(1): no content is read here.
  func markDirty(_ path: String) {
    guard let doc = docs[path] else { return }
    doc.localRev += 1
    doc.lastEdit = scheduler.now
    updateStatus(doc)
    arm(doc, delay: saveDelay)
  }

  /// Starts saving `path`'s pending edits right away (capturing the live text synchronously, e.g.
  /// before the editor switches notes). Returns the task to await, if any.
  @discardableResult
  func saveNow(_ path: String) -> Task<Void, Never>? {
    docs[path].flatMap { save($0) }
  }

  /// Saves now (if needed) and waits until the note's pending edits are on disk (or failed).
  func flush(_ path: String) async {
    await saveNow(path)?.value
  }

  func flushAll() async {
    let tasks = docs.values.compactMap { save($0) }
    for task in tasks { await task.value }
  }

  // MARK: - Remote changes

  /// A `vault.changed` from someone else touched `path` (nil version = unknown, recheck).
  func handleRemoteChange(_ path: String, version: String? = nil) async {
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
      if Self.isNotFound(error) { handleRemoteDelete(path) }
      return
    }
    guard docs[path] === doc, fresh.version != doc.version else { return }
    if doc.inflight != nil {
      doc.recheck = true
      return
    }
    if doc.localRev == doc.savedRev {
      doc.serverContent = fresh.content
      doc.version = fresh.version
      doc.mtime = fresh.mtime
      delegate?.notesStore(self, applyRemote: fresh.content, to: path)
      return
    }
    // Local edits pending: merge them with the new version and save the result on top of it.
    if let merged = merge(doc, with: fresh) {
      if Self.same(merged, fresh.content) {
        doc.savedRev = doc.localRev
        doc.pendingContent = nil
        updateStatus(doc)
      } else {
        save(doc)
      }
      return
    }
    // A conflict: the next save gets a 409 and keeps a conflict copy of theirs.
    doc.conflict = true
    updateStatus(doc)
    arm(doc, delay: saveDelay)
  }

  /// Merges the note's live text with `current` (a newer server version) over the last version we
  /// know. Without a conflict `current` becomes the base, the editor gets the merged text (the
  /// delegate applies only the other side's changes) and the merged text is returned; nil on a
  /// conflict, leaving everything as it was.
  private func merge(_ doc: NoteDoc, with current: NoteResponse) -> String? {
    let local = delegate?.notesStore(self, liveContentOf: doc.path) ?? doc.pendingContent ?? doc.serverContent
    let merged = TextMerge.merge(base: doc.serverContent, local: local, remote: current.content)
    guard !merged.conflict else { return nil }
    doc.serverContent = current.content
    doc.version = current.version
    doc.mtime = current.mtime
    doc.conflict = false
    doc.pendingContent = merged.text
    if !Self.same(merged.text, local) { delegate?.notesStore(self, applyMerged: merged.text, to: doc.path) }
    return merged.text
  }

  /// Same text, code unit for code unit (`==` also equates NFC and NFD spellings).
  private static func same(_ a: String, _ b: String) -> Bool {
    a.utf8.elementsEqual(b.utf8)
  }

  func handleRemoteDelete(_ path: String) {
    guard let doc = docs[path] else { return }
    if isBusy(path) {
      doc.conflict = true
      updateStatus(doc)
      arm(doc, delay: saveDelay)
      return
    }
    forget(path)
    delegate?.notesStore(self, noteWasDeletedRemotely: path, restored: false)
  }

  // MARK: - Bookkeeping

  /// Moves bookkeeping after a rename of a note (or of a folder containing notes).
  func rename(from: String, to: String) {
    for doc in Array(docs.values) {
      guard let next = NotePaths.renamed(doc.path, from: from, to: to) else { continue }
      docs[doc.path] = nil
      saveStates[doc.path] = nil
      onStateChange?(doc.path, nil)
      doc.path = next
      doc.status = nil
      docs[next] = doc
      updateStatus(doc)
    }
  }

  func forget(_ path: String) {
    guard let doc = docs[path] else { return }
    doc.timer?.cancel()
    doc.timer = nil
    docs[path] = nil
    saveStates[path] = nil
    onStateChange?(path, nil)
  }

  // MARK: - Saving

  /// One timer per note, re-armed from the last edit time instead of being reset per keystroke.
  private func arm(_ doc: NoteDoc, delay: TimeInterval) {
    guard doc.timer == nil else { return }
    doc.timer = scheduler.schedule(after: delay) { [weak self, weak doc] in
      guard let self, let doc else { return }
      doc.timer = nil
      let idle = self.scheduler.now - doc.lastEdit
      if idle + 1e-9 < self.saveDelay {
        self.arm(doc, delay: self.saveDelay - idle)
        return
      }
      self.save(doc)
    }
  }

  /// Starts a write if the note has unsaved edits. Returns a task that finishes when the edits known
  /// now are persisted (or failed); nil when there is nothing to do.
  @discardableResult
  private func save(_ doc: NoteDoc) -> Task<Void, Never>? {
    doc.timer?.cancel()
    doc.timer = nil
    if let live = delegate?.notesStore(self, liveContentOf: doc.path) { doc.pendingContent = live }
    if let inflight = doc.inflight {
      if doc.localRev == doc.savedRev { return inflight }
      doc.resave = true
      // Settles with the follow-up write that carries these edits (started when this one ends).
      return Task { [weak doc] in
        await inflight.value
        await doc?.inflight?.value
      }
    }
    guard doc.localRev != doc.savedRev else { return nil }
    let content = doc.pendingContent ?? doc.serverContent
    let rev = doc.localRev
    let task = Task { [weak self] in
      guard let self else { return }
      await self.write(doc, content: content, rev: rev, depth: 0)
      self.finishWrite(doc)
    }
    doc.inflight = task
    updateStatus(doc)
    return task
  }

  private func finishWrite(_ doc: NoteDoc) {
    doc.inflight = nil
    guard tracks(doc) else { return }
    updateStatus(doc)
    if doc.recheck {
      doc.recheck = false
      Task { await self.handleRemoteChange(doc.path) }
    }
    if doc.localRev != doc.savedRev, !doc.failed {
      if doc.resave {
        doc.resave = false
        save(doc)
      } else {
        arm(doc, delay: saveDelay)
      }
    }
  }

  private func write(_ doc: NoteDoc, content: String, rev: Int, depth: Int) async {
    do {
      let response = try await client.writeNote(doc.path, content: content, baseVersion: .match(doc.version))
      acknowledge(doc, content: content, rev: rev, version: response.version, mtime: response.mtime)
    } catch {
      // Forgotten meanwhile (deleted, closed): resolving a 409 would recreate a deleted note.
      guard tracks(doc) else { return }
      guard case .conflict(let conflict) = error as? DaemonClientError, depth < 3 else {
        fail(doc, error)
        return
      }
      do {
        try await resolveConflict(doc, content: content, rev: rev, current: conflict.current, depth: depth)
      } catch {
        fail(doc, error)
      }
    }
  }

  private func resolveConflict(_ doc: NoteDoc, content: String, rev: Int, current: NoteResponse?, depth: Int) async throws {
    guard let current else {
      // Deleted elsewhere while we had edits: write them back.
      let response = try await client.writeNote(doc.path, content: content, baseVersion: .createOnly)
      acknowledge(doc, content: content, rev: rev, version: response.version, mtime: response.mtime)
      delegate?.notesStore(self, noteWasDeletedRemotely: doc.path, restored: true)
      return
    }
    if current.content == content {
      acknowledge(doc, content: content, rev: rev, version: current.version, mtime: current.mtime)
      return
    }
    let hasLocalEdits = content != doc.serverContent || doc.localRev != rev
    if !hasLocalEdits {
      // Nothing of ours to keep: take theirs.
      doc.serverContent = current.content
      doc.version = current.version
      doc.mtime = current.mtime
      doc.savedRev = doc.localRev
      doc.pendingContent = nil
      doc.conflict = false
      delegate?.notesStore(self, applyRemote: current.content, to: doc.path)
      return
    }
    // Both changed: merge, and save the merged text on top of theirs (it carries every edit known
    // now).
    if let merged = merge(doc, with: current) {
      let mergedRev = doc.localRev
      if Self.same(merged, current.content) {
        acknowledge(doc, content: merged, rev: mergedRev, version: current.version, mtime: current.mtime)
      } else {
        await write(doc, content: merged, rev: mergedRev, depth: depth + 1)
      }
      return
    }
    // A conflict: keep ours; preserve theirs next to it.
    let copyPath = try await writeConflictCopy(of: doc.path, content: current.content)
    delegate?.notesStore(self, didSaveConflictCopy: copyPath, of: doc.path)
    guard tracks(doc) else { return }
    doc.version = current.version
    await write(doc, content: content, rev: rev, depth: depth + 1)
  }

  private func writeConflictCopy(of path: String, content: String) async throws -> String {
    let folder = VaultPath.dirname(path)
    let base = VaultPath.stem(path)
    for n in 1...20 {
      let name = n == 1 ? "\(base) (conflict).md" : "\(base) (conflict \(n)).md"
      let candidate = folder.isEmpty ? name : "\(folder)/\(name)"
      if delegate?.notesStore(self, pathExists: candidate) == true { continue }
      do {
        _ = try await client.writeNote(candidate, content: content, baseVersion: .createOnly)
        return candidate
      } catch let error as DaemonClientError {
        guard case .conflict = error else { throw error }
      }
    }
    throw NotesStoreError.conflictCopyFailed(path)
  }

  private func acknowledge(_ doc: NoteDoc, content: String, rev: Int, version: String, mtime: EpochMillis) {
    doc.version = version
    doc.mtime = mtime
    doc.serverContent = content
    doc.savedRev = max(doc.savedRev, rev)
    doc.conflict = false
    doc.failed = false
    doc.failures = 0
    if doc.savedRev == doc.localRev { doc.pendingContent = nil }
  }

  /// False once the note was forgotten (or replaced by a reload): late results are dropped.
  private func tracks(_ doc: NoteDoc) -> Bool {
    docs[doc.path] === doc
  }

  private func fail(_ doc: NoteDoc, _ error: Error) {
    guard tracks(doc) else { return }
    doc.failed = true
    doc.failures += 1
    delegate?.notesStore(self, didFailToSave: doc.path, error: error)
    let delay = min(30, retryDelay * pow(2, Double(doc.failures - 1)))
    scheduler.schedule(after: delay) { [weak self, weak doc] in
      guard let self, let doc, self.tracks(doc), doc.localRev != doc.savedRev else { return }
      doc.failed = false
      self.save(doc)
    }
  }

  private func updateStatus(_ doc: NoteDoc) {
    let next: SaveState =
      if doc.conflict { .conflict }
      else if doc.inflight != nil { .saving }
      else if doc.failed { .error }
      else if doc.localRev != doc.savedRev { .dirty }
      else { .saved }
    guard next != doc.status else { return }
    doc.status = next
    saveStates[doc.path] = next
    onStateChange?(doc.path, next)
  }

  static func isNotFound(_ error: Error) -> Bool {
    if case .http(let status, _) = error as? DaemonClientError { return status == 404 }
    return false
  }
}

/// Mutable per-note persistence bookkeeping (a class: identity tells a reloaded note apart).
@MainActor
private final class NoteDoc {
  var path: String
  /// Content as of `version` on the server.
  var serverContent: String
  var version: String
  var mtime: EpochMillis
  /// Incremented per local edit; `savedRev` is the last revision the server acknowledged.
  var localRev = 0
  var savedRev = 0
  /// Local content captured from the editor when a save starts.
  var pendingContent: String?
  var lastEdit: TimeInterval = 0
  var timer: ScheduledAction?
  var inflight: Task<Void, Never>?
  var resave = false
  var recheck = false
  var conflict = false
  var failed = false
  var failures = 0
  var status: SaveState?

  init(note: NoteResponse) {
    path = note.path
    serverContent = note.content
    version = note.version
    mtime = note.mtime
  }
}
