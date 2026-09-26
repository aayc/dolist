import DailyDoListClient
import DailyDoListClientTestSupport
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListAgent

extension Fixture {
  static func routine(
    _ id: String = "rtn_1", name: String = "Morning briefing", paused: Bool = false,
    error: String? = nil, lastRun: RoutineRun? = nil, extraRunsLeft: Int = 5,
    nextRunAt: EpochMillis? = 5_000
  ) -> Routine {
    Routine(
      id: id, path: "Routines/\(name).md", name: name, schedule: "every weekday at 7:30",
      scheduleText: "Every weekday at 7:30 AM", paused: paused, instructions: "Brief me.",
      error: error, nextRunAt: paused || error != nil ? nil : nextRunAt, lastRun: lastRun,
      extraRunsLeft: extraRunsLeft)
  }

  static func run(
    _ id: String, routineId: String = "rtn_1", status: TaskAgentStatus = .done,
    createdAt: EpochMillis = 1, pendingApprovals: Int = 0
  ) -> ThreadSummary {
    var summary = Fixture.summary(
      id, taskId: "run_\(id)", notePath: "Routines/Morning briefing.md",
      title: "Morning briefing", status: status, createdAt: createdAt, updatedAt: createdAt + 1,
      pendingApprovals: pendingApprovals)
    summary.routineId = routineId
    return summary
  }

  static func apiError(_ status: Int, _ code: ApiErrorCode, _ message: String?)
    -> DaemonClientError
  {
    .http(status: status, body: ApiErrorBody(error: code, message: message))
  }
}

@MainActor
@Suite("Store: routines")
struct StoreRoutineTests {
  let client = FakeDaemonClient()
  let store: AgentStore

  init() {
    store = AgentStore(client: client, now: { Date(epochMillis: 1_000) })
  }

  // MARK: Listing and events

  @Test func loadsRoutinesAndTemplates() async {
    let template = RoutineTemplate(
      id: "weekly-review", name: "Weekly review", description: "Sunday evening.",
      schedule: "every sunday at 18:00", instructions: "Review my week.")
    client.script {
      $0.routines = {
        RoutineListResponse(
          routines: [Fixture.routine("rtn_2", name: "Price watch"), Fixture.routine()],
          templates: [template])
      }
    }
    #expect(!store.routinesLoaded)
    await store.loadRoutines()
    #expect(store.routines.map(\.name) == ["Morning briefing", "Price watch"])
    #expect(store.routineTemplates == [template])
    #expect(store.routinesLoaded && store.routinesLoadError == nil)
    #expect(store.routine("rtn_2")?.name == "Price watch")
  }

  @Test func aFailedLoadStaysInTheRoutinesView() async {
    client.script { $0.routines = { throw Fixture.apiError(404, .notFound, "Not found") } }
    await store.loadRoutines()
    #expect(store.routinesLoadError == "Not found")
    #expect(store.lastError == nil, "no toast")
  }

  @Test func routinesChangedReplacesTheList() {
    store.apply(.routinesChanged([Fixture.routine(), Fixture.routine("rtn_2", name: "A watch")]))
    #expect(store.routines.map(\.id) == ["rtn_2", "rtn_1"])
    store.apply(.routinesChanged([Fixture.routine(paused: true)]))
    #expect(store.routines == [Fixture.routine(paused: true)])
  }

  @Test func aPushDuringALoadWins() async {
    let gate = Gate()
    client.script {
      $0.routines = {
        await gate.wait()
        return RoutineListResponse(routines: [Fixture.routine()], templates: [])
      }
    }
    let load = Task { await store.loadRoutines() }
    #expect(await waitForArrivals(gate))
    store.apply(.routinesChanged([Fixture.routine(paused: true)]))
    await gate.open()
    await load.value
    #expect(store.routines.first?.paused == true)
    #expect(store.routinesLoaded)
  }

  @Test func notificationsQueueForTheNotifier() {
    for index in 0..<(AgentStore.routineNotificationLimit + 3) {
      store.apply(
        .routineNotification(
          RoutineNotification(
            routineId: "rtn_1", title: "Morning briefing", body: "Run \(index)",
            threadId: "thr_\(index)", status: .done, at: EpochMillis(index))))
    }
    #expect(store.routineNotifications.count == AgentStore.routineNotificationLimit)
    #expect(store.routineNotifications.first?.threadId == "thr_3")
  }

  // MARK: Runs

