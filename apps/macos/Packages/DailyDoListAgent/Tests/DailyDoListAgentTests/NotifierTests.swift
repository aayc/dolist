import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListAgent

@MainActor
final class FakeNotificationCenter: AgentNotificationCenter {
  var grantsAuthorization = true
  private(set) var authorizationRequests = 0
  private(set) var categories: [AgentNotificationCategory] = []
  private(set) var posted: [AgentNotification] = []
  private(set) var removed: [String] = []
  var onResponse: (@MainActor (AgentNotificationResponse) -> Void)?

  func requestAuthorization() async -> Bool {
    authorizationRequests += 1
    return grantsAuthorization
  }

  func setCategories(_ categories: [AgentNotificationCategory]) { self.categories = categories }
  func post(_ notification: AgentNotification) async throws { posted.append(notification) }
  func removeNotifications(withIdentifiers identifiers: [String]) { removed += identifiers }
}

@MainActor
@Suite("Approval notifications")
struct NotifierTests {
  nonisolated static let now = Date(epochMillis: 1_790_000_000_000)
  let client = FakeDaemonClient()
  let center = FakeNotificationCenter()
  let store: AgentStore
  let notifier: ApprovalNotifier

  init() {
    store = AgentStore(client: client, now: { NotifierTests.now })
    notifier = ApprovalNotifier(store: store, center: center)
  }

  private func approval(_ id: String = "apr_1", thread: String = "thr_1", status: ApprovalStatus = .pending, minutesAgo: Double = 0) -> ApprovalRequest {
    Fixture.approval(id, threadId: thread, status: status, createdAt: Self.now.epochMillis - minutesAgo * 60_000, summary: "Send an email to sam@example.com")
  }

  private func settle() async {
    await Task.yield()
    await notifier.waitForDeliveries()
    try? await Task.sleep(for: .milliseconds(20))
    await notifier.waitForDeliveries()
  }

  @Test func registersCategoriesAndAsksForPermissionOnlyWhenNeeded() async {
    notifier.start()
    await settle()
    #expect(center.authorizationRequests == 0)
    let approval = center.categories.first { $0.identifier == ApprovalNotifier.approvalCategory }
    #expect(approval?.actions.map(\.title) == ["Approve Once", "Deny"])
    #expect(approval?.actions.first?.requiresAuthentication == true)
    #expect(approval?.actions.last?.isDestructive == true)
    #expect(notifier.isAvailable)
  }

  @Test func postsOneNotificationPerNewPendingApproval() async {
    store.apply(.threadUpsert(Fixture.summary(title: "Email Sam the Q3 report", updatedAt: Self.now.epochMillis)))
    notifier.start()
    store.apply(.approvalUpsert(approval()))
    #expect(await eventually { center.posted.count == 1 })
    store.apply(.approvalUpsert(approval()))
    store.apply(.threadUpsert(Fixture.summary(title: "Renamed", updatedAt: Self.now.epochMillis + 1)))
    await settle()
    #expect(center.posted.count == 1)
    #expect(center.authorizationRequests == 1)
    let notification = center.posted.first
    #expect(notification?.id == "ddl.approval.apr_1")
    #expect(notification?.title == "Approval needed")
    #expect(notification?.subtitle == "Email Sam the Q3 report")
    #expect(notification?.body == "Send an email to sam@example.com")
    #expect(notification?.categoryIdentifier == ApprovalNotifier.approvalCategory)
    #expect(notification?.threadIdentifier == "thr_1")
    #expect(notification?.userInfo == ["approvalId": "apr_1", "threadId": "thr_1"])

    store.apply(.approvalUpsert(approval("apr_2")))
    #expect(await eventually { center.posted.count == 2 })
    #expect(center.authorizationRequests == 1)
  }

  @Test func removesTheNotificationWhenTheApprovalIsDecidedElsewhere() async {
    notifier.start()
    store.apply(.approvalUpsert(approval()))
    #expect(await eventually { center.posted.count == 1 })
    store.apply(.approvalUpsert(Fixture.approval(threadId: "thr_1", status: .approved, createdAt: Self.now.epochMillis, decidedAt: 5)))
    #expect(await eventually { center.removed == ["ddl.approval.apr_1"] })
  }

  @Test func approvalsThatWereAlreadyWaitingDontBanner() async {
    store.apply(.approvalUpsert(approval(minutesAgo: 30)))
    notifier.start()
    store.apply(.approvalUpsert(approval("apr_new")))
    #expect(await eventually { center.posted.count == 1 })
    #expect(center.posted.map(\.id) == ["ddl.approval.apr_new"])
  }

  @Test func threadsOnScreenGetNoBanner() async {
    notifier.isThreadOnScreen = { $0 == "thr_1" }
    notifier.start()
    store.apply(.approvalUpsert(approval()))
    store.apply(.approvalUpsert(approval("apr_2", thread: "thr_2")))
    #expect(await eventually { center.posted.count == 1 })
    await settle()
    #expect(center.posted.map(\.id) == ["ddl.approval.apr_2"])
  }

