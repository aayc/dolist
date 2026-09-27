import DailyDoListAgentCore
import DailyDoListClient
import DailyDoListDomain
import DailyDoListDrawingModel
import DailyDoListEditorCore
import DailyDoListMobileKit
import DailyDoListModels
import DailyDoListWorkspaceCore
import Foundation
import Observation

@MainActor @Observable
final class PhoneWorkspace {
  let tabs = TabsStore()
  let rootDirectory: URL
  let structural: WorkspaceStructuralCoordinator
  let recovery: WorkspaceRecovery
  var structuralOperations: [WorkspaceStructuralOperation] = []
  var structuralBusy = false
  let profile: ConnectionProfile
  let repository: WorkspaceRepository
  let drawingRepository: DrawingRepository
  var activeDrawing: DrawingSession?
  var activePath: String? { activeDrawing?.drawing.path ?? active?.note.path }
  @ObservationIgnored var drawingSessions: [String: DrawingSession] = [:]
  let cache: WorkspaceCache
  let composerDrafts: PhoneComposerDrafts
  let captureOutbox: CaptureOutbox
  var settings: AppSettings?
  var entries: [VaultEntry] = []
  var active: NoteSession?
  var agent: AgentStore?
  var captures: [QueuedCapture] = []
  var online = false
  var refreshing = false
  var error: String?
  var selectedTab = 0
  @ObservationIgnored var sessions: [String: NoteSession] = [:]
  @ObservationIgnored var client: HTTPDaemonClient?
  @ObservationIgnored var remote: HTTPWorkspaceRemote?
  @ObservationIgnored var generation: UInt64 = 0
  @ObservationIgnored var navigation: UInt64 = 0
  @ObservationIgnored var synchronization: Task<Void, Never>?
  @ObservationIgnored var synchronizationID: UUID?
  @ObservationIgnored var synchronizeAgain = false
  @ObservationIgnored var hydrated = false
  @ObservationIgnored var savedPositions: [String: WorkspaceNavigation.Position] = [:]
  @ObservationIgnored var navigationDebounce: Task<Void, Never>?
  @ObservationIgnored var savingNavigation: Task<Void, Never>?

  init(
    rootDirectory: URL, structural: WorkspaceStructuralCoordinator, recovery: WorkspaceRecovery,
    profile: ConnectionProfile, repository: WorkspaceRepository,
    drawingRepository: DrawingRepository, cache: WorkspaceCache,
    captureOutbox: CaptureOutbox
  ) {
    self.rootDirectory = rootDirectory
    self.structural = structural
    self.recovery = recovery
    self.profile = profile
    self.repository = repository
    self.drawingRepository = drawingRepository
    self.cache = cache
    self.composerDrafts = PhoneComposerDrafts(cache: cache)
    self.captureOutbox = captureOutbox
    composerDrafts.onError = { [weak self] in self?.error = $0 }
  }

  func hydrate() async {
    guard !hydrated else { return }
    do {
      settings = try await cache.settings()?.value
      let cached = try await repository.notes()
      entries = try await cache.tree()?.value.entries ?? []
      includeLocalNotes(cached)
      includeLocalDrawings(try await drawingRepository.drawings())
      try await restoreNavigation()
      if active == nil, activeDrawing == nil, tabs.active == nil, let first = cached.first {
        show(first)
        tabs.place(first.path)
      }
      structuralOperations = try await structural.unresolved()
      await loadCaptures()
      hydrated = true
    } catch { self.error = error.localizedDescription }
  }

  func connect(_ client: HTTPDaemonClient, serverVersion: String) async {
    generation &+= 1
    let epoch = generation
    self.client = client
    do { remote = try HTTPWorkspaceRemote(client: client, scope: repository.scope) } catch {
      self.error = error.localizedDescription
      return
    }
    online = true
    if agent?.client.clientId != client.clientId {
      do {
        let journal = try MobileAgentMutationJournal(
          rootDirectory: rootDirectory,
          scope: repository.scope,
          remote: HTTPAgentMutationRemote(client: client, scope: repository.scope))
        agent = AgentStore(client: client, mutationJournal: journal)
      } catch {
        self.error = error.localizedDescription
        return
      }
    }
    agent?.handle(.state(.connected(serverVersion: serverVersion)))
    do {
      let settingsRevision = try await cache.settings()?.revision
      let fetchedSettings = try await client.settings()
      guard epoch == generation, online else { return }
      self.settings = fetchedSettings
      configureEditors()
      try await cache.storeSettings(fetchedSettings, replacing: settingsRevision)
      await refreshTree()
      guard epoch == generation, online else { return }
      error = nil
      if active == nil && activeDrawing == nil {
        if let path = tabs.active {
          await open(path, recordHistory: false)
        } else {
          await openToday()
        }
      }
      await synchronize()
      guard epoch == generation, online else { return }
      await agent?.refresh()
    } catch {
      guard epoch == generation else { return }
      self.error = error.localizedDescription
    }
  }

