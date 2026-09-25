import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListClient

/// Routines of `InMemoryDaemonClient`: files in `Routines/`, runs as threads, the two events.
struct InMemoryRoutineTests {
  static let briefing = """
    ---
    schedule: every weekday at 7:30
    notify: when changed
    uses: [web]
    ---
    Brief me for the day.

    """

  static func client(
    _ clock: SimulationClock = .manual(), seed: InMemoryDaemonClient.Seed? = nil,
    agent: AgentSimulation = .enabled
  ) -> InMemoryDaemonClient {
    InMemoryDaemonClient(
      seed: seed ?? .files(["Routines/Morning briefing.md": briefing]), clock: clock, agent: agent,
      clientId: "macos_test")
  }

  static func routine(_ client: InMemoryDaemonClient, _ name: String) async throws -> Routine {
    try #require(try await client.routines().routines.first { $0.name == name })
  }

  static func notifications(_ items: [DaemonStreamItem]) -> [RoutineNotification] {
    InMemoryAgentTests.events(items).compactMap {
      if case .routineNotification(let notification) = $0 { notification } else { nil }
    }
  }

  static func routineLists(_ items: [DaemonStreamItem]) -> [[Routine]] {
    InMemoryAgentTests.events(items).compactMap {
      if case .routinesChanged(let routines) = $0 { routines } else { nil }
    }
  }

  // MARK: - Listing

