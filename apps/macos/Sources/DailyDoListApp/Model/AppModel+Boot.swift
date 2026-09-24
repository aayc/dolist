import DailyDoListAgent
import DailyDoListClient
import DailyDoListDaemon
import DailyDoListDomain
import DailyDoListModels
import Foundation

extension AppModel {
  /// Connects (or reconnects) from scratch with the current preferences.
  func boot() async {
    BootTrace.mark("app: boot")
    hasStarted = true
    bootGeneration += 1
    let generation = bootGeneration
    await teardown()
    guard generation == bootGeneration else { return }

    let client: DaemonClient
    if isDemo {
      guard let makeDemoClient = environment.makeDemoClient else {
        phase = .failed(.other(detail: "Demo mode isn't available in this build."))
        return
      }
      client = makeDemoClient()
      connection.setKind(.demo)
    } else {
      switch await acquireEndpoint() {
      case .failure(let failure):
        if generation == bootGeneration { phase = .failed(failure) }
        return
      case .success(let endpoint):
        BootTrace.mark("app: daemon endpoint ready")
        client = environment.makeClient(endpoint)
        clientEndpoint = endpoint
        connection.setKind(.daemon(endpoint.baseURL))
      }
    }
    guard generation == bootGeneration else { return }

    phase = .booting("Connecting…")
    do {
      let health = try await client.health()
      BootTrace.mark("app: health checked")
      guard generation == bootGeneration else { return }
      guard DaemonProtocol.isCompatible(apiVersion: health.apiVersion) else {
        phase = .failed(.incompatibleApiVersion(server: health.apiVersion))
        return
      }
      connection.setHealth(health)
    } catch {
      if generation == bootGeneration { phase = .failed(BootFailure(error)) }
      return
    }

    install(client)
    phase = .booting("Loading your notes…")
    await loadInitialData(generation: generation)
    guard generation == bootGeneration else { return }
    phase = .ready
    BootTrace.mark("app: ready")
  }

  /// Retry from the boot screen or the offline banner.
  func retry() async {
    if case .ready = phase, let client, !managedDaemonIsDown {
      await client.disconnect()
      // `disconnect()` finishes every event stream: subscribe again before reconnecting.
      startEventLoop(client)
      await client.connect()
      return
    }
    await boot()
  }

  /// "Start daemon" from the boot screen: switch to a managed daemon and boot.
  func startManagedDaemon() async {
    preferences.daemonMode = .managed
    await boot()
  }

  /// Settings → Restart daemon. A managed daemon restarts in place (the client reconnects and
  /// resyncs); otherwise this reconnects.
  func restartDaemon() async {
    guard preferences.daemonMode == .managed, !isDemo, phase == .ready else {
      await boot()
      return
    }
    supervisor.configuration = preferences.launchConfiguration
    guard let info = await supervisor.restart() else {
      phase = .failed(BootFailure(supervisorError: supervisor.lastError, state: supervisor.state))
      return
    }
    if needsNewClient(for: info) { await boot() }
  }

  /// Same endpoint: the client reconnects by itself and resyncs. A new port or token needs a new
  /// client.
  func needsNewClient(for info: DaemonConnectionInfo) -> Bool {
    clientEndpoint.map { $0.baseURL != info.baseURL || $0.token != info.token } ?? true
  }

  /// The supervisor gave up on (or stopped) the managed daemon, so reconnecting can't help.
  var managedDaemonIsDown: Bool {
    guard preferences.daemonMode == .managed, !isDemo else { return false }
    switch supervisor.state {
    case .failed, .stopped, .idle: return true
    case .starting, .running, .attached, .restarting: return false
    }
  }

  /// Follows a managed daemon the supervisor restarts on its own after a crash.
  func supervisorStateChanged(_ state: DaemonSupervisorState) {
    guard phase == .ready, preferences.daemonMode == .managed, !isDemo else { return }
    switch state {
    case .running(_, let info), .attached(let info):
      if needsNewClient(for: info) { bootTask = Task { await boot() } }
    case .failed(let reason):
      toasts.show(.error, "The daemon stopped", body: reason, actionLabel: "Restart") { [weak self] in
        guard let self else { return }
        bootTask = Task { await self.boot() }
      }
    case .idle, .starting, .restarting, .stopped:
      break
    }
  }

  private func watchSupervisor() {
    supervisorTask?.cancel()
    let updates = supervisor.stateUpdates()
    supervisorTask = Task { [weak self] in
      for await state in updates {
        guard !Task.isCancelled else { return }
        self?.supervisorStateChanged(state)
      }
    }
  }

  // MARK: - Steps

