import DailyDoListClient
import DailyDoListModels
import Foundation

/// Rich synthetic agent data for previews, demo mode and screenshots: a day of tasks in every
/// state, a booking thread with every message kind (including a pending approval), artifacts of
/// each kind and live surface frames. Everything is made up (people, places, sites use
/// `example` names); times are relative to `now`.
public enum SampleData {
  public static let bookingThreadId = "thr_sample_booking"
  public static let emailThreadId = "thr_sample_email"
  public static let desksThreadId = "thr_sample_desks"
  public static let passportThreadId = "thr_sample_passport"
  public static let coffeeThreadId = "thr_sample_coffee"
  public static let hikesThreadId = "thr_sample_hikes"
  public static let lunchThreadId = "thr_sample_lunch"
  public static let cleanupThreadId = "thr_sample_cleanup"
  public static let subscriptionThreadId = "thr_sample_subscription"
  public static let libraryThreadId = "thr_sample_library"
  /// A question written as prose; its thread is anchored to that line.
  public static let questionThreadId = "thr_sample_question"
  public static let questionAnchorId = "anc_sample_question"

  public static let reserveApprovalId = "apr_sample_reserve"
  public static let depositApprovalId = "apr_sample_deposit"
  public static let emailApprovalId = "apr_sample_email"
  public static let retailersApprovalId = "apr_sample_retailers"

  /// The desks thread's answer: numbered citations of its sources and a note it links.
  public static let desksAnswer = """
    **Pick: Example Rise Pro ($449)** — dual motor, 25–50 in, 7-year warranty [1](https://desks.example/rise-pro). \
    Sample Lift 2 is often on sale for $349 [2](https://office-shop.example/lift-2#deals), and reviewers call the \
    Demo Desk Mini wobbly above 40 in [3](https://reviews.example/standing-desks).

    It fits the desk space noted in [[Projects/Home Office|your home office note]]. The full comparison is attached.
    """

  public static let questionAnswer = """
    **About 1,250 ft (381 m)** to the roof, 1,380 ft with its spire [1](https://city.example/landmarks/ridge-tower). \
    It has been the tallest building downtown since it opened [2](https://skyline.example/towers#ridge).

    Saved to [[Ideas]] under places to visit.
    """

  public static let questionSources = [
    CitedSource(
      url: "https://city.example/landmarks/ridge-tower", title: "Ridge Tower — City Landmarks",
      snippet: "Ridge Tower rises 1,250 ft (381 m) to its roof; the spire brings it to 1,380 ft."),
    CitedSource(
      url: "https://skyline.example/towers", title: "Downtown skyline: every tower ranked",
      snippet: "Ridge Tower has topped the downtown skyline since its completion."),
  ]

  /// The pages the desks thread cites, as the agent saw them.
  public static let desksSources = [
    CitedSource(
      url: "https://desks.example/rise-pro", title: "Example Rise Pro — Desks Example",
      snippet: "Dual-motor standing desk, 25–50 in height range, 7-year warranty. Free shipping."),
    CitedSource(
      url: "https://office-shop.example/lift-2", title: "Sample Lift 2 standing desk",
      snippet: "Single motor, 27–47 in. Regularly discounted to $349."),
    CitedSource(url: "https://reviews.example/standing-desks", title: "The best standing desks of the year"),
  ]

  /// Everything a store needs, as the daemon would serve it.
  public struct Snapshot: Sendable {
    public var now: Date
    public var dailyNotePath: String
    public var status: AgentStatusResponse
    public var records: [TaskAgentRecord]
    /// Summaries of every thread (the inbox).
    public var threads: [ThreadSummary]
    /// Full threads.
    public var loadedThreads: [AgentThread]
    public var approvals: [ApprovalRequest]
    /// Artifact bodies by artifact id.
    public var artifacts: [String: ArtifactPayload]
    public var frames: [SurfaceFrame]

    /// The response of `GET /api/threads/:id`.
    public func threadResponse(_ id: String) -> ThreadResponse? {
      guard let thread = loadedThreads.first(where: { $0.id == id }) else { return nil }
      return ThreadResponse(thread: thread, approvals: approvals.filter { $0.threadId == id })
    }
  }

  /// A store filled with the sample (backed by a `SampleDaemonClient`, so actions work).
  @MainActor
  public static func makeStore(now: Date = Date()) -> AgentStore {
    let snapshot = snapshot(now: now)
    let store = AgentStore(client: SampleDaemonClient(snapshot: snapshot))
    store.load(snapshot)
    return store
  }