  func suspend() async {
    invalidateAuthority()
    await drawingRepository.invalidateConnection()
    await structural.invalidateConnection()
    await repository.invalidateConnection()
    await captureOutbox.invalidateConnection()
    await checkpointAll(finishComposition: true)
    await composerDrafts.flush()
    await saveNavigation()
  }

  func invalidateAuthority() {
    generation &+= 1
    online = false
    client = nil
    remote = nil
    synchronization?.cancel()
    synchronization = nil
    synchronizationID = nil
    synchronizeAgain = false
    refreshing = false
    agent?.handle(.state(.disconnected))
  }

  func checkpointAll(finishComposition: Bool = false) async {
    for session in Array(drawingSessions.values) {
      if finishComposition { session.controller.finishEditing() }
      await session.checkpoint()
    }
    for session in Array(sessions.values) {
      if finishComposition { session.finishComposition() }
      await session.checkpoint()
    }
  }

  func openToday() async {
    await openDaily(LocalDate(date: Date(), timeZone: .current))
  }

  func open(_ path: String, newTab: Bool = false, recordHistory: Bool = true, line: Int? = nil)
    async
  {
    guard !structuralBusy else { return }
    if DrawingEmbed.isDrawingTarget(path) {
      await openDrawing(path, newTab: newTab, recordHistory: recordHistory)
      return
    }
    activeDrawing?.controller.finishEditing()
    await activeDrawing?.checkpoint()
    activeDrawing = nil
    navigation &+= 1
    let request = navigation
    do {
      await active?.checkpoint()
      guard request == navigation else { return }
      if let session = sessions[path] {
        active = session
      } else if let cached = try await repository.note(path) {
        guard request == navigation else { return }
        show(cached)
      }
      if let remote, online {
        await refresh(path, remote: remote)
        guard request == navigation else { return }
        if let cached = try await repository.note(path) {
          guard request == navigation else { return }
          if let session = sessions[path] { active = session } else { show(cached) }
        }
      } else if active?.note.path != path {
        error = "This note has not been downloaded to this iPhone yet."
      }
      guard active?.note.path == path else { return }
      tabs.place(path, newTab: newTab, recordHistory: recordHistory)
      scheduleNavigationSave()
      if let line { revealLine(line) }
      selectedTab = 0
    } catch { if request == navigation { self.error = error.localizedDescription } }
  }

  func createNote(_ requested: String) async {
    do {
      let path = try VaultPath.validated(VaultPath.ensureMarkdownExtension(requested))
      let note = try await repository.create(path: path, content: "")
      includeLocalNotes([note])
      navigation &+= 1
      show(note)
      tabs.place(note.path)
      scheduleNavigationSave()
      selectedTab = 0
      await synchronize()
    } catch { self.error = error.localizedDescription }
  }

  func refreshTree() async {
    guard let client, online else { return }
    let epoch = generation
    do {
      let revision = try await cache.tree()?.revision
      let tree = try await client.tree()
      guard epoch == generation else { return }
      try await cache.storeTree(tree, replacing: revision)
      guard epoch == generation else { return }
      entries = tree.entries
      includeLocalNotes(try await repository.notes())
      includeLocalDrawings(try await drawingRepository.drawings())
    } catch WorkspaceRepositoryError.concurrentWrite {
      // A newer fetch/event already won. Its snapshot is the one to display.
    } catch { if epoch == generation { self.error = error.localizedDescription } }
  }