  @Test func withoutPermissionNothingIsPosted() async {
    center.grantsAuthorization = false
    notifier.start()
    store.apply(.approvalUpsert(approval()))
    store.apply(.approvalUpsert(approval("apr_2")))
    #expect(await eventually { center.authorizationRequests == 1 })
    await settle()
    #expect(center.posted.isEmpty)
    #expect(center.authorizationRequests == 1)
  }

  @Test func actionButtonsDecide() async {
    client.script { $0.decideApproval = { id, request in Fixture.approval(id, status: request.decision == .approve ? .approved : .denied, decidedAt: 9) } }
    store.apply(.approvalUpsert(approval()))
    store.apply(.approvalUpsert(approval("apr_2")))
    await notifier.handle(
      AgentNotificationResponse(notificationId: "n1", actionIdentifier: ApprovalNotifier.approveOnceAction, userInfo: ["approvalId": "apr_1", "threadId": "thr_1"]))
    await notifier.handle(
      AgentNotificationResponse(notificationId: "n2", actionIdentifier: ApprovalNotifier.denyAction, userInfo: ["approvalId": "apr_2"]))
    #expect(client.callLog == ["decideApproval:apr_1:approve:once", "decideApproval:apr_2:deny:-"])
    #expect(store.approvals["apr_1"]?.status == .approved)
    #expect(store.approvals["apr_2"]?.status == .denied)
  }

  @Test func clickingANotificationOpensItsThread() async {
    var activated = false
    var opened: [String?] = []
    notifier.activateApp = { activated = true }
    notifier.onOpenThread = { opened.append($0) }
    notifier.start()
    center.onResponse?(
      AgentNotificationResponse(notificationId: "n", actionIdentifier: AgentNotificationResponse.defaultAction, userInfo: ["approvalId": "apr_1", "threadId": "thr_1"]))
    #expect(await eventually { opened == ["thr_1"] })
    #expect(activated)
    await notifier.handle(AgentNotificationResponse(notificationId: "n", actionIdentifier: AgentNotificationResponse.dismissAction, userInfo: [:]))
    #expect(opened == ["thr_1"])
  }

  @Test func finishedTasksAreAnnouncedWhenAskedTo() async {
    store.apply(.threadUpsert(Fixture.summary("thr_a", title: "Compare desks", status: .working, updatedAt: 1, preview: "**Pick:** Example Rise Pro")))
    store.apply(.threadUpsert(Fixture.summary("thr_b", title: "Quiet task", status: .done, updatedAt: 1)))
    notifier.notifiesTaskCompletion = true
    notifier.start()
    store.apply(.threadUpsert(Fixture.summary("thr_a", title: "Compare desks", status: .done, updatedAt: 2, preview: "**Pick:** Example Rise Pro")))
    store.apply(.threadUpsert(Fixture.summary("thr_b", title: "Quiet task", status: .done, updatedAt: 2)))
    #expect(await eventually { center.posted.count == 1 })
    await settle()
    #expect(center.posted.map(\.id) == ["ddl.done.thr_a"])
    #expect(center.posted.first?.title == "Task done")
    #expect(center.posted.first?.body == "Pick: Example Rise Pro")
  }

  @Test func finishedTasksAreQuietByDefault() async {
    store.apply(.threadUpsert(Fixture.summary(status: .working, updatedAt: 1)))
    notifier.start()
    store.apply(.threadUpsert(Fixture.summary(status: .done, updatedAt: 2)))
    await settle()
    #expect(center.posted.isEmpty)
  }

  @Test func stoppedNotifiersStayQuiet() async {
    notifier.start()
    notifier.stop()
    store.apply(.approvalUpsert(approval()))
    await settle()
    #expect(center.posted.isEmpty)
  }

  @Test func withoutANotificationCenterItDoesNothing() {
    let quiet = ApprovalNotifier(store: store, center: nil)
    #expect(!quiet.isAvailable)
    quiet.start()
    quiet.sync()
  }

  @Test func theSystemCenterIsUnavailableOutsideABundledApp() {
    #expect(!SystemNotificationCenter.isSupported)
    #expect(SystemNotificationCenter.makeIfSupported() == nil)
  }
}

@MainActor
@Suite("Dock badge")
struct DockBadgeTests {
  @Test func showsThePendingCountWhileStarted() async {
    let store = AgentStore(client: FakeDaemonClient())
    var labels: [String?] = []
    let badge = DockBadge(store: store) { labels.append($0) }
    store.apply(.approvalUpsert(Fixture.approval("apr_1")))
    badge.start()
    #expect(labels == ["1"])
    store.apply(.approvalUpsert(Fixture.approval("apr_2")))
    #expect(await eventually { labels.last == "2" })
    store.apply(.approvalUpsert(Fixture.approval("apr_1", status: .approved, decidedAt: 2)))
    store.apply(.approvalUpsert(Fixture.approval("apr_2", status: .denied, decidedAt: 2)))
    #expect(await eventually { labels.last == .some(nil) })
    badge.stop()
    store.apply(.approvalUpsert(Fixture.approval("apr_3")))
    try? await Task.sleep(for: .milliseconds(30))
    #expect(labels.last == .some(nil))
    #expect(labels.count == 4)
  }
}