  @Test func theDemoHasRoutinesWithRuns() async throws {
    let client = Self.client(seed: .demo)
    let list = try await client.routines()
    #expect(
      list.routines.map(\.name) == ["Morning briefing", "Price watch", "Someday", "Weekly review"])
    #expect(
      list.templates.map(\.id) == [
        "morning-briefing", "weekly-review", "carry-over", "price-watch", "news-digest",
        "inbox-triage",
      ])
    let briefing = try await Self.routine(client, "Morning briefing")
    #expect(briefing.scheduleText == "Every weekday at 7:30 AM")
    #expect(briefing.nextRunAt == 1_790_235_000_000, "Thursday 7:30 UTC")
    #expect(briefing.lastRun?.status == .done && briefing.runCount == 3)
    let paused = try await Self.routine(client, "Price watch")
    #expect(paused.paused && paused.nextRunAt == nil && paused.notify == .whenChanged)
    let broken = try await Self.routine(client, "Someday")
    #expect(broken.scheduleText == nil && broken.nextRunAt == nil)
    #expect(broken.error?.hasPrefix("Couldn't read “whenever”") == true)

    let runs = try await client.threads(routineId: briefing.id)
    #expect(runs.count == 3 && runs.allSatisfy { $0.routineId == briefing.id })
    #expect(runs.map(\.createdAt) == runs.map(\.createdAt).sorted(by: >))
    #expect(runs.first?.id == briefing.lastRun?.threadId)
    let today = try await client.threads(notePath: "Daily/2026-09-23.md", taskId: nil)
    #expect(!today.contains { $0.isRoutineRun })
  }

  @Test func routineIdsComeFromThePath() async throws {
    let client = Self.client()
    let routine = try await Self.routine(client, "Morning briefing")
    #expect(routine.id == "rtn_" + ContentHash.version(of: "Routines/Morning briefing.md"))
    #expect(try await client.routine(routine.id) == routine)
    await #expect(throws: DaemonClientError.self) { try await client.routine("rtn_missing") }
  }

  // MARK: - Files

  @Test func createWritesTheFileAndAnnouncesIt() async throws {
    let client = Self.client(.immediate(), seed: .empty)
    var created: Routine?
    let items = try await InMemoryAgentTests.collect(client) {
      created = try await client.createRoutine(
        CreateRoutineRequest(
          name: "Tea time", schedule: "every day at 16:00", instructions: "  Remind me to rest. ",
          notify: .never, uses: [.web]))
    }
    let routine = try #require(created)
    #expect(routine.path == "Routines/Tea time.md" && routine.name == "Tea time")
    #expect(routine.scheduleText == "Every day at 4:00 PM" && routine.notify == .never)
    #expect(routine.nextRunAt == 1_790_179_200_000 && routine.error == nil)
    let note = try await client.readNote("Routines/Tea time.md")
    #expect(
      note.content
        == "---\nschedule: every day at 16:00\nnotify: never\nuses: [web]\n---\nRemind me to rest.\n"
    )
    let events = InMemoryAgentTests.events(items)
    #expect(events.map(\.type).suffix(2) == ["vault.changed", "routines.changed"])
    #expect(Self.routineLists(items).last == [routine])
  }

  @Test func createExplainsWhatIsWrong() async throws {
    let client = Self.client(.immediate())
    let cases: [(CreateRoutineRequest, Int, ApiErrorCode, String)] = [
      (
        CreateRoutineRequest(name: "Tea", schedule: "whenever", instructions: "x"), 400,
        .invalidRequest, "Couldn't read “whenever” in “whenever”."
      ),
      (
        CreateRoutineRequest(name: "Tea", schedule: "every 5 minutes", instructions: "x"), 400,
        .invalidRequest, "Routines run at most every 15 minutes."
      ),
      (
        CreateRoutineRequest(name: "a/b", schedule: "hourly", instructions: "x"), 400,
        .invalidPath, "A routine's name can't contain"
      ),
      (
        CreateRoutineRequest(name: "Tea", schedule: "hourly", instructions: " \n"), 400,
        .invalidRequest, "✖ Too small"
      ),
      (
        CreateRoutineRequest(name: "Morning briefing", schedule: "hourly", instructions: "x"), 409,
        .conflict, "A routine named “Morning briefing” already exists."
      ),
    ]
    for (request, status, code, message) in cases {
      do {
        _ = try await client.createRoutine(request)
        Issue.record("expected an error for \(request.name) / \(request.schedule)")
      } catch let error as DaemonClientError {
        #expect(error.httpStatus == status && error.apiErrorCode == code)
        #expect(error.localizedDescription.hasPrefix(message), "\(error.localizedDescription)")
      }
    }
    #expect(try await client.routines().routines.count == 1)
  }

  @Test func pauseAndResumeRewriteThePausedLine() async throws {
    let client = Self.client(.immediate())
    let id = try await Self.routine(client, "Morning briefing").id
    let items = try await InMemoryAgentTests.collect(client) {
      let paused = try await client.pauseRoutine(id)
      #expect(paused.paused && paused.nextRunAt == nil)
      #expect(
        try await client.readNote(paused.path).content.contains("uses: [web]\npaused: true\n---"))
      let resumed = try await client.resumeRoutine(id)
      #expect(!resumed.paused && resumed.nextRunAt != nil)
      #expect(try await client.readNote(resumed.path).content.contains("paused: false\n---"))
    }
    #expect(Self.routineLists(items).map { $0.first?.paused } == [true, false])
  }

  @Test func editingTheFileChangesTheRoutine() async throws {
    let client = Self.client(.immediate())
    let items = try await InMemoryAgentTests.collect(client) {
      try await client.simulateExternalEdit(
        "Routines/Morning briefing.md", content: "---\nschedule: hourly\n---\nCheck.\n")
    }
    #expect(Self.routineLists(items).last?.first?.scheduleText == "Every hour")
  }

  // MARK: - Runs

  @Test func runNowStartsARunThreadThatReportsBack() async throws {
    let client = Self.client()
    let id = try await Self.routine(client, "Morning briefing").id
    var threadId = ""
    let items = try await InMemoryAgentTests.collect(client) {
      let started = try await client.runRoutine(id)
      threadId = started.threadId
      #expect(started.routine.lastRun?.threadId == threadId)
      #expect(started.routine.lastRun?.status == .working)
      #expect(started.routine.lastRun?.trigger == .manual)
      #expect(started.routine.runCount == 1 && started.routine.extraRunsLeft == 4)
      #expect(started.routine.isRunning)
      await #expect(throws: DaemonClientError.self) { try await client.runRoutine(id) }
      await client.runUntilIdle()
    }
    let thread = try await client.thread(threadId).thread
    #expect(thread.routineId == id && thread.notePath == "Routines/Morning briefing.md")
    #expect(thread.status == .done && thread.taskId?.hasPrefix("run_") == true)
    #expect(try await client.threads(routineId: id).map(\.id) == [threadId])
    let routine = try await Self.routine(client, "Morning briefing")
    #expect(routine.lastRun?.status == .done && routine.lastRun?.changed == true)
    #expect(routine.lastRun?.summary == "Something new" && routine.lastRun?.finishedAt != nil)
    let notification = try #require(Self.notifications(items).first)
    #expect(notification.routineId == id && notification.threadId == threadId)
    #expect(notification.title == "Morning briefing" && notification.status == .done)
    let upserts = InMemoryAgentTests.events(items).compactMap {
      if case .threadUpsert(let summary) = $0, summary.id == threadId { summary } else { nil }
    }
    #expect(!upserts.isEmpty && upserts.allSatisfy { $0.routineId == id })

    // The second run finds nothing new: `notify: when changed` stays quiet.
    let quiet = try await InMemoryAgentTests.collect(client) {
      _ = try await client.runRoutine(id)
      await client.runUntilIdle()
    }
    #expect(Self.notifications(quiet).isEmpty)
    #expect(try await Self.routine(client, "Morning briefing").lastRun?.changed == false)
  }

  @Test func runNowIsRefusedWithAReason() async throws {
    let broken = Self.client(
      .immediate(), seed: .files(["Routines/Someday.md": "---\nschedule: whenever\n---\nx\n"]))
    let brokenId = try await Self.routine(broken, "Someday").id
    do {
      _ = try await broken.runRoutine(brokenId)
      Issue.record("expected 409")
    } catch let error as DaemonClientError {
      #expect(error.httpStatus == 409)
      #expect(error.localizedDescription.hasPrefix("“Someday” has a problem: Couldn't read"))
    }

    let client = Self.client(.immediate())
    let id = try await Self.routine(client, "Morning briefing").id
    for _ in 0..<5 { _ = try await client.runRoutine(id) }
    do {
      _ = try await client.runRoutine(id)
      Issue.record("expected 409")
    } catch let error as DaemonClientError {
      #expect(error.httpStatus == 409 && error.localizedDescription.contains("extra runs"))
    }

    _ = try await client.setAgentEnabled(false)
    do {
      _ = try await client.runRoutine(id)
      Issue.record("expected 503")
    } catch let error as DaemonClientError {
      #expect(error.httpStatus == 503 && error.apiErrorCode == .agentUnavailable)
    }

    let off = Self.client(.immediate(), agent: .disabled)
    let offId = try await Self.routine(off, "Morning briefing").id
    await #expect(throws: DaemonClientError.self) { try await off.runRoutine(offId) }
  }

  @Test func aRunCanWaitOnAnApproval() async throws {
    let client = Self.client(
      .immediate(),
      seed: .files([
        "Routines/Beans.md": "---\nschedule: every monday at 9:00\n---\nOrder coffee beans.\n"
      ]))
    let id = try await Self.routine(client, "Beans").id
    let started = try await client.runRoutine(id)
    let approval = try #require(try await client.approvals(status: .pending).first)
    #expect(approval.threadId == started.threadId)
    #expect(try await Self.routine(client, "Beans").lastRun?.status == .waitingApproval)
    #expect(try await client.threads(routineId: id).first?.pendingApprovals == 1)
    _ = try await client.decideApproval(approval.id, ApprovalDecisionRequest(decision: .approve))
    #expect(try await Self.routine(client, "Beans").lastRun?.status == .done)
  }

  @Test func stoppingARunEndsIt() async throws {
    let client = Self.client()
    let id = try await Self.routine(client, "Morning briefing").id
    let started = try await client.runRoutine(id)
    _ = try await client.cancelThread(started.threadId)
    let routine = try await Self.routine(client, "Morning briefing")
    #expect(routine.lastRun?.status == .cancelled && !routine.isRunning)
    _ = try await client.retryThread(started.threadId)
    await client.runUntilIdle()
    #expect(try await client.thread(started.threadId).thread.status == .done)
  }
}