  public static func snapshot(now: Date = Date()) -> Snapshot {
    Builder(now: now).build()
  }
}

extension AgentStore {
  /// Replaces the store's state with a snapshot (sample data, demo mode).
  func load(_ snapshot: SampleData.Snapshot) {
    todayNotePath = snapshot.dailyNotePath
    mutate { state in
      var changes = state.setStatus(snapshot.status)
      var byNote: [String: [TaskAgentRecord]] = [:]
      for record in snapshot.records { byNote[record.notePath, default: []].append(record) }
      for (notePath, records) in byNote {
        changes.formUnion(state.applyRecordsSnapshot(notePath: notePath, records: records))
      }
      changes.formUnion(state.applyThreadList(snapshot.threads, notePath: nil))
      for thread in snapshot.loadedThreads {
        if let response = snapshot.threadResponse(thread.id) {
          changes.formUnion(state.applyThreadResponse(response))
        }
      }
      for approval in snapshot.approvals {
        changes.formUnion(state.upsertApproval(approval, force: true))
      }
      return changes
    }
    for frame in snapshot.frames { apply(.surfaceFrame(frame)) }
  }
}

private struct Builder {
  let now: Date
  let notePath: String
  let yesterdayNotePath: String

  init(now: Date) {
    self.now = now
    self.notePath = Self.dailyNotePath(for: now)
    self.yesterdayNotePath = Self.dailyNotePath(for: now.addingTimeInterval(-86_400))
  }

