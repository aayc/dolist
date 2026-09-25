import AppKit
import DailyDoListAgent
import DailyDoListClient
import DailyDoListDaemon
import DailyDoListDomain
import DailyDoListEditor
import DailyDoListModels
import DailyDoListVim
import Foundation
import Observation

/// Root state of the app: boots the daemon connection, owns the stores, and runs the event loop
/// that routes every `DaemonStreamItem` to them.
///
/// Boot: preferences → `DaemonSupervisor.start()` (managed) or DDL_HOME token discovery (external)
/// → `HTTPDaemonClient` → health + API version check → `connect()` + event loop → settings, tree,
/// today's daily note, restored tabs, agent state. Demo mode (`--demo`) swaps in the in-memory
/// daemon instead.
@MainActor
@Observable
public final class AppModel {
  /// What the main window shows.
  enum Phase: Equatable {
    case idle
    case booting(String)
    case ready
    case failed(BootFailure)
  }

  /// The app's shared instance (scenes, app delegate, dock menu, global hotkey).
  public static let shared = AppModel()

  var phase: Phase = .idle
  let preferences: AppPreferences
  let connection = ConnectionStore()
  let settings = SettingsStore()
  let toasts: ToastStore
  let ui: UIState
  /// The macOS permissions computer use needs, and the setup that gets them.
  let computerAccess: ComputerAccessSetup
  var client: DaemonClient?
  /// Where `client` points (nil in demo mode).
  @ObservationIgnored var clientEndpoint: DaemonEndpoint?
  var agent: AgentStore?
  var workspace: Workspace?
  /// Path of today's daily note once known (agent inbox scope).
  var todayNotePath: String?
  /// Lines of the vimrc vim rejected when it was last applied (Settings lists them).
  var vimrcProblems: [VimrcProblem] = []

  /// The app's vim engine, like the web page's: registers, history, macros and mappings are
  /// shared by every editor and survive reconnects.
  @ObservationIgnored let vim: Vim
  @ObservationIgnored let vimIntegration: EditorVimIntegration

  @ObservationIgnored let environment: AppEnvironment
  @ObservationIgnored var supervisor: DaemonSupervising { environment.supervisor }
  @ObservationIgnored var systemIntegration: SystemIntegrationBridge {
    environment.systemIntegration
  }
  @ObservationIgnored var eventTask: Task<Void, Never>?
  @ObservationIgnored var supervisorTask: Task<Void, Never>?
  @ObservationIgnored var bootTask: Task<Void, Never>?
  @ObservationIgnored var bootGeneration = 0
  @ObservationIgnored var notifier: ApprovalNotifier?
  @ObservationIgnored var dockBadge: DockBadge?
  @ObservationIgnored var windowObservers: [NSObjectProtocol] = []
  @ObservationIgnored var keyMonitor: Any?
  @ObservationIgnored var tabsPersistTimer: IdleTimer?
  @ObservationIgnored var hasStarted = false

  public convenience init() {
    self.init(environment: .live())
  }

  init(environment: AppEnvironment) {
    self.environment = environment
    preferences = environment.preferences
    toasts = ToastStore(scheduler: environment.scheduler)
    ui = UIState(preferences: environment.preferences)
    computerAccess = ComputerAccessSetup(
      system: environment.computerAccess, scheduler: environment.scheduler)
    vim = Vim()
    vimIntegration = EditorVimIntegration(vim: vim, pasteboard: environment.vimPasteboard())
    connectComputerAccess()
    settings.onChange = { [weak self] old, new in self?.settingsDidChange(from: old, to: new) }
    settings.onError = { [weak self] error in self?.toasts.error("Couldn't save settings", error) }
    tabsPersistTimer = IdleTimer(scheduler: environment.scheduler, delay: 0.5) { [weak self] in
      self?.persistTabs()
    }
  }

  var isDemo: Bool { environment.launchOptions.demo }

