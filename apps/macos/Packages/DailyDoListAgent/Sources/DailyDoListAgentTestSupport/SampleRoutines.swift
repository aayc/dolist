import DailyDoListModels
import Foundation

@testable import DailyDoListAgent

/// Routines of the sample: a morning briefing with finished runs, a paused price watch, a weekly
/// review running now and a file whose schedule can't be read. Synthetic content only.
enum SampleRoutines {
  static let briefingId = "rtn_sample_briefing"
  static let priceWatchId = "rtn_sample_price"
  static let reviewId = "rtn_sample_review"
  static let brokenId = "rtn_sample_someday"
  static let latestBriefingRunId = "thr_run_briefing_0"
  static let reviewRunId = "thr_run_review_0"

  static let templates: [RoutineTemplate] = [
    RoutineTemplate(
      id: "morning-briefing", name: "Morning briefing",
      description: "Your day at a glance: calendar, weather, leftovers and news.",
      schedule: "every weekday at 7:30", notify: .always, uses: [.web, .connectors],
      instructions:
        "Brief me for the day: my calendar, the weather where I am, what I didn't finish yesterday, and anything new from my news sources. Under 10 lines."
    ),
    RoutineTemplate(
      id: "weekly-review", name: "Weekly review",
      description: "Sunday evening: what got done, what slipped, what's next.",
      schedule: "every sunday at 18:00", notify: .always,
      instructions:
        "Review my week from this week's daily notes: what got done, what slipped and why, and my top 3 priorities for next week."
    ),
    RoutineTemplate(
      id: "carry-over", name: "Carry over unfinished tasks",
      description: "Moves yesterday's open tasks into today's note.",
      schedule: "every day at 6:00", notify: .whenChanged,
      instructions:
        "Add yesterday's unfinished tasks to today's note under a “Carried over” heading."),
    RoutineTemplate(
      id: "price-watch", name: "Price watch",
      description: "Checks a price or stock level and tells you when it moves.",
      schedule: "every 2 hours", notify: .whenChanged, uses: [.web],
      instructions: "Check the price and availability of <product> at <store link>."),
    RoutineTemplate(
      id: "news-digest", name: "News digest",
      description: "Evening digest of the topics you follow, with links.",
      schedule: "every day at 18:00", notify: .always, uses: [.web],
      instructions: "Summarize today's most important news about <topics>: 5 bullets with links."),
    RoutineTemplate(
      id: "inbox-triage", name: "Inbox triage",
      description: "Sorts new email twice a day and drafts easy replies.",
      schedule: "every weekday at 9:00 and 14:00", notify: .whenChanged, uses: [.connectors],
      instructions: "Go through my new email since the last run and draft replies (never send)."),
  ]

  /// The latest weekday 7:30 slots at or before `now`, newest first, and the next one after it.
  static func briefingSlots(now: Date, count: Int, calendar: Calendar = .current) -> (
    past: [EpochMillis], next: EpochMillis
  ) {
    func slot(daysFrom offset: Int) -> Date? {
      calendar.date(byAdding: .day, value: offset, to: now).flatMap {
        calendar.date(bySettingHour: 7, minute: 30, second: 0, of: $0)
      }
    }
    func isWeekday(_ date: Date) -> Bool { !calendar.isDateInWeekend(date) }
    var past: [EpochMillis] = []
    var offset = 0
    while past.count < count, offset > -14, let date = slot(daysFrom: offset) {
      if date <= now, isWeekday(date) { past.append(date.epochMillis) }
      offset -= 1
    }
    offset = 0
    var next = now.addingTimeInterval(86_400)
    while offset < 14, let date = slot(daysFrom: offset) {
      if date > now, isWeekday(date) {
        next = date
        break
      }
      offset += 1
    }
    return (past, next.epochMillis)
  }