  @Test func runsLiveUnderTheirRoutineNotInTheInbox() {
    store.apply(.threadUpsert(Fixture.summary(updatedAt: Date().epochMillis)))
    store.apply(.threadUpsert(Fixture.run("thr_r1", createdAt: Date().epochMillis)))
    store.apply(.threadUpsert(Fixture.run("thr_r2", createdAt: Date().epochMillis + 1)))
    #expect(store.inboxSections().flatMap(\.threads).map(\.id) == ["thr_1"])
    #expect(store.runs(ofRoutine: "rtn_1").map(\.id) == ["thr_r2", "thr_r1"])
    #expect(store.routineId(forThread: "thr_r1") == "rtn_1")
    #expect(store.routineId(forThread: "thr_1") == nil)
  }

  @Test func aRunWaitingOnTheUserSurfacesInTheInbox() {
    let now = Date().epochMillis
    store.apply(.threadUpsert(Fixture.run("thr_r1", status: .waitingApproval, createdAt: now)))
    store.apply(.threadUpsert(Fixture.run("thr_r2", status: .working, createdAt: now)))
    store.apply(.threadUpsert(Fixture.run("thr_r3", status: .working, createdAt: now)))
    store.apply(.approvalUpsert(Fixture.approval(threadId: "thr_r3")))
    let sections = store.inboxSections()
    #expect(sections.map(\.group) == [.needsYou])
    #expect(Set(sections.flatMap(\.threads).map(\.id)) == ["thr_r1", "thr_r3"])
  }

  @Test func loadingARunKeepsItsRoutine() async {
    var run = Fixture.thread("thr_r1", taskId: "run_1", notePath: "Routines/A.md")
    run.routineId = "rtn_1"
    run.updatedAt = Date().epochMillis
    let thread = run
    client.script { $0.thread = { _ in ThreadResponse(thread: thread, approvals: []) } }
    await store.loadThread("thr_r1")
    #expect(store.threads["thr_r1"]?.routineId == "rtn_1")
    #expect(store.inboxSections().isEmpty)
  }

  @Test func loadRunsReplacesTheRoutinesRunsAndIsRefreshed() async {
    store.apply(.threadUpsert(Fixture.run("thr_gone")))
    store.apply(.threadUpsert(Fixture.summary()))
    client.script { $0.routineRuns = { _ in [Fixture.run("thr_r1"), Fixture.run("thr_r2")] } }
    await store.loadRuns(ofRoutine: "rtn_1")
    #expect(Set(store.runs(ofRoutine: "rtn_1").map(\.id)) == ["thr_r1", "thr_r2"])
    #expect(store.threads["thr_1"] != nil, "other threads stay")
    client.script { $0.routineRuns = { _ in [Fixture.run("thr_r3")] } }
    await store.refresh()
    #expect(store.runs(ofRoutine: "rtn_1").map(\.id) == ["thr_r3"])
    #expect(client.calls("threads:routine:rtn_1").count == 2)
    #expect(client.calls("routines").count >= 1, "refresh fetches the routines")
  }

  // MARK: Actions

  @Test func runNowReturnsTheRunsThread() async {
    let started = Fixture.routine(
      lastRun: RoutineRun(threadId: "thr_new", trigger: .manual, status: .working, startedAt: 9))
    client.script {
      $0.runRoutine = { _ in RoutineRunResponse(routine: started, threadId: "thr_new") }
      $0.routineRuns = { _ in [Fixture.run("thr_new", status: .working)] }
    }
    store.apply(.routinesChanged([Fixture.routine()]))
    let threadId = await store.runRoutine("rtn_1")
    #expect(threadId == "thr_new")
    #expect(store.routine("rtn_1")?.isRunning == true)
    #expect(store.runs(ofRoutine: "rtn_1").map(\.id) == ["thr_new"])
    #expect(store.routineAlerts.isEmpty && store.busyRoutineIds.isEmpty)
  }

  @Test func runNowExplainsA409WithTheDaemonsReason() async {
    client.script {
      $0.runRoutine = { _ in
        throw Fixture.apiError(409, .conflict, "“Morning briefing” is already running.")
      }
    }
    store.apply(.routinesChanged([Fixture.routine()]))
    #expect(await store.runRoutine("rtn_1") == nil)
    let alert = store.routineAlerts["rtn_1"]
    #expect(alert?.kind == .cantRunNow)
    #expect(alert?.title == "“Morning briefing” can't run now")
    #expect(alert?.message == "“Morning briefing” is already running.")
    #expect(store.lastError == nil)
  }

  @Test(arguments: [
    (
      Fixture.routine(
        lastRun: RoutineRun(threadId: "t", trigger: .manual, status: .working, startedAt: 1)),
      "A run is still going. Wait for it to finish, or stop it."
    ),
    (Fixture.routine(error: "Couldn't read “x”."), "Fix its problem first: Couldn't read “x”."),
    (
      Fixture.routine(extraRunsLeft: 0),
      "Today's extra runs are used up. It runs again at its next scheduled time."
    ),
  ])
  func runNowExplainsABare409FromTheRoutine(_ routine: Routine, _ message: String) async {
    client.script { $0.runRoutine = { _ in throw Fixture.apiError(409, .conflict, nil) } }
    store.apply(.routinesChanged([routine]))
    await store.runRoutine(routine.id)
    #expect(store.routineAlerts[routine.id]?.message == message)
  }

