import DailyDoListModels
import Foundation

/// The in-memory daemon behind `InMemoryDaemonClient`: vault, settings, a simulated agent runtime
/// and the event connection.
///
/// Work that happens "later" is a `TimedAction` on a virtual timeline, run in (due time, sequence)
/// order. Actions run synchronously on the actor, so a run is fully determined by the calls made
/// and the clock mode (see `SimulationClock`).
actor FakeDaemon {
  static let serverVersion = "mock-0.1.0"

  enum TimedAction: Sendable {
    case settle(taskId: String, token: Int)
    case beat(jobId: String, generation: Int)
  }

  struct Scheduled: Sendable {
    let due: EpochMillis
    let sequence: UInt64
    let action: TimedAction
  }

  nonisolated let broadcaster = EventBroadcaster()
  let clientId: String
  let mode: SimulationClock.Mode
  let calendar: FakeCalendar
  let simulation: AgentSimulation
  let vaultName: String

  // Time & scheduling
  var nowMillis: EpochMillis
  private let realAnchor = ContinuousClock.now
  private let virtualAnchor: EpochMillis
  private var queue: [Scheduled] = []
  private var sequence: UInt64 = 0
  private var driver: Task<Void, Never>?
  private var idCounter = 0

  /// Applied on the first call (an actor's synchronous init can't run isolated code).
  private var pendingSeed: InMemoryDaemonClient.Seed?

  // Connection
  var isConnected = false
  private var everConnected = false

  // Vault & settings
  var vault = FakeVault()
  var settings: AppSettings

  // Agent
  var tracked: [String: [TrackedTask]] = [:]
  var records: [String: TaskAgentRecord] = [:]
  var threads: [String: AgentThread] = [:]
  var approvals: [String: ApprovalRequest] = [:]
  var artifacts: [String: StoredArtifact] = [:]
  var jobs: [String: Job] = [:]
  var waitingJobs: [QueuedJob] = []
  var settleTokens: [String: Int] = [:]
  var jobGeneration = 0
  var surfaces: [SurfaceKey: AgentScript.BrowserPage] = [:]
  var surfaceSubscriptions: Set<SurfaceKey> = []
  var editorActivity: (notePath: String, line: Int, at: EpochMillis)?

  // Routines (by routine id; runs' "changed" by thread id)
  var routineStates: [String: FakeRoutineState] = [:]
  var runChanges: [String: Bool] = [:]

  init(
    seed: InMemoryDaemonClient.Seed, clock: SimulationClock, simulation: AgentSimulation,
    clientId: String
  ) {
    self.clientId = clientId
    self.simulation = simulation
    mode = clock.mode
    calendar = FakeCalendar(timeZone: clock.timeZone)
    vaultName = seed.vaultName
    let start = (clock.start.timeIntervalSince1970 * 1000).rounded(.down)
    nowMillis = start
    virtualAnchor = start
    settings = Self.defaultSettings
    pendingSeed = seed
  }

  /// Runs one client call: seeds on first use, brings the clock up to date, then lets the clock
  /// mode run whatever became due (in `.immediate` mode, everything the call scheduled).
  func perform<T: Sendable>(
    _ body: @Sendable (isolated FakeDaemon) throws(DaemonClientError) -> T
  ) throws(DaemonClientError) -> T {
    if let seed = pendingSeed {
      pendingSeed = nil
      seedVault(seed)
    }
    tick()
    defer { pump() }
    return try body(self)
  }

  /// `AppSettings.defaults` with the web mock's quicker settle delay and mock model ids.
  static var defaultSettings: AppSettings {
    var settings = AppSettings.defaults
    settings.agent.settleMs = 1200
    settings.agent.model = "mock/scripted-agent"
    settings.agent.judgeModel = "mock/scripted-judge"
    return settings
  }

  // MARK: - Time

  var now: Date { Date(epochMillis: nowMillis) }
  var today: LocalDate { calendar.localDate(now) }

  /// Brings virtual time up to the wall clock (real-time mode only).
  func tick() {
    guard case .realTime(let speed) = mode else { return }
    let elapsed = realAnchor.duration(to: .now).seconds * 1000 * speed
    nowMillis = max(nowMillis, (virtualAnchor + elapsed).rounded(.down))
  }

  /// Runs whatever the clock mode says is due now. Every entry point ends with this.
  func pump() {
    switch mode {
    case .manual:
      break
    case .immediate:
      runDue(until: .infinity)
    case .realTime:
      tick()
      runDue(until: nowMillis)
      armDriver()
    }
  }

  func schedule(_ action: TimedAction, after milliseconds: Double) {
    sequence += 1
    let item = Scheduled(
      due: nowMillis + max(0, milliseconds.rounded()), sequence: sequence, action: action)
    let index =
      queue.firstIndex { ($0.due, $0.sequence) > (item.due, item.sequence) } ?? queue.endIndex
    queue.insert(item, at: index)
  }

  /// Runs actions due at or before `limit`, in order, moving virtual time to each due time.
  func runDue(until limit: EpochMillis) {
    var steps = 0
    while let first = queue.first, first.due <= limit, steps < 1_000_000 {
      queue.removeFirst()
      nowMillis = max(nowMillis, first.due)
      perform(first.action)
      steps += 1
    }
  }

  func advance(by milliseconds: Double) {
    let target = nowMillis + max(0, milliseconds.rounded(.down))
    runDue(until: target)
    nowMillis = max(nowMillis, target)
  }

  func runUntilIdle() { runDue(until: .infinity) }

  var pendingActionCount: Int { queue.count }

  private func armDriver() {
    driver?.cancel()
    driver = nil
    guard case .realTime(let speed) = mode, let next = queue.first else { return }
    let delay = max(0, (next.due - nowMillis) / speed)
    driver = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(delay))
      guard !Task.isCancelled else { return }
      await self?.driverFired()
    }
  }

  private func driverFired() {
    driver = nil
    pump()
  }

  func stop() {
    driver?.cancel()
    driver = nil
    queue.removeAll()
  }

  private func perform(_ action: TimedAction) {
    switch action {
    case .settle(let taskId, let token): settled(taskId, token: token)
    case .beat(let jobId, let generation): runBeat(jobId, generation: generation)
    }
  }

  /// Deterministic runtime ids: `thr_0001`, `msg_0002`, … (valid in URLs).
  func nextID(_ prefix: String) -> String {
    idCounter += 1
    let digits = String(idCounter)
    return prefix + "_" + String(repeating: "0", count: max(0, 4 - digits.count)) + digits
  }

  // MARK: - Connection

  func connect() {
    guard !isConnected else { return }
    broadcaster.emit(.state(.connecting))
    isConnected = true
    broadcaster.emit(.state(.connected(serverVersion: Self.serverVersion)))
    broadcaster.emit(
      .event(
        .hello(HelloEvent(serverVersion: Self.serverVersion, apiVersion: DaemonProtocol.apiVersion))
      ))
    if everConnected { broadcaster.emit(.resync) }
    everConnected = true
  }

  func disconnect() {
    isConnected = false
    broadcaster.finishAll(with: .disconnected)
  }

  /// Client signals (dropped while disconnected, except surface subscriptions, which the real
  /// client re-sends after every connect).
  func receive(_ event: ClientEvent) {
    switch event {
    case .surfaceSubscribe(let threadId, let surface):
      let key = SurfaceKey(threadId: threadId, surface: surface)
      surfaceSubscriptions.insert(key)
      if isConnected, let page = surfaces[key] { emitFrame(key, page) }
    case .surfaceUnsubscribe(let threadId, let surface):
      surfaceSubscriptions.remove(SurfaceKey(threadId: threadId, surface: surface))
    case .threadRead(let threadId) where isConnected:
      markRead(threadId)
    case .editorActivity(let notePath, let line) where isConnected:
      if let path = try? FakeVaultPaths.resolveVaultPath(notePath) {
        editorActivity = (path, line, nowMillis)
      }
    default:
      break
    }
  }

  /// Server events reach streams only while connected, like a socket.
  func emit(_ event: ServerEvent) {
    guard isConnected else { return }
    broadcaster.emit(.event(event))
  }

  func emitVaultChange(_ changes: [VaultChange], origin: VaultChangeOrigin) {
    let visible = changes.filter { !FakeVaultPaths.isHidden($0.path) }
    guard !visible.isEmpty else { return }
    emit(
      .vaultChanged(
        VaultChangedEvent(
          changes: visible, origin: origin, clientId: origin == .client ? clientId : nil)))
    if visible.contains(where: { FakeRoutineFile.isRoutinePath($0.path) }) { emitRoutines() }
  }
}

struct SurfaceKey: Hashable, Sendable {
  let threadId: String
  let surface: SurfaceKind
}

struct StoredArtifact: Sendable {
  let meta: ArtifactMeta
  let data: Data
}
