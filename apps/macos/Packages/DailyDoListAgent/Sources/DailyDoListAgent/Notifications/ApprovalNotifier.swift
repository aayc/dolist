import AppKit
import DailyDoListModels
import Foundation
import Observation

/// Posts a system notification for every new pending approval ("Approve Once" / "Deny" right
/// from the banner; clicking it opens the thread), removes it as soon as the approval is decided
/// anywhere, and optionally announces finished tasks.
///
/// Permission is requested lazily, when the first approval needs a notification. Approvals that
/// were already waiting when the notifier started (older than `start()`) don't banner: the app's
/// inbox shows them. Without a notification center (`swift run`, tests) it does nothing.
@MainActor
public final class ApprovalNotifier {
  public static let approvalCategory = "ddl.approval"
  public static let taskDoneCategory = "ddl.task-done"
  public static let approveOnceAction = "ddl.approve-once"
  public static let denyAction = "ddl.deny"

  public let store: AgentStore
  /// Also notify when a running task finishes.
  public var notifiesTaskCompletion: Bool
  /// Threads the user is looking at get no banner.
  public var isThreadOnScreen: @MainActor (String) -> Bool = { _ in false }
  /// Called when the user clicks a notification (nil thread: open the inbox).
  public var onOpenThread: @MainActor (String?) -> Void
  /// Brings the app to the front before `onOpenThread`.
  public var activateApp: @MainActor () -> Void = { NSApp?.activate() }

  private let center: AgentNotificationCenter?
  private var isRunning = false
  private var didConfigure = false
  private var startedAt = Date.distantPast
  private var authorization: Authorization = .unknown
  /// Pending approvals already handled (notified, or skipped on purpose).
  private var handledApprovals: Set<String> = []
  /// Pending approvals with a posted notification.
  private var postedApprovals: Set<String> = []
  private var knownStatuses: [String: TaskAgentStatus] = [:]
  private var deliveries: [Task<Void, Never>] = []

  private enum Authorization {
    case unknown
    case requesting(Task<Bool, Never>)
    case granted
    case denied
  }

  /// Approvals created this long before `start()` still count as new (clock skew, launch time).
  static let startGrace: TimeInterval = 5

  public init(
    store: AgentStore,
    center: AgentNotificationCenter? = SystemNotificationCenter.makeIfSupported(),
    notifiesTaskCompletion: Bool = false,
    onOpenThread: @escaping @MainActor (String?) -> Void = { _ in }
  ) {
    self.store = store
    self.center = center
    self.notifiesTaskCompletion = notifiesTaskCompletion
    self.onOpenThread = onOpenThread
  }

  /// True when a notification center is available.
  public var isAvailable: Bool { center != nil }

  /// Starts watching the store (idempotent).
  public func start() {
    guard !isRunning, let center else { return }
    isRunning = true
    startedAt = store.now()
    if !didConfigure {
      didConfigure = true
      center.setCategories(Self.categories)
      center.onResponse = { [weak self] response in
        guard let self else { return }
        Task { await self.handle(response) }
      }
    }
    knownStatuses = store.threads.mapValues(\.status)
    sync()
    observe()
  }

  /// Stops posting (delivered notifications stay until decided or dismissed).
  public func stop() {
    isRunning = false
  }

  static let categories = [
    AgentNotificationCategory(
      identifier: approvalCategory,
      actions: [
        AgentNotificationAction(
          identifier: approveOnceAction, title: "Approve Once", requiresAuthentication: true),
        AgentNotificationAction(identifier: denyAction, title: "Deny", isDestructive: true),
      ]),
    AgentNotificationCategory(identifier: taskDoneCategory, actions: []),
  ]

  static func notificationId(approvalId: String) -> String { "ddl.approval.\(approvalId)" }
  static func notificationId(doneThreadId: String) -> String { "ddl.done.\(doneThreadId)" }