  static func add(to snapshot: inout SampleData.Snapshot) {
    let now = snapshot.now.epochMillis
    let hour: EpochMillis = 3_600_000
    let day: EpochMillis = 24 * hour
    let briefingSlots = Self.briefingSlots(now: snapshot.now, count: 3)
    let sundayEvening =
      Calendar.current.nextDate(
        after: snapshot.now, matching: DateComponents(hour: 18, minute: 0, weekday: 1),
        matchingPolicy: .nextTime)?.epochMillis ?? now + 3 * day
    var threads: [AgentThread] = []

    func run(
      _ id: String, routine: String, name: String, at: EpochMillis, status: TaskAgentStatus,
      report: String?, trigger: String
    ) -> AgentThread {
      var messages: [ThreadMessage] = [
        .status(
          StatusMessage(
            id: "\(id)_m0", author: "system", createdAt: at, status: .working, text: trigger))
      ]
      if let report {
        messages.append(
          .text(
            TextMessage(
              id: "\(id)_m1", author: "subagent:research", createdAt: at + 40_000, role: .agent,
              text: report)))
      }
      if !status.isActive {
        messages.append(
          .status(
            StatusMessage(
              id: "\(id)_m2", author: "system", createdAt: at + 45_000, status: status,
              text: "Run complete")))
      }
      return AgentThread(
        id: id, taskId: "run_\(id)", notePath: "Routines/\(name).md", title: name, status: status,
        createdAt: at, updatedAt: at + (status.isActive ? 20_000 : 45_000), messages: messages,
        routineId: routine)
    }

    let briefingReports = [
      "Good morning! **3 meetings** today (first at 9:30), 68°F and sunny. Carried over: *call the plumber*. Two new posts from your news sources.",
      "**2 meetings** today, light rain after 4 PM. Nothing carried over.",
      "A quiet day: no meetings, 72°F. One new post from your news sources.",
    ]
    for (index, (report, at)) in zip(briefingReports, briefingSlots.past).enumerated() {
      threads.append(
        run(
          "thr_run_briefing_\(index)", routine: briefingId, name: "Morning briefing", at: at,
          status: .done, report: report, trigger: "Scheduled run · Every weekday at 7:30 AM"))
    }
    threads.append(
      run(
        "thr_run_price_0", routine: priceWatchId, name: "Price watch", at: now - 26 * hour,
        status: .done, report: "Still $89 at shop.example.com. Nothing changed.",
        trigger: "Scheduled run · Every 2 hours"))
    threads.append(
      run(
        reviewRunId, routine: reviewId, name: "Weekly review", at: now - 4 * 60_000,
        status: .working, report: nil, trigger: "Run now"))

    let briefing = threads[0]
    snapshot.routines = [
      Routine(
        id: briefingId, path: "Routines/Morning briefing.md", name: "Morning briefing",
        schedule: "every weekday at 7:30", scheduleText: "Every weekday at 7:30 AM",
        notify: .always, uses: [.web, .connectors],
        instructions: templates[0].instructions, nextRunAt: briefingSlots.next,
        lastRun: RoutineRun(
          threadId: briefing.id, trigger: .schedule, status: .done, startedAt: briefing.createdAt,
          finishedAt: briefing.updatedAt, summary: "3 meetings · 68°F sunny", changed: true),
        runCount: 12, extraRunsLeft: 5),
      Routine(
        id: priceWatchId, path: "Routines/Price watch.md", name: "Price watch",
        schedule: "every 2 hours", scheduleText: "Every 2 hours", notify: .whenChanged,
        uses: [.web], paused: true,
        instructions: "Check the price of the example kettle at https://shop.example.com/kettle.",
        lastRun: RoutineRun(
          threadId: "thr_run_price_0", trigger: .schedule, status: .done,
          startedAt: now - 26 * hour, finishedAt: now - 26 * hour + 45_000, summary: "Still $89",
          changed: false),
        runCount: 3, extraRunsLeft: 5),
      Routine(
        id: brokenId, path: "Routines/Someday.md", name: "Someday", schedule: "whenever",
        instructions: "Tidy up the Ideas note.",
        error:
          "Couldn't read “whenever” in “whenever”. Try “every weekday at 7:30”, “every 2 hours” or “every month on the 1st at 9:00”.",
        runCount: 0, extraRunsLeft: 5),
      Routine(
        id: reviewId, path: "Routines/Weekly review.md", name: "Weekly review",
        schedule: "every sunday at 18:00", scheduleText: "Every Sunday at 6:00 PM",
        instructions: templates[1].instructions, nextRunAt: sundayEvening,
        lastRun: RoutineRun(
          threadId: reviewRunId, trigger: .manual, status: .working, startedAt: now - 4 * 60_000),
        runCount: 1, extraRunsLeft: 4),
    ]
    snapshot.routineTemplates = templates
    snapshot.threads += threads.map { AgentState.summarize($0, pendingApprovals: 0) }
    snapshot.loadedThreads += [threads[0], threads[threads.count - 1]]
  }
}