  @Test func runNowExplainsA503() async {
    client.script {
      $0.runRoutine = { _ in throw Fixture.apiError(503, .agentUnavailable, "The agent is paused.")
      }
    }
    store.apply(.routinesChanged([Fixture.routine()]))
    await store.runRoutine("rtn_1")
    #expect(store.routineAlerts["rtn_1"]?.kind == .agentUnavailable)
    #expect(store.routineAlerts["rtn_1"]?.title == "The agent can't run routines right now")
    #expect(store.routineAlerts["rtn_1"]?.message == "The agent is paused.")

    client.script { $0.runRoutine = { _ in throw Fixture.apiError(503, .agentUnavailable, nil) } }
    store.apply(.agentStatus(Fixture.status(problem: "OPENROUTER_API_KEY is missing")))
    await store.runRoutine("rtn_1")
    #expect(store.routineAlerts["rtn_1"]?.message == "OPENROUTER_API_KEY is missing")

    store.dismissRoutineAlert("rtn_1")
    #expect(store.routineAlerts["rtn_1"] == nil)
  }

  @Test func pauseFlipsAtOnceAndRollsBackOnFailure() async {
    let gate = Gate()
    client.script {
      $0.pauseRoutine = { _, paused in
        await gate.wait()
        throw DaemonClientError.unreachable("gone")
      }
    }
    store.apply(.routinesChanged([Fixture.routine()]))
    let pause = Task { await store.setRoutinePaused("rtn_1", true) }
    #expect(await waitForArrivals(gate))
    #expect(store.routine("rtn_1")?.paused == true && store.routine("rtn_1")?.nextRunAt == nil)
    #expect(store.busyRoutineIds == ["rtn_1"])
    await gate.open()
    #expect(await pause.value == false)
    #expect(store.routine("rtn_1") == Fixture.routine())
    #expect(store.routineAlerts["rtn_1"]?.title == "Couldn't pause “Morning briefing”")
    #expect(client.calls.contains("pauseRoutine:rtn_1"))
  }

  @Test func resumeAdoptsTheDaemonsAnswer() async {
    client.script { $0.pauseRoutine = { _, paused in Fixture.routine(paused: paused) } }
    store.apply(.routinesChanged([Fixture.routine(paused: true)]))
    #expect(await store.setRoutinePaused("rtn_1", false))
    #expect(store.routine("rtn_1") == Fixture.routine())
    #expect(client.calls.contains("resumeRoutine:rtn_1"))
  }

  @Test func createAddsTheRoutine() async throws {
    client.script {
      $0.createRoutine = { request in Fixture.routine("rtn_9", name: request.name) }
    }
    let draft = RoutineDraft(
      name: " Tea ", schedule: " every day at 16:00 ", instructions: "Remind me.\n")
    #expect(draft.request.name == "Tea" && draft.request.schedule == "every day at 16:00")
    #expect(draft.request.instructions == "Remind me." && draft.request.uses == nil)
    let created = try await store.createRoutine(draft.request).get()
    #expect(created.id == "rtn_9" && store.routine("rtn_9")?.name == "Tea")
  }

  @Test(arguments: [
    (
      Fixture.apiError(400, .invalidRequest, "Couldn't read “whenever”."),
      RoutineFormError(field: .schedule, message: "Couldn't read “whenever”.")
    ),
    (
      Fixture.apiError(409, .conflict, "A routine named “Tea” already exists."),
      RoutineFormError(field: .name, message: "A routine named “Tea” already exists.")
    ),
    (
      Fixture.apiError(400, .invalidPath, "A routine's name can't start with a dot."),
      RoutineFormError(field: .name, message: "A routine's name can't start with a dot.")
    ),
    (
      Fixture.apiError(400, .invalidRequest, "✖ Too small\n  → at instructions"),
      RoutineFormError(field: .instructions, message: "✖ Too small")
    ),
    (
      DaemonClientError.unreachable("connection refused"),
      RoutineFormError(
        field: .other, message: "Can't reach the Daily Do List daemon (connection refused).")
    ),
  ])
  func createSaysWhichFieldIsWrong(_ error: DaemonClientError, _ expected: RoutineFormError)
    async
  {
    client.script { $0.createRoutine = { _ in throw error } }
    let result = await store.createRoutine(
      CreateRoutineRequest(name: "Tea", schedule: "x", instructions: "y"))
    #expect(result == .failure(expected))
    #expect(store.routines.isEmpty)
  }

