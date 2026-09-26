import DailyDoListAgent
import DailyDoListClient
import DailyDoListDomain
import DailyDoListEditor
import DailyDoListModels
import DailyDoListVim
import Foundation
import Observation

/// How a note should be opened.
struct OpenOptions: Sendable {
  /// Open in a new tab instead of replacing the active tab's note.
  var newTab = false
  /// 0-based line to scroll to.
  var line: Int?
  var focusEditor = true
  /// False for Back/Forward (they walk the history instead of extending it).
  var recordHistory = true
}

/// The note-side application controller (the native counterpart of the web app's `Workspace`):
/// tabs and history, daily/weekly notes, create/rename/delete, remote changes and resync. Stores
/// hold state; this type sequences them and drives the editor imperatively.
@MainActor
@Observable
final class Workspace {
  static let maxCachedNotes = 24

  @ObservationIgnored let client: DaemonClient
  let vault: VaultStore
  let notes: NotesStore
  let tabs: TabsStore
  let editor: EditorCoordinator
  let settings: SettingsStore
  let ui: UIState
  let search: SearchModel
  /// The drawings notes embed, and drawings opened on their own.
  @ObservationIgnored let drawings: DrawingStore
  /// Bumped whenever a drawing loaded or changed (a drawing open on its own redraws).
  private(set) var drawingsRevision = 0
  /// Drawings open on their own that show their Markdown source instead of the drawing.
  var drawingSourcePaths: Set<String> = []
  /// What the orchestrator is doing (chips on the lines that woke it, header, status bar).
  let orchestrator: OrchestratorActivityStore
  @ObservationIgnored let toasts: ToastStore
  @ObservationIgnored weak var agent: AgentStore?
  @ObservationIgnored let scheduler: AppScheduler
  /// Wall clock ("today" for daily notes); injectable for tests.
  @ObservationIgnored let now: () -> Date
  /// Local vault folder when known (Reveal in Finder).
  var localVaultURL: URL?

  /// Most recently used notes, newest first (quick switcher, cache eviction).
  private(set) var recent: [String] = []
  /// Called after tabs change (persist them).
  @ObservationIgnored var onTabsChanged: (@MainActor () -> Void)?
  /// Runs an app command by id (vim's `:obcommand`); false when there's no such command.
  @ObservationIgnored var commandRunner: (@MainActor (String) -> Bool)?
  /// Opens the orchestrator's chat at a turn (its first message's id; nil: at the end).
  @ObservationIgnored var openOrchestratorTurn: (@MainActor (String?) -> Void)?

  @ObservationIgnored var navToken = 0
  /// Where the latest navigation is going while its note loads.
  @ObservationIgnored var navTarget: String?
  @ObservationIgnored var recordNotes: Set<String> = []
  @ObservationIgnored var errorToasted: Set<String> = []
  @ObservationIgnored var treeRefresh: IdleTimer!
  @ObservationIgnored var presence: PresenceReporter!
  /// Hover previews of `[[wikilinks]]` (editor tooltips, thread cards).
  @ObservationIgnored var notePreviews: NotePreviewCache!
  /// Threads loaded for the sources of a link preview (each at most once).
  @ObservationIgnored var previewThreadLoads: Set<String> = []

  init(
    client: DaemonClient, settings: SettingsStore, ui: UIState, toasts: ToastStore,
    scheduler: AppScheduler, editorController: MarkdownEditorController? = nil, vim: Vim? = nil,
    now: @escaping () -> Date = Date.init
  ) {
    self.client = client
    self.settings = settings
    self.ui = ui
    self.toasts = toasts
    self.scheduler = scheduler
    self.now = now
    vault = VaultStore(client: client)
    notes = NotesStore(client: client, scheduler: scheduler)
    tabs = TabsStore()
    search = SearchModel(client: client, scheduler: scheduler)
    drawings = DrawingStore(client: client, scheduler: scheduler)
    orchestrator = OrchestratorActivityStore(scheduler: scheduler)
    editor = EditorCoordinator(controller: editorController, scheduler: scheduler)
    treeRefresh = IdleTimer(scheduler: scheduler, delay: 0.3) { [weak self] in
      guard let self else { return }
      Task { await self.refreshTree() }
    }
    presence = PresenceReporter(scheduler: scheduler) { [client] path, line in
      Task { await client.send(.editorActivity(notePath: path, line: line)) }
    }
    notePreviews = NotePreviewCache(
      resolve: { [weak self] target in self?.resolveWikiLink(target) },
      loadedContent: { [weak self] path in
        guard let self, self.notes.has(path) else { return nil }
        return self.editor.liveText(for: path) ?? self.content(of: path)
      },
      read: { [client] path in try await client.readNote(path).content })
    notes.delegate = self
    notes.onStateChange = { [weak self] path, state in
      if state == .saved { self?.errorToasted.remove(path) }
    }
    editor.host = self
    setUpDrawings()
    orchestrator.onChipsChanged = { [weak self] notes in self?.editor.chipsDidChange(for: notes) }
    editor.controller.vim = vim
    editor.configure(settings.settings.editor)
  }

