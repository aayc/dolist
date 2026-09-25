import AppKit
import DailyDoListClient
import DailyDoListModels
import Foundation
import Observation

/// All agent state the UI renders, kept current from REST snapshots and WebSocket events, plus
/// the agent commands (approve/deny, reply, stop, retry, pause).
///
/// Feed it every server event with `apply(_:)` (or every stream item with `handle(_:)`) and call
/// `refresh()` at launch and after each reconnect (`DaemonStreamItem.resync`). Each published
/// field notifies its observers separately: streamed tokens only wake views that read
/// `loadedThreads`, frames only wake the surface views, and the editor badges (`records(for:)`)
/// only wake on record changes.
@MainActor
@Observable
public final class AgentStore {
  public let client: DaemonClient

  /// The reducer's state. Published through the computed properties below, which report exactly
  /// the fields a mutation changed (see `mutate(_:)`).
  @ObservationIgnored var state = AgentState()

  // MARK: Published state

  /// Latest agent status (mode, on/off, running counts, problem), nil until fetched.
  public var status: AgentStatusResponse? {
    access(keyPath: \.status)
    return state.status
  }

  /// Task records by note path (drives the badges next to tasks).
  public var recordsByNote: [String: [TaskAgentRecord]] {
    access(keyPath: \.recordsByNote)
    return state.recordsByNote
  }

  /// Thread summaries by id (the inbox).
  public var threads: [String: ThreadSummary] {
    access(keyPath: \.threads)
    return state.threads
  }

  /// Fully loaded threads by id (opened in the panel), kept live by events.
  public var loadedThreads: [String: AgentThread] {
    access(keyPath: \.loadedThreads)
    return state.loadedThreads
  }

  /// Approvals by id (pending and decided).
  public var approvals: [String: ApprovalRequest] {
    access(keyPath: \.approvals)
    return state.approvals
  }

  /// The latest failed action, for a non-blocking toast; cleared by `dismissError()`.
  public internal(set) var lastError: AgentAlert?
  /// Approvals whose decision is being sent.
  public internal(set) var decidingApprovalIds: Set<String> = []
  /// Optimistic user messages whose request hasn't finished.
  public internal(set) var sendingMessageIds: Set<String> = []
  /// Optimistic user messages the daemon didn't take, with why; they stay in their thread with a
  /// retry.
  public internal(set) var unsentMessages: [String: String] = [:]
  /// Threads being fetched.
  public internal(set) var loadingThreadIds: Set<String> = []
  /// Threads whose last fetch failed (the thread view offers a retry).
  public internal(set) var failedThreadIds: Set<String> = []
  /// The event connection, when fed through `handle(_:)`.
  public internal(set) var connectionState: ConnectionState = .idle
  /// Latest frame of each live surface.
  public internal(set) var frames: [SurfaceKey: SurfaceFrame] = [:]
  /// Recent actions of each live surface (newest last), for overlays and the action log.
  public internal(set) var surfaceActions: [SurfaceKey: [SurfaceAction]] = [:]
  /// Today's daily note, used by `refresh()` to fetch its threads and records. Nil = every thread.
  public var todayNotePath: String?

  // MARK: Bookkeeping

  let now: @Sendable () -> Date
  let artifactRefetchDelay: Duration
  let outbox: ClientOutbox
  /// Incremented for every applied event; REST snapshots compare against it to find the ids that
  /// live events touched while they were in flight.
  @ObservationIgnored var eventSeq: UInt64 = 0
  @ObservationIgnored var statusTouch: UInt64 = 0
  @ObservationIgnored var recordTouches: [String: UInt64] = [:]
  @ObservationIgnored var noteTouches: [String: UInt64] = [:]
  @ObservationIgnored var threadTouches: [String: UInt64] = [:]
  @ObservationIgnored var approvalTouches: [String: UInt64] = [:]
  @ObservationIgnored var threadLoads: [String: Task<Void, Never>] = [:]
  /// `thread.message` events received while a thread is being fetched, replayed on the response.
  @ObservationIgnored var loadBuffers: [String: [ThreadMessageEvent]] = [:]
  @ObservationIgnored var trackedNotes: Set<String> = []
  @ObservationIgnored var subscriptionCounts: [SurfaceKey: Int] = [:]
  @ObservationIgnored var decodedFrames: [SurfaceKey: (ts: EpochMillis, image: NSImage)] = [:]
  @ObservationIgnored var artifactRefetches: [String: Task<Void, Never>] = [:]
  @ObservationIgnored var refreshGeneration = 0

  public convenience init(client: DaemonClient) {
    self.init(client: client, now: { Date() })
  }

  init(
    client: DaemonClient, now: @escaping @Sendable () -> Date,
    artifactRefetchDelay: Duration = .milliseconds(150)
  ) {
    self.client = client
    self.now = now
    self.artifactRefetchDelay = artifactRefetchDelay
    self.outbox = ClientOutbox(client: client)
  }

  // MARK: Events

  /// Applies one server event (call it for every event the client delivers, in order).
  public func apply(_ event: ServerEvent) {
    eventSeq &+= 1
    switch event {
    case .surfaceFrame(let frame):
      receive(frame)
      return
    case .taskRecord(let record):
      recordTouches[record.taskId] = eventSeq
    case .taskRecords(let event):
      noteTouches[event.notePath] = eventSeq
      for record in event.records { recordTouches[record.taskId] = eventSeq }
    case .threadUpsert(let summary):
      threadTouches[summary.id] = eventSeq
    case .approvalUpsert(let approval):
      approvalTouches[approval.id] = eventSeq
    case .agentStatus:
      statusTouch = eventSeq
    case .threadMessage(let event):
      loadBuffers[event.threadId]?.append(event)
    default:
      break
    }
    mutate { $0.apply(event, now: now().epochMillis) }
    if case .threadMessage(let event) = event {
      if case .artifact(let message) = event.message {
        refetchIfArtifactMissing(threadId: event.threadId, artifactId: message.artifactId)
      }
      if case .text(let text) = event.message, text.role == .user {
        forgetDeliveredUnsentMessages()
      }
    }
  }