  private func acquireEndpoint() async -> Result<DaemonEndpoint, BootFailure> {
    switch preferences.daemonMode {
    case .managed:
      supervisor.configuration = preferences.launchConfiguration
      phase = .booting("Starting the daemon…")
      guard let info = await supervisor.start() else {
        return .failure(BootFailure(supervisorError: supervisor.lastError, state: supervisor.state))
      }
      return .success(DaemonEndpoint(baseURL: info.baseURL, token: info.token))
    case .external:
      guard let url = preferences.externalURL else {
        return .failure(.invalidConfiguration(detail: "“\(preferences.externalBaseURL)” isn't a valid http(s) URL."))
      }
      phase = .booting("Connecting to \(url.absoluteString)…")
      do {
        var endpoint = try environment.discoverEndpoint(preferences.homeURL, url.port)
        endpoint.baseURL = url
        return .success(endpoint)
      } catch {
        let detail = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        return .failure(.daemonNotRunning(detail: detail))
      }
    }
  }

  /// Creates the per-connection stores and starts the event loop.
  private func install(_ client: DaemonClient) {
    self.client = client
    settings.client = client
    let agent = AgentStore(client: client)
    let workspace = Workspace(
      client: client, settings: settings, ui: ui, toasts: toasts, scheduler: environment.scheduler,
      now: environment.now)
    workspace.agent = agent
    workspace.localVaultURL = localVaultURL()
    workspace.onTabsChanged = { [weak self] in self?.scheduleTabsPersist() }
    self.agent = agent
    self.workspace = workspace
    startEventLoop(client)
    Task { await client.connect() }
    if preferences.daemonMode == .managed, !isDemo { watchSupervisor() }
    if environment.enablesSystemServices { startAgentServices(agent) }
    observeAgentErrors(agent)
  }

  /// Settings, tree and today's note in parallel; then restored tabs and the agent's state.
  private func loadInitialData(generation: Int) async {
    guard let client, let workspace, let agent else { return }
    async let settingsResult = Self.capture { try await client.settings() }
    async let treeResult = Self.capture { try await client.tree() }
    async let dailyResult = Self.capture { try await client.dailyNote("today", create: true) }
    let (loadedSettings, tree, daily) = await (settingsResult, treeResult, dailyResult)
    guard generation == bootGeneration else { return }

    switch loadedSettings {
    case .success(let value): settings.apply(value)
    case .failure(let error): toasts.error("Couldn't load settings", error)
    }
    switch tree {
    case .success(let value): workspace.applyTree(value)
    case .failure(let error): toasts.error("Couldn't load the vault", error)
    }
    await workspace.restoreTabs(preferences.lastOpenTabs, active: preferences.lastActiveTab)
    switch daily {
    case .success(let note):
      todayNotePath = note.path
      workspace.adoptDaily(note)
      workspace.activate(note.path, OpenOptions(newTab: !workspace.tabs.tabs.isEmpty))
    case .failure(let error):
      toasts.error("Couldn't open today's note", error)
    }
    Task {
      await agent.refresh(todayNotePath: todayNotePath)
      workspace.editor.recordsDidChange(for: nil)
    }
  }

  /// Stops the event loop and drops per-connection state (after flushing unsaved notes).
  func teardown() async {
    supervisorTask?.cancel()
    supervisorTask = nil
    eventTask?.cancel()
    eventTask = nil
    if let workspace {
      persistTabs()
      await workspace.notes.flushAll()
    }
    notifier?.stop()
    notifier = nil
    dockBadge?.stop()
    dockBadge = nil
    if let client { await client.disconnect() }
    client = nil
    clientEndpoint = nil
    agent = nil
    workspace = nil
    settings.client = nil
    connection.reset()
    todayNotePath = nil
    phase = .booting("Starting…")
  }

  /// The vault's local folder when this Mac can see it (Reveal in Finder).
  func localVaultURL() -> URL? {
    guard !isDemo else { return nil }
    let fileManager = FileManager.default
    if let vault = supervisor.configuration.vaultPath ?? preferences.launchConfiguration.vaultPath {
      return fileManager.fileExists(atPath: vault.path) ? vault : nil
    }
    // The daemon's default vault, when it's the one being served.
    let fallback = fileManager.homeDirectoryForCurrentUser.appendingPathComponent("DailyDoList", isDirectory: true)
    guard fileManager.fileExists(atPath: fallback.path),
      connection.health.map({ $0.vaultName == fallback.lastPathComponent }) ?? false
    else { return nil }
    return fallback
  }

  static func capture<T: Sendable>(_ body: @Sendable () async throws -> T) async -> Result<T, Error> {
    do {
      return .success(try await body())
    } catch {
      return .failure(error)
    }
  }
}