  func drawingsDidChange() {
    drawingsRevision += 1
  }

  var activePath: String? { tabs.active }

  // MARK: - Navigation bookkeeping

  /// Starts a navigation, superseding any still loading. `target`: where it is going.
  func beginNavigation(_ target: String?) -> Int {
    navTarget = target
    navToken += 1
    return navToken
  }

  func endNavigation(_ token: Int) {
    if token == navToken { navTarget = nil }
  }

  // MARK: - Opening notes

  @discardableResult
  func openNote(_ path: String, _ options: OpenOptions = OpenOptions()) async -> Bool {
    let token = beginNavigation(path)
    if !notes.has(path) {
      do {
        try await notes.load(path)
      } catch {
        if token == navToken { toasts.error("Couldn't open “\(VaultPath.stem(path))”", error) }
        endNavigation(token)
        return false
      }
      guard token == navToken else { return false }
    }
    endNavigation(token)
    activate(path, options)
    return true
  }

  /// Synchronous switch to an already-loaded note.
  func activate(_ path: String, _ options: OpenOptions = OpenOptions()) {
    switchEditor(to: path) {
      tabs.place(path, newTab: options.newTab, recordHistory: options.recordHistory)
    }
    afterActivate(path, options)
  }

  /// Tab click: wins over a note still loading from an earlier navigation.
  func activateTab(_ path: String) {
    _ = beginNavigation(nil)
    guard tabs.active != path else { return }
    activate(path)
  }

  func closeTab(_ path: String) {
    guard tabs.tabs.contains(path) else { return }
    notes.saveNow(path)
    let wasActive = tabs.active == path
    let next = tabs.close(path)
    if wasActive {
      editor.show(
        next, content: next.flatMap(content(of:)), caretAtEnd: next.map(isDailyNote) ?? false)
      if let next { afterActivate(next, OpenOptions()) } else { onNoActiveNote() }
    }
    onTabsChanged?()
  }

  func closeActiveTab() {
    if let active = tabs.active { closeTab(active) }
  }

  /// vim's `:qa`: closes every tab, the last one first.
  func closeAllTabs() {
    for path in tabs.tabs.reversed() { closeTab(path) }
  }

  /// vim's `gt`/`gT`, `:tabnext 3`: the tab `delta` tabs away (wrapping around) or at `index`.
  func switchTab(_ to: EditorTabSwitch) {
    let list = tabs.tabs
    guard !list.isEmpty else { return }
    let current = tabs.active.flatMap { list.firstIndex(of: $0) } ?? 0
    let index: Int
    switch to {
    case .delta(let delta): index = ((current + delta) % list.count + list.count) % list.count
    case .index(let target): index = target
    }
    guard list.indices.contains(index) else { return }
    activateTab(list[index])
  }

  func closeOtherTabs(except path: String) {
    for other in tabs.tabs where other != path { closeTab(other) }
  }

  func reopenClosedTab() async {
    guard let closed = tabs.popClosedTab(isValid: { vault.isFile($0) || notes.has($0) }) else {
      return
    }
    if !notes.has(closed.path) {
      do {
        try await notes.load(closed.path)
      } catch {
        toasts.error("Couldn't reopen “\(VaultPath.stem(closed.path))”", error)
        return
      }
    }
    switchEditor(to: closed.path) { tabs.reinsert(closed) }
    afterActivate(closed.path, OpenOptions())
  }