  /// Forgets unsent messages the daemon's copy replaced (the request failed after reaching it).
  func forgetDeliveredUnsentMessages() {
    guard !unsentMessages.isEmpty else { return }
    let waiting = Set(state.optimisticMessages.values.joined())
    for id in unsentMessages.keys where !waiting.contains(id) {
      unsentMessages[id] = nil
    }
  }

  /// Convenience for the app's event loop: applies events, tracks the connection state and
  /// refreshes after a reconnect.
  public func handle(_ item: DaemonStreamItem) {
    switch item {
    case .event(let event): apply(event)
    case .state(let state): connectionState = state
    case .resync: Task { await refresh() }
    }
  }

  /// Runs a reducer mutation and notifies observers of the fields it changed.
  @discardableResult
  func mutate(_ body: (inout AgentState) -> AgentState.Changes) -> AgentState.Changes {
    let changes = body(&state)
    if changes.contains(.status) { withMutation(keyPath: \.status) {} }
    if changes.contains(.records) { withMutation(keyPath: \.recordsByNote) {} }
    if changes.contains(.threads) { withMutation(keyPath: \.threads) {} }
    if changes.contains(.loadedThreads) { withMutation(keyPath: \.loadedThreads) {} }
    if changes.contains(.approvals) { withMutation(keyPath: \.approvals) {} }
    return changes
  }

  func report(_ error: Error, title: String) {
    if case DaemonClientError.cancelled = error { return }
    if error is CancellationError { return }
    lastError = AgentAlert(title: title, error: error)
  }

  /// Clears the toast (only if it is still `id`, when given).
  public func dismissError(_ id: UUID? = nil) {
    guard let current = lastError, id == nil || current.id == id else { return }
    lastError = nil
  }

  // MARK: Queries

  /// Records of one note (for the editor badges).
  public func records(for notePath: String) -> [TaskAgentRecord] {
    recordsByNote[notePath] ?? []
  }

  public func record(forTaskId taskId: String) -> TaskAgentRecord? {
    _ = recordsByNote
    return state.record(forTaskId: taskId)
  }

  /// The task record behind a thread.
  public func record(forThread threadId: String) -> TaskAgentRecord? {
    _ = recordsByNote
    return state.record(forThread: threadId)
  }

  /// Unread agent messages of a thread's task.
  public func unreadCount(forThread threadId: String) -> Int {
    record(forThread: threadId)?.unread ?? 0
  }

  /// The loaded thread, if it was fetched.
  public func thread(_ id: String) -> AgentThread? {
    loadedThreads[id]
  }

  /// Daemon ids of the user's messages → the optimistic ids they replaced (chat rows keep their
  /// identity when the daemon's copy arrives).
  var messageAliases: [String: String] {
    _ = loadedThreads
    return state.optimisticReplacements
  }

  /// The best known title of a thread.
  public func threadTitle(_ id: String) -> String? {
    loadedThreads[id]?.title ?? threads[id]?.title
  }

  /// The best known status of a thread.
  public func threadStatus(_ id: String) -> TaskAgentStatus? {
    loadedThreads[id]?.status ?? threads[id]?.status
  }

  /// Pending approvals, oldest first.
  public var pendingApprovals: [ApprovalRequest] {
    _ = approvals
    return state.pendingApprovals
  }

  public var pendingApprovalCount: Int {
    approvals.values.reduce(0) { $0 + ($1.isPending ? 1 : 0) }
  }

  /// Pending approvals of one thread, oldest first.
  public func pendingApprovals(forThread threadId: String) -> [ApprovalRequest] {
    pendingApprovals.filter { $0.threadId == threadId }
  }

  /// The inbox: today's threads plus anything still waiting or running, grouped.
  public func inboxSections(now: Date = Date(), calendar: Calendar = .current) -> [InboxSection] {
    _ = approvals
    return InboxGrouping.sections(
      for: threads.values, pendingApprovalThreadIds: state.threadIdsWithPendingApprovals,
      now: now, calendar: calendar)
  }

  /// Running subagents (the daemon's count; derived from thread statuses until it's known).
  public var runningCount: Int {
    if let status { return status.running }
    return threads.values.reduce(0) { $0 + ($1.status == .working ? 1 : 0) }
  }

  /// Why the agent can't act right now (off, paused, missing key…); nil when it can.
  public var unavailableReason: String? {
    guard let status else { return nil }
    if let problem = status.problem, !problem.isEmpty { return problem }
    if status.mode == .off { return "The agent is off." }
    if !status.enabled { return "The agent is paused." }
    return nil
  }

  /// True unless the daemon reported that the agent can't act.
  public var isAgentAvailable: Bool { unavailableReason == nil }

  /// The artifact's metadata, when its thread is loaded.
  public func artifactMeta(threadId: String, artifactId: String) -> ArtifactMeta? {
    loadedThreads[threadId]?.artifacts.first { $0.id == artifactId }
  }

  /// Everything queued for the daemon has been handed to the client (tests, shutdown).
  func flushClientEvents() async {
    await outbox.flush()
  }
}