  private func observe() {
    guard isRunning else { return }
    withObservationTracking {
      _ = store.approvals
      _ = store.threads
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in
        guard let self, self.isRunning else { return }
        self.sync()
        self.observe()
      }
    }
  }

  /// Posts what's new and removes what's no longer pending.
  func sync() {
    guard isRunning, let center else { return }
    let pending = store.pendingApprovals
    let pendingIds = Set(pending.map(\.id))

    let decided = handledApprovals.subtracting(pendingIds)
    let stale = postedApprovals.intersection(decided)
    if !stale.isEmpty {
      center.removeNotifications(
        withIdentifiers: stale.sorted().map(Self.notificationId(approvalId:)))
    }
    handledApprovals.subtract(decided)
    postedApprovals.subtract(decided)

    let cutoff = startedAt.addingTimeInterval(-Self.startGrace).epochMillis
    for approval in pending where !handledApprovals.contains(approval.id) {
      handledApprovals.insert(approval.id)
      if approval.createdAt < cutoff { continue }
      if let threadId = approval.threadId, isThreadOnScreen(threadId) { continue }
      postedApprovals.insert(approval.id)
      deliver(notification(for: approval), approvalId: approval.id)
    }

    let threads = store.threads
    for (id, summary) in threads {
      let previous = knownStatuses[id]
      knownStatuses[id] = summary.status
      guard notifiesTaskCompletion, let previous, previous.isActive, summary.status == .done,
        !isThreadOnScreen(id)
      else { continue }
      deliver(doneNotification(for: summary), approvalId: nil)
    }
  }

  private func notification(for approval: ApprovalRequest) -> AgentNotification {
    var userInfo = ["approvalId": approval.id]
    if let threadId = approval.threadId { userInfo["threadId"] = threadId }
    return AgentNotification(
      id: Self.notificationId(approvalId: approval.id), title: "Approval needed",
      subtitle: approval.threadId.flatMap { store.threadTitle($0) }, body: approval.summary,
      categoryIdentifier: Self.approvalCategory, threadIdentifier: approval.threadId,
      userInfo: userInfo)
  }

  private func doneNotification(for summary: ThreadSummary) -> AgentNotification {
    AgentNotification(
      id: Self.notificationId(doneThreadId: summary.id), title: "Task done",
      subtitle: summary.title,
      body: summary.lastMessagePreview.map(AgentFormat.plainPreview) ?? summary.title,
      categoryIdentifier: Self.taskDoneCategory, threadIdentifier: summary.id,
      userInfo: ["threadId": summary.id])
  }

  private func deliver(_ notification: AgentNotification, approvalId: String?) {
    deliveries.removeAll { $0.isCancelled }
    let task = Task { [weak self] in
      guard let self, let center = self.center, await self.ensureAuthorized() else { return }
      do {
        try await center.post(notification)
      } catch {
        SystemNotificationCenter.logger.error(
          "Couldn't post a notification: \(error.localizedDescription)")
      }
      // Decided while we were posting: take it back.
      if let approvalId, self.store.approvals[approvalId]?.isPending != true {
        center.removeNotifications(withIdentifiers: [notification.id])
        self.postedApprovals.remove(approvalId)
      }
    }
    deliveries.append(task)
  }

  private func ensureAuthorized() async -> Bool {
    switch authorization {
    case .granted: return true
    case .denied: return false
    case .requesting(let task): return await task.value
    case .unknown:
      guard let center else { return false }
      let task = Task { await center.requestAuthorization() }
      authorization = .requesting(task)
      let granted = await task.value
      authorization = granted ? .granted : .denied
      if !granted { SystemNotificationCenter.logger.info("Notifications were not allowed") }
      return granted
    }
  }

  /// Handles a click on a notification or one of its actions.
  func handle(_ response: AgentNotificationResponse) async {
    let approvalId = response.userInfo["approvalId"]
    let threadId = response.userInfo["threadId"]
    switch response.actionIdentifier {
    case Self.approveOnceAction:
      if let approvalId { await store.decide(approvalId, .approve, scope: .once) }
    case Self.denyAction:
      if let approvalId { await store.decide(approvalId, .deny) }
    case AgentNotificationResponse.defaultAction:
      activateApp()
      onOpenThread(threadId)
    default:
      break
    }
  }

  /// Waits for notifications being posted (tests).
  func waitForDeliveries() async {
    let pending = deliveries
    deliveries = []
    for task in pending { await task.value }
  }
}