  func receive(_ item: DaemonStreamItem) {
    agent?.handle(item)
    if case .state(let state) = item {
      switch state {
      case .connected: break  // Live REST identity must verify before connect grants authority.
      default:
        invalidateAuthority()
        Task {
          await drawingRepository.invalidateConnection()
          await structural.invalidateConnection()
          await repository.invalidateConnection()
          await captureOutbox.invalidateConnection()
        }
        return
      }
    }
    guard case .event(.vaultChanged(let event)) = item, let remote, online else { return }
    let epoch = generation
    Task {
      for change in event.changes {
        guard epoch == generation else { return }
        if drawingSessions[change.path] != nil {
          await refreshDrawing(change.path, remote: remote)
        } else if sessions[change.path] != nil {
          await refresh(change.path, remote: remote)
        }
      }
      guard epoch == generation else { return }
      await refreshTree()
    }
  }

  func synchronize() async {
    if let synchronization {
      synchronizeAgain = true
      await synchronization.value
      return
    }
    guard let remote, online else { return }
    let epoch = generation
    let id = UUID()
    synchronizationID = id
    let task = Task { [self] in
      defer {
        if synchronizationID == id {
          synchronization = nil
          synchronizationID = nil
          refreshing = false
          if synchronizeAgain, online {
            synchronizeAgain = false
            Task { await synchronize() }
          }
        }
      }
      refreshing = true
      do {
        await checkpointAll()
        guard epoch == generation, !Task.isCancelled else { return }
        // Resolve any earlier note attempt before the capture barrier can send an append.
        do { try await syncNotes(remote, epoch: epoch) } catch WorkspaceRepositoryError
          .pendingCaptures
        {}
        let sent = try await captureOutbox.synchronize(with: remote)
        guard epoch == generation, !Task.isCancelled else { return }
        await loadCaptures()
        for capture in sent {
          if let path = capture.receipt?.note?.path { await refresh(path, remote: remote) }
        }
        try await syncNotes(remote, epoch: epoch)
      } catch WorkspaceRepositoryError.pendingCaptures {
        // An indeterminate capture intentionally holds ordinary writes until reviewed.
      } catch {
        guard epoch == generation, !Task.isCancelled else { return }
        self.error = error.localizedDescription
      }
    }
    synchronization = task
    await task.value
  }

  func syncNotes(_ remote: HTTPWorkspaceRemote, epoch: UInt64) async throws {
    let drawings = try await drawingRepository.synchronize(with: remote)
    guard epoch == generation else { return }
    for drawing in drawings { await drawingSessions[drawing.path]?.adopt(drawing) }
    let changed = try await repository.synchronize(with: remote)
    guard epoch == generation else { return }
    for note in changed { await sessions[note.path]?.adopt(note) }
  }

  func refresh(_ path: String, remote: HTTPWorkspaceRemote) async {
    let epoch = generation
    do {
      let existing = sessions[path]
      await existing?.checkpoint()
      let note = try await repository.refresh(path: path, with: remote)
      guard epoch == generation else { return }
      if let note {
        await sessions[path]?.adopt(note)
      } else if let existing, existing.hasUncheckpointedEdits {
        let recovery = try await repository.createRecoveryDraft(
          path: path, content: existing.editor.text)
        existing.adoptRecovery(recovery)
      } else {
        sessions[path] = nil
        if active?.note.path == path {
          active = nil
          error = "This note was removed on the host."
        }
      }
    } catch { if epoch == generation { self.error = error.localizedDescription } }
  }

  func capture(_ text: String) async throws {
    _ = try await captureOutbox.enqueue(text: text, capturedAt: Date(), timeZone: .current)
    await loadCaptures()
    Task { await synchronize() }
  }

  func loadCaptures() async {
    do { captures = try await captureOutbox.captures() } catch {
      self.error = error.localizedDescription
    }
  }

  func cancelCapture(_ capture: QueuedCapture) async {
    do {
      _ = try await captureOutbox.cancel(capture.id, replacing: capture.revision)
      await loadCaptures()
      await synchronize()
    } catch { self.error = error.localizedDescription }
  }

  func includeLocalNotes(_ notes: [LocalNote]) {
    let known = Set(entries.map(\.path))
    entries += notes.filter { !known.contains($0.path) }.map {
      VaultEntry(path: $0.path, kind: .file, version: $0.baseVersion)
    }
    entries.sort { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
  }

  func show(_ note: LocalNote) {
    activeDrawing = nil
    let session = NoteSession(note: note, repository: repository)
    session.onCheckpoint = { [weak self] in Task { await self?.synchronize() } }
    configureEditor(session)
    restorePosition(session)
    sessions[note.path] = session
    active = session
  }
}