  static func dailyNotePath(for date: Date) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .current
    let day = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "Daily/%04d-%02d-%02d.md", day.year ?? 2026, day.month ?? 1, day.day ?? 1)
  }

  /// `minutes` before now, in epoch milliseconds.
  func ago(_ minutes: Double) -> EpochMillis { now.addingTimeInterval(-minutes * 60).epochMillis }

  func build() -> SampleData.Snapshot {
    let threads = [booking(), email(), desks(), coffee(), question()]
    let approvals = self.approvals()
    var summaries = threads.map { thread in
      AgentState.summarize(
        thread, pendingApprovals: approvals.filter { $0.threadId == thread.id && $0.isPending }.count)
    }
    summaries += [passport(), hikes(), lunch(), cleanup(), subscription(), library()]
    return SampleData.Snapshot(
      now: now, dailyNotePath: notePath, status: status(), records: records(summaries),
      threads: summaries, loadedThreads: threads, approvals: approvals, artifacts: artifacts(),
      frames: frames())
  }

  // MARK: Status and records

  func status() -> AgentStatusResponse {
    AgentStatusResponse(
      mode: .live, enabled: true, model: AgentSettings.defaultModel, running: 2, queued: 1,
      pendingApprovals: 2,
      connectors: [ConnectorStatus(name: "mail", transport: .stdio, state: .connected, toolCount: 6)],
      execution: ExecutionStatus(
        provider: "local", capabilities: ExecutionCapabilities(shell: true, browser: true, computer: true)))
  }

  func records(_ summaries: [ThreadSummary]) -> [TaskAgentRecord] {
    let badges: [String: (line: Int, summary: String?, unread: Int)] = [
      SampleData.bookingThreadId: (3, "Trattoria Sole · 7:00 PM — needs your OK", 2),
      SampleData.emailThreadId: (4, "Draft ready — approve sending", 0),
      SampleData.desksThreadId: (5, "Example Rise Pro · $449", 1),
      SampleData.passportThreadId: (6, "Renewal by mail or in person?", 1),
      SampleData.coffeeThreadId: (7, "Adding House Blend to the cart", 0),
      SampleData.hikesThreadId: (8, nil, 0),
      SampleData.lunchThreadId: (9, nil, 0),
      SampleData.cleanupThreadId: (10, "Blocked: deleting files needs a narrower plan", 0),
      SampleData.subscriptionThreadId: (11, "Stopped", 0),
      SampleData.questionThreadId: (13, "About 1,250 ft", 1),
    ]
    return summaries.compactMap { summary in
      guard let badge = badges[summary.id], let taskId = summary.taskId else { return nil }
      return TaskAgentRecord(
        taskId: taskId, notePath: notePath, date: String(notePath.dropFirst(6).prefix(10)),
        text: summary.title, line: badge.line, status: summary.status, summary: badge.summary,
        threadId: summary.id, updatedAt: summary.updatedAt, unread: badge.unread,
        anchor: taskId.hasPrefix("anc_") ? .line : nil)
    }
  }

  // MARK: Threads

  func booking() -> AgentThread {
    let id = SampleData.bookingThreadId
    let agent = "subagent:booking"
    let messages: [ThreadMessage] = [
      .status(StatusMessage(id: "msg_b01", author: "system", createdAt: ago(52), status: .triaging, text: "Picked up by the orchestrator")),
      .text(TextMessage(id: "msg_b02", author: "orchestrator", createdAt: ago(52), role: .agent, text: "I'll look for an Italian restaurant with a table for **4 on Friday at 7 PM** near you, and ask before booking anything.")),
      .status(StatusMessage(id: "msg_b03", author: "system", createdAt: ago(51.5), status: .working, text: "Booking agent started")),
      .toolCall(ToolCallMessage(id: "msg_b04", author: agent, createdAt: ago(51.4), toolCallId: "call_b04", toolName: "web_search", label: "Search the web", input: ["query": "italian restaurant table for 4 friday 7pm patio"], status: .ok, resultPreview: "6 results · Trattoria Sole, Osteria Luna, Pasta Bar Nord…", endedAt: ago(51.4) + 1_840)),
      .toolCall(ToolCallMessage(id: "msg_b05", author: agent, createdAt: ago(51), toolCallId: "call_b05", toolName: "browser_navigate", label: "Open pasta-bar-nord.example", input: ["url": "https://pasta-bar-nord.example/book"], status: .error, resultPreview: "net::ERR_NAME_NOT_RESOLVED — the site didn't load.", endedAt: ago(51) + 2_410)),
      .text(TextMessage(id: "msg_b06", author: agent, createdAt: ago(49), role: .agent, text: """
        Found **3 options** with a free table on Friday:

        1. **Trattoria Sole** — 7:00 PM, patio seating ([menu](https://trattoria-sole.example/menu))
        2. **Osteria Luna** — 7:15 PM, needs a $40 deposit
        3. **Pasta Bar Nord** — 6:45 PM, counter seats only

        Trattoria Sole matches best. The details are in `options.json`.
        """)),
      .artifact(ArtifactMessage(id: "msg_b07", author: agent, createdAt: ago(48.5), artifactId: "art_sample_options")),
      .approval(ApprovalMessage(id: "msg_b08", author: agent, createdAt: ago(47.5), approvalId: SampleData.depositApprovalId)),
      .toolCall(ToolCallMessage(id: "msg_b09", author: agent, createdAt: ago(47.5), toolCallId: "call_b09", toolName: "browser_click", label: "Click “Pay $40 deposit”", input: ["element": "Pay $40 deposit button", "ref": "e17"], status: .blocked, resultPreview: "Denied by you: No deposits — pick a place that doesn't need one.", endedAt: ago(47.5) + 2_296_000)),
      .text(TextMessage(id: "msg_b10", author: "system", createdAt: ago(9), role: .system, text: "The booking agent picked up where it left off.")),
      .text(TextMessage(id: "msg_b11", author: "you", createdAt: ago(8), role: .user, text: "Patio if possible, please.")),
      .text(TextMessage(id: "msg_b12", author: agent, createdAt: ago(6), role: .agent, text: """
        Got it — Trattoria Sole has a patio table at 7:00 PM. I filled in the reservation form:

        > Party of 4 · Friday 7:00 PM · Patio · Alex Example

        It needs your OK before I submit it.
        """)),
      .toolCall(ToolCallMessage(id: "msg_b13", author: agent, createdAt: ago(5), toolCallId: "call_b13", toolName: "browser_type", label: "Fill in the reservation form", input: ["element": "Reservation form", "text": "4 guests · Fri 7:00 PM · Patio"], status: .ok, resultPreview: "5 fields filled", endedAt: ago(5) + 3_200)),
      .approval(ApprovalMessage(id: "msg_b14", author: agent, createdAt: ago(3), approvalId: SampleData.reserveApprovalId)),
      .toolCall(ToolCallMessage(id: "msg_b15", author: agent, createdAt: ago(3), toolCallId: "call_b15", toolName: "browser_click", label: "Click “Complete reservation”", input: ["element": "Complete reservation button", "ref": "e42"], status: .running)),
      .text(TextMessage(id: "msg_b16", author: agent, createdAt: ago(2.5), role: .agent, text: "Waiting for your approval before I submit the form", streaming: true)),
    ]
    let artifacts = [
      ArtifactMeta(id: "art_sample_options", threadId: id, title: "options.json", kind: .json, mimeType: "application/json", path: ".daily-do-list/artifacts/\(id)/art_sample_options.json", size: 612, createdAt: ago(48.5)),
      ArtifactMeta(id: "art_sample_summary", threadId: id, title: "Reservation summary", kind: .html, mimeType: "text/html", path: ".daily-do-list/artifacts/\(id)/art_sample_summary.html", size: 1_180, createdAt: ago(4)),
    ]
    return AgentThread(
      id: id, taskId: "tsk_sample_booking", notePath: notePath,
      title: "Book a table for 4 at an Italian place, Friday 7pm", status: .waitingApproval,
      createdAt: ago(52), updatedAt: ago(2.5), messages: messages, artifacts: artifacts,
      surfaces: [.browser])
  }

  func email() -> AgentThread {
    let id = SampleData.emailThreadId
    let agent = "subagent:writer"
    return AgentThread(
      id: id, taskId: "tsk_sample_email", notePath: notePath, title: "Email Sam the Q3 report draft",
      status: .waitingApproval, createdAt: ago(40), updatedAt: ago(12),
      messages: [
        .status(StatusMessage(id: "msg_e01", author: "system", createdAt: ago(40), status: .working, text: "Writer agent started")),
        .toolCall(ToolCallMessage(id: "msg_e02", author: agent, createdAt: ago(39), toolCallId: "call_e02", toolName: "read_note", label: "Read “Q3 report notes”", input: ["path": "Projects/Q3 report notes.md"], status: .ok, resultPreview: "42 lines", endedAt: ago(39) + 120)),
        .artifact(ArtifactMessage(id: "msg_e03", author: agent, createdAt: ago(14), artifactId: "art_sample_email")),
        .text(TextMessage(id: "msg_e04", author: agent, createdAt: ago(13), role: .agent, text: "Here's a short draft with the three headline numbers and a link to the full report. I'll send it once you approve.")),
        .approval(ApprovalMessage(id: "msg_e05", author: agent, createdAt: ago(12), approvalId: SampleData.emailApprovalId)),
        .toolCall(ToolCallMessage(id: "msg_e06", author: agent, createdAt: ago(12), toolCallId: "call_e06", toolName: "mcp__mail__send_message", label: "Send email", input: ["to": "sam@example.com", "subject": "Q3 report — draft for review"], status: .running)),
      ],
      artifacts: [
        ArtifactMeta(id: "art_sample_email", threadId: id, title: "Email to Sam", kind: .markdown, mimeType: "text/markdown", path: ".daily-do-list/artifacts/\(id)/art_sample_email.md", size: 894, createdAt: ago(14)),
      ])
  }

  func desks() -> AgentThread {
    let id = SampleData.desksThreadId
    let agent = "subagent:research"
    return AgentThread(
      id: id, taskId: "tsk_sample_desks", notePath: notePath,
      title: "Compare standing desks under $500", status: .done, createdAt: ago(95), updatedAt: ago(31),
      messages: [
        .status(StatusMessage(id: "msg_d01", author: "system", createdAt: ago(95), status: .working, text: "Research agent started")),
        .toolCall(ToolCallMessage(id: "msg_d02", author: agent, createdAt: ago(94), toolCallId: "call_d02", toolName: "web_search", label: "Search the web", input: ["query": "best standing desk under $500 2026"], status: .ok, resultPreview: "8 results", endedAt: ago(94) + 2_100)),
        .approval(ApprovalMessage(id: "msg_d03", author: agent, createdAt: ago(92), approvalId: SampleData.retailersApprovalId)),
        .toolCall(ToolCallMessage(id: "msg_d04", author: agent, createdAt: ago(55), toolCallId: "call_d04", toolName: "browser_extract_text", label: "Read 3 product pages", input: ["maxChars": 20000], status: .ok, resultPreview: "Prices, height ranges and warranties for 3 desks", endedAt: ago(55) + 48_000)),
        .artifact(ArtifactMessage(id: "msg_d05", author: agent, createdAt: ago(32), artifactId: "art_sample_desks")),
        .text(TextMessage(id: "msg_d06", author: agent, createdAt: ago(31), role: .agent, text: SampleData.desksAnswer)),
        .status(StatusMessage(id: "msg_d07", author: "system", createdAt: ago(31), status: .done, text: "Done · 3 desks compared")),
      ],
      artifacts: [
        ArtifactMeta(id: "art_sample_desks", threadId: id, title: "Standing desks under $500", kind: .markdown, mimeType: "text/markdown", path: ".daily-do-list/artifacts/\(id)/art_sample_desks.md", size: 1_046, createdAt: ago(32)),
        ArtifactMeta(id: "art_sample_script", threadId: id, title: "price_watch.py", kind: .code, mimeType: "text/x-python", language: "python", path: ".daily-do-list/artifacts/\(id)/art_sample_script.py", size: 702, createdAt: ago(31)),
      ],
      sources: SampleData.desksSources)
  }

  func coffee() -> AgentThread {
    let id = SampleData.coffeeThreadId
    let agent = "subagent:shopper"
    let click = SampleImages.addToCartCenter
    return AgentThread(
      id: id, taskId: "tsk_sample_coffee", notePath: notePath, title: "Reorder coffee beans",
      status: .working, createdAt: ago(6), updatedAt: ago(0.2),
      messages: [
        .status(StatusMessage(id: "msg_c01", author: "system", createdAt: ago(6), status: .working, text: "Shopper agent started")),
        .toolCall(ToolCallMessage(id: "msg_c02", author: agent, createdAt: ago(5), toolCallId: "call_c02", toolName: "computer_screenshot", label: "Look at the screen", input: [:], status: .ok, endedAt: ago(5) + 640)),
        .toolCall(ToolCallMessage(id: "msg_c03", author: agent, createdAt: ago(1), toolCallId: "call_c03", toolName: "computer_click", label: "Click “Add to cart”", input: ["x": .number(click.x), "y": .number(click.y), "element": "Add to cart button"], status: .ok, endedAt: ago(1) + 420)),
        .toolCall(ToolCallMessage(id: "msg_c04", author: agent, createdAt: ago(0.2), toolCallId: "call_c04", toolName: "computer_screenshot", label: "Check the cart", input: [:], status: .running)),
      ],
      surfaces: [.computer])
  }

  /// Anchored to the prose line "How tall is Ridge Tower downtown?": the answer cites its sources
  /// and a note.
  func question() -> AgentThread {
    let id = SampleData.questionThreadId
    return AgentThread(
      id: id, taskId: SampleData.questionAnchorId, notePath: notePath, title: "How tall is Ridge Tower downtown?",
      status: .done, createdAt: ago(18), updatedAt: ago(16),
      messages: [
        .status(StatusMessage(id: "msg_q01", author: "system", createdAt: ago(18), status: .working, text: "Looking it up")),
        .toolCall(ToolCallMessage(id: "msg_q02", author: "orchestrator", createdAt: ago(17.8), toolCallId: "call_q02", toolName: "web_search", label: "Search the web", input: ["query": "Ridge Tower height"], status: .ok, resultPreview: "5 results", endedAt: ago(17.8) + 1_400)),
        .text(TextMessage(id: "msg_q03", author: "orchestrator", createdAt: ago(16), role: .agent, text: SampleData.questionAnswer)),
        .status(StatusMessage(id: "msg_q04", author: "system", createdAt: ago(16), status: .done, text: "Answered")),
      ],
      sources: SampleData.questionSources)
  }

  func passport() -> ThreadSummary {
    summary(
      SampleData.passportThreadId, task: "tsk_sample_passport", title: "Renew passport — find the right form",
      status: .waitingUser, created: 70, updated: 20,
      preview: "Is this a **renewal by mail** (your current passport is undamaged and less than 15 years old), or do you need to apply in person?")
  }

  func hikes() -> ThreadSummary {
    summary(
      SampleData.hikesThreadId, task: "tsk_sample_hikes", title: "Find 3 weekend hikes near Mt. Example",
      status: .queued, created: 1, updated: 1, preview: nil)
  }

  func lunch() -> ThreadSummary {
    summary(
      SampleData.lunchThreadId, task: "tsk_sample_lunch", title: "Plan a team lunch next Thursday",
      status: .triaging, created: 0.4, updated: 0.4, preview: nil)
  }

  func cleanup() -> ThreadSummary {
    summary(
      SampleData.cleanupThreadId, task: "tsk_sample_cleanup", title: "Clean up the Downloads folder",
      status: .failed, created: 130, updated: 118,
      preview: "The safety policy blocked `rm -rf` on the whole folder. I can move files older than 30 days to the Trash instead — want me to?")
  }

  func subscription() -> ThreadSummary {
    summary(
      SampleData.subscriptionThreadId, task: "tsk_sample_subscription", title: "Cancel the unused streaming subscription",
      status: .cancelled, created: 200, updated: 190, preview: "Stopped by you.")
  }

  func library() -> ThreadSummary {
    var summary = self.summary(
      SampleData.libraryThreadId, task: "tsk_sample_library", title: "Renew library books",
      status: .done, created: 26 * 60, updated: 25 * 60, preview: "Renewed 2 books until next month.")
    summary.notePath = yesterdayNotePath
    return summary
  }

  private func summary(
    _ id: String, task: String, title: String, status: TaskAgentStatus, created: Double,
    updated: Double, preview: String?
  ) -> ThreadSummary {
    ThreadSummary(
      id: id, taskId: task, notePath: notePath, title: title, status: status, createdAt: ago(created),
      updatedAt: ago(updated), messageCount: preview == nil ? 1 : 4, lastMessagePreview: preview,
      artifactCount: 0, surfaces: [], pendingApprovals: 0)
  }

  // MARK: Approvals

  func approvals() -> [ApprovalRequest] {
    let reserveCreated = ago(3)
    return [
      ApprovalRequest(
        id: SampleData.reserveApprovalId, threadId: SampleData.bookingThreadId, taskId: "tsk_sample_booking",
        toolName: "browser_click", toolLabel: "Click “Complete reservation”",
        input: ["element": "Complete reservation button", "ref": "e42", "url": "https://trattoria-sole.example/reserve"],
        summary: "Submit the reservation for 4 people at Trattoria Sole, Friday 7:00 PM (patio)",
        risk: .medium, categories: [.booking, .formSubmission],
        reason: "Completing the form books a table in your name and shares your phone number with the restaurant.",
        status: .pending, createdAt: reserveCreated, expiresAt: reserveCreated + 12 * 3_600_000),
      ApprovalRequest(
        id: SampleData.depositApprovalId, threadId: SampleData.bookingThreadId, taskId: "tsk_sample_booking",
        toolName: "browser_click", toolLabel: "Click “Pay $40 deposit”",
        input: ["element": "Pay $40 deposit button", "ref": "e17", "amount": "$40.00"],
        summary: "Pay a $40 deposit to hold a table at Osteria Luna", risk: .high, categories: [.payment],
        reason: "This charges your saved card.", status: .denied,
        decisionNote: "No deposits — pick a place that doesn't need one.", createdAt: ago(47.5),
        decidedAt: ago(9.2), expiresAt: ago(47.5) + 12 * 3_600_000),
      ApprovalRequest(
        id: SampleData.emailApprovalId, threadId: SampleData.emailThreadId, taskId: "tsk_sample_email",
        toolName: "mcp__mail__send_message", toolLabel: "Send email",
        input: [
          "to": "sam@example.com", "subject": "Q3 report — draft for review",
          "body": "Hi Sam,\n\nHere's the draft of the Q3 report for your review…",
        ],
        summary: "Send an email to sam@example.com: “Q3 report — draft for review”", risk: .high,
        categories: [.communication], reason: "Sends a message on your behalf to someone else.",
        status: .pending, createdAt: ago(12), expiresAt: ago(12) + 12 * 3_600_000),
      ApprovalRequest(
        id: SampleData.retailersApprovalId, threadId: SampleData.desksThreadId, taskId: "tsk_sample_desks",
        toolName: "browser_navigate", toolLabel: "Open retailer sites",
        input: ["urls": ["https://desks.example", "https://office-shop.example", "https://sample-furniture.example"]],
        summary: "Open 3 retailer websites to compare prices", risk: .low,
        categories: [.network, .browserInput], reason: "Visits sites outside your notes.",
        status: .approved, scope: .task, createdAt: ago(92), decidedAt: ago(90.5)),
    ]
  }

  // MARK: Artifacts and frames

  func artifacts() -> [String: ArtifactPayload] {
    [
      "art_sample_options": payload(Self.optionsJSON, "application/json"),
      "art_sample_summary": payload(Self.summaryHTML, "text/html"),
      "art_sample_email": payload(Self.emailMarkdown, "text/markdown"),
      "art_sample_desks": payload(Self.desksMarkdown, "text/markdown"),
      "art_sample_script": payload(Self.priceWatchScript, "text/x-python"),
    ]
  }

  private func payload(_ text: String, _ mimeType: String) -> ArtifactPayload {
    ArtifactPayload(data: Data(text.utf8), mimeType: mimeType)
  }

  func frames() -> [SurfaceFrame] {
    let reserve = SampleImages.reserveButtonCenter
    let cart = SampleImages.addToCartCenter
    return [
      SurfaceFrame(
        threadId: SampleData.bookingThreadId, surface: .browser, mimeType: "image/png",
        data: SampleImages.browserFrame, width: SampleImages.browserSize.width,
        height: SampleImages.browserSize.height, url: "https://trattoria-sole.example/reserve?party=4&time=19:00",
        title: "Reserve a table · Trattoria Sole",
        action: SurfaceFrameAction(kind: "hover", x: reserve.x, y: reserve.y, text: "Complete reservation"),
        ts: ago(0.02)),
      SurfaceFrame(
        threadId: SampleData.coffeeThreadId, surface: .computer, mimeType: "image/png",
        data: SampleImages.desktopFrame, width: SampleImages.desktopSize.width,
        height: SampleImages.desktopSize.height,
        action: SurfaceFrameAction(kind: "click", x: cart.x, y: cart.y), ts: ago(1)),
    ]
  }

  static let optionsJSON = """
    {"date":"Friday","party":4,"time":"19:00","options":[{"name":"Trattoria Sole","time":"19:00","seating":"patio","deposit":null,"url":"https://trattoria-sole.example"},{"name":"Osteria Luna","time":"19:15","seating":"indoor","deposit":"$40","url":"https://osteria-luna.example"},{"name":"Pasta Bar Nord","time":"18:45","seating":"counter","deposit":null,"url":"https://pasta-bar-nord.example"}],"recommended":"Trattoria Sole"}
    """

  static let summaryHTML = """
    <!doctype html>
    <html><head><title>Reservation summary</title>
    <style>body{font:15px -apple-system,sans-serif;margin:32px;color:#222}h1{font-size:22px}
    td{padding:6px 16px 6px 0}.ok{color:#2f9e5a;font-weight:600}</style></head>
    <body><h1>Trattoria Sole — reservation</h1>
    <table><tr><td>When</td><td>Friday, 7:00 PM</td></tr><tr><td>Party</td><td>4 guests</td></tr>
    <tr><td>Seating</td><td>Patio</td></tr><tr><td>Deposit</td><td class="ok">None</td></tr></table>
    <p><a href="https://trattoria-sole.example/menu">See the menu</a></p>
    <script>document.body.innerHTML = "scripts never run here";</script>
    </body></html>
    """

  static let emailMarkdown = """
    **To:** sam@example.com
    **Subject:** Q3 report — draft for review

    Hi Sam,

    Here's the draft of the Q3 report. The headline numbers:

    - Revenue up **12%** quarter over quarter
    - Churn down to **2.1%**
    - Two new enterprise customers

    The full report is in the shared folder. Could you review it by Thursday?

    Thanks,
    Alex
    """

  static let desksMarkdown = """
    # Standing desks under $500

    | Desk | Price | Height | Motor | Warranty |
    |---|---|---|---|---|
    | Example Rise Pro | $449 | 25–50 in | Dual | 7 years |
    | Sample Lift 2 | $389 | 27–47 in | Single | 5 years |
    | Demo Desk Mini | $299 | 28–46 in | Single | 3 years |

    **Pick:** Example Rise Pro — the dual motor is quieter and it has the widest height range.

    - All three ship free and arrive within a week.
    - Sample Lift 2 is often on sale for $349.

    > Prices checked today at three retailer sites ([desks.example](https://desks.example)).
    """

  static let priceWatchScript = """
    \"\"\"Checks the desk prices once a day and prints any drop.\"\"\"
    import json
    import urllib.request

    DESKS = {
        "Example Rise Pro": "https://desks.example/api/rise-pro",
        "Sample Lift 2": "https://office-shop.example/api/lift-2",
    }


    def price(url: str) -> float:
        with urllib.request.urlopen(url, timeout=10) as response:
            return float(json.load(response)["price"])


    def main() -> None:
        for name, url in DESKS.items():
            print(f"{name}: ${price(url):.2f}")


    if __name__ == "__main__":
        main()
    """
}