  func goBack() async {
    guard let target = tabs.popBack(isValid: { vault.isFile($0) || notes.has($0) }) else { return }
    await openNote(target, OpenOptions(recordHistory: false))
  }

  func goForward() async {
    guard let target = tabs.popForward(isValid: { vault.isFile($0) || notes.has($0) }) else {
      return
    }
    await openNote(target, OpenOptions(recordHistory: false))
  }

  func selectTab(number: Int) {
    if let path = tabs.tab(forShortcut: number) { activateTab(path) }
  }

  func selectAdjacentTab(_ offset: Int) {
    if let path = tabs.adjacentTab(offset) { activateTab(path) }
  }

  /// Opens a `[[wikilink]]` target like Obsidian (exact path, else shortest matching stem), creating
  /// `<target>.md` when nothing matches.
  func openWikiLink(_ rawTarget: String, newTab: Bool) async {
    let target = NotePaths.wikiLinkTarget(rawTarget)
    if let resolved = WikiLinks.resolve(target, in: vault.files) {
      await openNote(resolved, OpenOptions(newTab: newTab))
      return
    }
    let normalized = VaultPath.normalize(target)
    guard !normalized.isEmpty, NotePaths.validateName(VaultPath.basename(normalized)) == nil else {
      toasts.show(.error, "Invalid link target", body: rawTarget)
      return
    }
    await createNote(
      at: VaultPath.ensureMarkdownExtension(normalized), newTab: newTab, focusTitle: false)
  }

  /// Restores last session's tabs (existing notes only), loading them in parallel. `showActive`
  /// false leaves the editor alone (another note is about to be shown).
  func restoreTabs(_ paths: [String], active: String?, showActive: Bool = true) async {
    let existing = paths.filter { vault.isFile($0) }
    guard !existing.isEmpty else { return }
    let loads = existing.filter { !notes.has($0) }.map { path in
      Task { try? await notes.load(path) }
    }
    for load in loads { await load.value }
    let loaded = existing.filter { notes.has($0) }
    guard !loaded.isEmpty else { return }
    let target = active.flatMap { loaded.contains($0) ? $0 : nil } ?? loaded[0]
    if showActive {
      switchEditor(to: target) { tabs.restore(tabs: loaded, active: target) }
      afterActivate(target, OpenOptions(focusEditor: false))
    } else {
      tabs.restore(tabs: loaded, active: target)
    }
  }

  // MARK: - Helpers

  /// Content to show for a loaded note without an editor snapshot.
  func content(of path: String) -> String? {
    notes.pendingContent(path) ?? notes.serverContent(path)
  }

  /// Saves the outgoing note, applies the tab change, and swaps the editor document.
  private func switchEditor(to path: String, _ changeTabs: () -> Void) {
    if let previous = tabs.active, previous != path { notes.saveNow(previous) }
    changeTabs()
    editor.show(path, content: content(of: path), caretAtEnd: isDailyNote(path))
  }

  /// New tasks go at the end of a daily note, so that's where its caret starts.
  func isDailyNote(_ path: String) -> Bool {
    DailyNotes.date(forPath: path, settings: settings.settings.dailyNotes) != nil
  }

  func afterActivate(_ path: String, _ options: OpenOptions) {
    if let line = options.line { editor.scrollToLine(line) }
    if options.focusEditor { editor.focus() }
    ui.expand(VaultPath.ancestorFolders(path))
    touch(path)
    refreshRecords(path)
    onTabsChanged?()
  }

  func onNoActiveNote() {
    presence.reset()
    editor.show(nil, content: nil)
  }

  /// Keeps a bounded set of recently used notes loaded (instant back-navigation).
  func touch(_ path: String) {
    recent.removeAll { $0 == path }
    recent.insert(path, at: 0)
    var index = recent.count - 1
    while recent.count > Self.maxCachedNotes, index >= Self.maxCachedNotes {
      let candidate = recent[index]
      if !tabs.tabs.contains(candidate), !notes.isBusy(candidate), candidate != tabs.active {
        recent.remove(at: index)
        notes.forget(candidate)
        editor.forget(candidate)
      }
      index -= 1
    }
  }

  func renameRecent(from: String, to: String) {
    recent = recent.map { NotePaths.renamed($0, from: from, to: to) ?? $0 }
  }

  func dropRecent(_ path: String) {
    recent.removeAll { $0 == path }
  }
}