/// The fake's port of `@ddl/core`'s schedule phrases.
struct FakeRoutineScheduleTests {
  @Test(arguments: [
    ("every weekday at 7:30", "Every weekday at 7:30 AM"),
    ("every sunday at 18:00", "Every Sunday at 6:00 PM"),
    ("every weekday at 9:00 and 14:00", "Every weekday at 9:00 AM and 2:00 PM"),
    ("every 2 hours", "Every 2 hours"),
    ("hourly", "Every hour"),
    ("Every Monday, Wednesday & Friday at 7am", "Every Monday, Wednesday and Friday at 7:00 AM"),
    (
      "every 30 minutes from 9 to 17 on weekdays",
      "Every 30 minutes from 9:00 AM to 5:00 PM on weekdays"
    ),
    ("every month on the 1st at 9:00", "Every month on the 1st at 9:00 AM"),
    ("daily at noon", "Every day at 12:00 PM"),
  ])
  func readsPhrases(_ phrase: String, _ text: String) throws {
    #expect(try FakeRoutineSchedule.parse(phrase).get().text == text)
  }

  @Test(arguments: [
    ("whenever", "Couldn't read “whenever” in “whenever”."),
    ("every morning", "Say when: e.g. “every day at 8:00” instead of “every morning”."),
    ("every day", "Add a time: “every day” needs one, e.g. “every day at 8:00”."),
    ("every 10 minutes", "Routines run at most every 15 minutes."),
    ("every other day at 9", "“every other …” isn't supported"),
    ("", "Add a schedule, e.g."),
  ])
  func explainsWhatItCantRead(_ phrase: String, _ message: String) {
    guard case .failure(let error) = FakeRoutineSchedule.parse(phrase) else {
      Issue.record("\(phrase) parsed")
      return
    }
    #expect(error.message.hasPrefix(message), "\(error.message)")
  }

  @Test func findsTheNextRunInLocalTime() throws {
    let calendar = FakeCalendar(timeZone: try #require(TimeZone(identifier: "America/Los_Angeles")))
    let schedule = try FakeRoutineSchedule.parse("every weekday at 7:30").get()
    // Friday 2026-09-25 10:00 PDT → Monday 7:30 PDT.
    let friday = Date(epochMillis: 1_790_355_600_000)
    #expect(schedule.nextRun(after: friday, calendar: calendar)?.epochMillis == 1_790_605_800_000)
    let interval = try FakeRoutineSchedule.parse("every 2 hours").get()
    #expect(
      interval.nextRun(after: friday, calendar: calendar)?.epochMillis == 1_790_362_800_000,
      "12:00 PDT")
  }
}