  // MARK: Drafts

  @Test func draftsStartFromATemplateOrATask() {
    let template = RoutineTemplate(
      id: "price-watch", name: "Price watch", description: "d", schedule: "every 2 hours",
      notify: .whenChanged, uses: [.web], instructions: "Check the price.")
    let fromTemplate = RoutineDraft(template: template)
    #expect(fromTemplate.name == "Price watch" && fromTemplate.schedule == "every 2 hours")
    #expect(fromTemplate.notify == .whenChanged && fromTemplate.uses == [.web])
    #expect(fromTemplate.isComplete && fromTemplate.templateId == "price-watch")

    let repeated = RoutineDraft(
      repeating: " Check the price of [[Kettle]]: under $80? #shopping ", threadId: "thr_1")
    #expect(repeated.name == "Check the price of Kettle under $80 shopping")
    #expect(repeated.schedule.isEmpty && !repeated.isComplete, "the user picks the schedule")
    #expect(repeated.instructions == "Check the price of [[Kettle]]: under $80? #shopping")
    #expect(repeated.repeatsThreadId == "thr_1" && repeated.templateId == nil)
    #expect(RoutineDraft(repeating: "..hidden", threadId: "t").name == "hidden")
    #expect(
      RoutineDraft(repeating: String(repeating: "a", count: 80), threadId: "t").name.count == 60)
  }
}

@MainActor
@Suite("Routine notifications")
struct RoutineNotifierTests {
  let client = FakeDaemonClient()
  let center = FakeNotificationCenter()
  let store: AgentStore
  let notifier: ApprovalNotifier

  init() {
    store = AgentStore(client: client, now: { NotifierTests.now })
    notifier = ApprovalNotifier(store: store, center: center)
  }

  private func notification(
    _ threadId: String = "thr_r1", status: TaskAgentStatus = .done, at: EpochMillis = 1
  ) -> RoutineNotification {
    RoutineNotification(
      routineId: "rtn_1", title: "Morning briefing", body: "3 meetings · 68°F sunny",
      threadId: threadId, status: status, at: at)
  }

  @Test func postsFinishedRunsAndOpensTheRunOnClick() async throws {
    var opened: [(String, String)] = []
    var activated = 0
    notifier.onOpenRoutineRun = { opened.append(($0, $1)) }
    notifier.activateApp = { activated += 1 }
    notifier.start()
    store.apply(.routineNotification(notification()))
    try await eventually { center.posted.count == 1 }
    let posted = center.posted.first
    #expect(posted?.id == "ddl.routine.thr_r1" && posted?.title == "Morning briefing")
    #expect(posted?.body == "3 meetings · 68°F sunny" && posted?.subtitle == nil)
    #expect(posted?.categoryIdentifier == ApprovalNotifier.routineRunCategory)
    #expect(posted?.threadIdentifier == "routine.rtn_1")
    #expect(center.categories.contains { $0.identifier == ApprovalNotifier.routineRunCategory })

    await notifier.handle(
      AgentNotificationResponse(
        notificationId: "ddl.routine.thr_r1",
        actionIdentifier: AgentNotificationResponse.defaultAction,
        userInfo: posted?.userInfo ?? [:]))
    #expect(activated == 1)
    #expect(opened.map(\.0) == ["rtn_1"] && opened.map(\.1) == ["thr_r1"])
  }

  @Test func failuresSayWhyAndRunsOnScreenStayQuiet() async throws {
    notifier.isThreadOnScreen = { $0 == "thr_seen" }
    notifier.start()
    store.apply(.routineNotification(notification("thr_seen")))
    store.apply(.routineNotification(notification("thr_r2", status: .failed, at: 2)))
    try await eventually { center.posted.count == 1 }
    #expect(center.posted.first?.subtitle == "Run failed")
    #expect(center.posted.first?.id == "ddl.routine.thr_r2")
  }

  @Test func notificationsFromBeforeStartDontBanner() async throws {
    store.apply(.routineNotification(notification()))
    notifier.start()
    store.apply(.routineNotification(notification("thr_r2", at: 2)))
    try await eventually { center.posted.count == 1 }
    #expect(center.posted.map(\.id) == ["ddl.routine.thr_r2"])
  }

  @Test func finishedRunsDontAlsoCountAsFinishedTasks() async {
    notifier.notifiesTaskCompletion = true
    store.apply(.threadUpsert(Fixture.run("thr_r1", status: .working)))
    notifier.start()
    store.apply(.threadUpsert(Fixture.run("thr_r1", status: .done, createdAt: 5)))
    try? await Task.sleep(for: .milliseconds(50))
    await notifier.waitForDeliveries()
    #expect(center.posted.isEmpty)
  }
}