  /// Boots once (idempotent): called when the app finishes launching and when the window appears.
  public func start() {
    guard !hasStarted else { return }
    hasStarted = true
    // The default theme (dark) until the daemon's settings arrive; only changes apply after that.
    applyTheme(settings.settings.theme)
    if environment.enablesSystemServices { installSystemServices() }
    bootTask = Task { await boot() }
  }

  // MARK: - Settings side effects

  private func settingsDidChange(from old: AppSettings, to new: AppSettings) {
    // The vimrc first: the editors' sessions start with its mappings and options.
    if new.editor.vimMode { vimrcProblems = vimIntegration.applyVimrc(new.editor.vimrc) }
    workspace?.editor.configure(new.editor)
    if old.theme != new.theme || !settings.isLoaded { applyTheme(new.theme) }
  }

  /// `:obcommand <id>`: runs an app command by its `CommandID` (the web app's ids work too:
  /// `daily:today`, `editor:live-preview`). False when there's no such command.
  func runCommand(id: String) -> Bool {
    guard let command = CommandID(vimCommandID: id) else { return false }
    CommandCatalog(model: self).run(command)
    return true
  }

  func applyTheme(_ theme: ThemePreference) {
    guard environment.enablesSystemServices else { return }
    NSApplication.shared.appearance = Self.appearance(for: theme)
  }

  /// The app's appearance for a theme setting (nil: follow the system).
  static func appearance(for theme: ThemePreference) -> NSAppearance? {
    switch theme {
    case .system: nil
    case .light: NSAppearance(named: .aqua)
    case .dark: NSAppearance(named: .darkAqua)
    }
  }

  // MARK: - Tabs persistence

  func scheduleTabsPersist() {
    tabsPersistTimer?.poke()
  }

  func persistTabs() {
    guard let workspace else { return }
    preferences.lastOpenTabs = workspace.tabs.tabs
    preferences.lastActiveTab = workspace.tabs.active
  }

  // MARK: - Actions used across the app

  /// Dock menu, menu bar, global hotkey: bring the app forward and show today's note.
  func openTodaysNote() {
    if environment.enablesSystemServices {
      NSApplication.shared.activate()
      showMainWindow()
    }
    guard let workspace else { return }
    Task { await workspace.openToday() }
  }

  /// Opens a thread in the agent panel of the main window (a routine's run with its routine's
  /// runs behind it).
  func openThread(_ threadId: String?) {
    bringMainWindowForward()
    if let threadId, let routineId = agent?.routineId(forThread: threadId) {
      ui.showRoutineRun(routineId: routineId, threadId: threadId)
    } else if let threadId {
      ui.showThread(threadId)
    } else {
      ui.showInbox()
    }
  }

  /// A routine's run, from its notification.
  func openRoutineRun(routineId: String, threadId: String) {
    bringMainWindowForward()
    ui.showRoutineRun(routineId: routineId, threadId: threadId)
  }

  /// Show Routines: every routine in the agent panel.
  func showRoutines() {
    bringMainWindowForward()
    ui.showRoutines()
  }

  /// New Routine…: the sheet, over the main window.
  func newRoutine(_ draft: RoutineDraft = RoutineDraft()) {
    bringMainWindowForward()
    ui.newRoutine(draft)
  }

  private func bringMainWindowForward() {
    guard environment.enablesSystemServices else { return }
    NSApplication.shared.activate()
    showMainWindow()
  }

  func setAgentEnabled(_ enabled: Bool) async {
    await agent?.setEnabled(enabled)
  }

  /// Saves every open note (window resign, quit).
  func flushAll() async {
    await workspace?.notes.flushAll()
  }

  /// Quit: flush pending saves (bounded), then stop a daemon we launched.
  func prepareForTermination() async {
    persistTabs()
    await flushAll()
    await client?.disconnect()
    if preferences.daemonMode == .managed, !isDemo { await supervisor.stop() }
  }
}
