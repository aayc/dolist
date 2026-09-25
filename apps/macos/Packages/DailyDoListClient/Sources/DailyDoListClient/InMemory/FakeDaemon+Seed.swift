import DailyDoListModels
import Foundation

/// Initial vault content. Synthetic only: no real people, places or accounts.
extension FakeDaemon {
  func seedVault(_ seed: InMemoryDaemonClient.Seed) {
    switch seed.content {
    case .files(let files):
      for (input, content) in files.sorted(by: { $0.key < $1.key }) {
        guard let path = try? FakeVaultPaths.normalize(input), !path.isEmpty else { continue }
        vault.store(path, content, mtime: nowMillis)
        observeNote(path, content: content, initial: true)
      }
    case .demo:
      seedDemo()
    }
    seedOrchestratorChat()
  }

  private static let dayMillis: Double = 86_400_000

  private static let demoNotes: [(String, String)] = [
    (
      "Welcome.md",
      """
      # Welcome to Daily Do List

      This is a **demo vault**: everything stays in memory on this Mac.

      - Open today's daily note and write a task, e.g. `- [ ] Research the best indoor herb garden kits`
      - Tasks with words like *buy*, *book* or *email* pause for your approval.
      - Mention *browse* and you can watch the agent's (simulated) browser.

      See [[Ideas]] and the [[Projects/Garden Redesign|garden project]].
      """
    ),
    (
      "Ideas.md",
      """
      # Ideas

      - A weekly review template that pulls unfinished tasks forward
      - Batch errands by neighborhood
      - Try a no-meeting Wednesday

      > Small steps every day.
      """
    ),
    (
      "Projects/Garden Redesign.md",
      """
      # Garden Redesign

      Goals for the spring refresh.

      ## Beds
      - Raised bed along the south fence
      - Native pollinator strip

      ## Tasks
      - [ ] Measure the south fence
      - [ ] Get quotes for cedar boards
      """
    ),
    (
      "Projects/Home Office.md",
      """
      # Home Office

      - [x] Pick a desk lamp
      - [ ] Cable management tray
      - [ ] Acoustic panels for the back wall
      """
    ),
    (
      "Projects/Reading List.md",
      """
      # Reading List

      1. A book about habits
      2. A history of maps
      3. A field guide to local birds
      """
    ),
  ]

  /// Previous days (with a gap) and the tasks the agent already finished there.
  private static let demoHistory: [(offset: Int, lines: [String], completed: [String])] = [
    (
      -1,
      [
        "- [x] Order a replacement phone charger",
        "- [ ] Renew library books before Friday",
        "- [x] Draft agenda for Thursday's team sync",
        "  - Include the roadmap review",
      ],
      ["Order a replacement phone charger"]
    ),
    (
      -2,
      [
        "- [x] Research beginner-friendly houseplants for a north-facing window",
        "- [ ] Call the bank about the card replacement",
        "- [x] Summarize the neighborhood newsletter",
      ],
      ["Research beginner-friendly houseplants for a north-facing window"]
    ),
    (
      -4,
      ["- [x] Plan a weekend hiking route near the lake", "- [ ] Back up the photo library"],
      ["Plan a weekend hiking route near the lake"]
    ),
  ]

  private static let demoToday = [
    "- [x] Compare standing desks under $400", "- [ ] Reserve a table for Friday dinner",
  ]
  /// Written as prose; the orchestrator answered it in a thread anchored to the line.
  private static let demoQuestion = "How tall is Ridge Tower downtown?"

  /// Pages the agent's lines in today's note cite (added to their threads' sources).
  private static let deskSource = CitedSource(
    url: "https://desks.example/rise-pro", title: "Example Rise Pro standing desk — Desks Example",
    snippet: "Dual motor, 25–50 in height range, 7-year warranty. $379 this week.")
  private static let tableSource = CitedSource(
    url: "https://booking.example/trattoria-sole", title: "Trattoria Sole — Booking Example",
    snippet: "Tables for 2 on Friday at 7:00 PM and 8:30 PM. Free cancellation until noon.")

  private func seedDemo() {
    let start = nowMillis
    vault.store(
      "Templates/Daily.md", FakeCalendar.defaultDailyNoteContent, mtime: start - 30 * Self.dayMillis
    )
    for (path, content) in Self.demoNotes {
      vault.store(path, content, mtime: start - 7 * Self.dayMillis)
    }
    let today = today
    for day in Self.demoHistory {
      let date = today.adding(days: day.offset)
      guard let path = try? calendar.dailyNotePath(date, settings.dailyNotes) else { continue }
      let mtime = start + Double(day.offset) * Self.dayMillis
      let content = day.lines.joined(separator: "\n")
      vault.store(path, content, mtime: mtime)
      observeNote(path, content: content, initial: true)
      for text in day.completed {
        seedCompletedTask(path, date: date, text: text, completedAt: mtime - 3_600_000)
      }
    }
    guard let todayPath = try? calendar.dailyNotePath(today, settings.dailyNotes) else { return }
    let content = (Self.demoToday + [FakeCalendar.defaultDailyNoteContent]).joined(separator: "\n")
    vault.store(todayPath, content, mtime: start - 60_000)
    observeNote(todayPath, content: content, initial: true)
    let desks = seedCompletedTask(
      todayPath, date: today, text: Self.demoToday[0].dropTaskPrefix,
      completedAt: start - 7_200_000,
      source: Self.deskSource)
    let table = seedCompletedTask(
      todayPath, date: today, text: Self.demoToday[1].dropTaskPrefix,
      completedAt: start - 3_600_000,
      source: Self.tableSource)
    guard let desks, let table else { return }
    // What the agent wrote into the note: findings under each task and a follow-up task.
    let lines = [
      Self.demoToday[0],
      FakeAgentText.mark(
        "  - Example Rise Pro is the pick at $379, dual motor ([Desks Example](\(Self.deskSource.url)))",
        threadId: desks),
      Self.demoToday[1],
      FakeAgentText.mark(
        "  - Trattoria Sole has a table for 2 at 7:00 PM ([Booking Example](\(Self.tableSource.url)))",
        threadId: table),
      FakeAgentText.mark("- [ ] Call Trattoria Sole to confirm the table", threadId: table),
      Self.demoQuestion,
      FakeCalendar.defaultDailyNoteContent,
    ]
    let final = lines.joined(separator: "\n")
    vault.store(todayPath, final, mtime: start - 60_000)
    observeNote(todayPath, content: final, initial: true)
    seedAnsweredQuestion(
      todayPath, date: today, line: lines.firstIndex(of: Self.demoQuestion) ?? 0,
      answeredAt: start - 1_800_000)
  }

  /// A question written as prose, answered by the orchestrator in a thread anchored to its line:
  /// a `done` record with `anchor: line` (id `anc_…`) and a thread citing its sources.
  private func seedAnsweredQuestion(
    _ path: String, date: LocalDate, line: Int, answeredAt: EpochMillis
  ) {
    let threadId = nextID("thr")
    let anchorId = nextID("anc")
    let tower = "https://city.example/landmarks/ridge-tower"
    let skyline = "https://skyline.example/towers"
    let messages: [ThreadMessage] = [
      Self.statusMessage(.working, "Looking it up", at: answeredAt - 20_000, id: nextID("msg")),
      .toolCall(
        ToolCallMessage(
          id: nextID("msg"), author: "orchestrator", createdAt: answeredAt - 16_000,
          toolCallId: nextID("call"),
          toolName: "web_search", label: "Web search", input: ["query": "Ridge Tower height"],
          status: .ok,
          resultPreview: "5 results", endedAt: answeredAt - 14_500)),
      Self.agentText(
        "orchestrator",
        """
        **About 1,250 ft (381 m)** to the roof, 1,380 ft with its spire [1](\(tower)). It has been the tallest \
        building downtown since it opened [2](\(skyline)#ridge).

        I added it to [[Ideas]] under places to visit.
        """, at: answeredAt - 4_000, id: nextID("msg")),
      Self.statusMessage(.done, "Answered", at: answeredAt, id: nextID("msg")),
    ]
    threads[threadId] = AgentThread(
      id: threadId, taskId: anchorId, notePath: path, title: Self.demoQuestion, status: .done,
      createdAt: answeredAt - 20_000,
      updatedAt: answeredAt, messages: messages,
      sources: [
        CitedSource(
          url: tower, title: "Ridge Tower — City Landmarks",
          snippet:
            "Ridge Tower rises 1,250 ft (381 m) to its roof; the spire brings it to 1,380 ft."),
        CitedSource(url: skyline, title: "Downtown skyline: every tower ranked"),
      ])
    records[anchorId] = TaskAgentRecord(
      taskId: anchorId, notePath: path, date: date.iso, text: Self.demoQuestion, line: line,
      status: .done,
      summary: "About 1,250 ft", threadId: threadId, updatedAt: answeredAt, unread: 0, anchor: .line
    )
  }

  /// A finished thread and a `done` record for an existing task (the agent's earlier work); `source`
  /// joins the thread's sources. Returns the thread's id.
  @discardableResult
  private func seedCompletedTask(
    _ path: String, date: LocalDate, text: String, completedAt: EpochMillis,
    source: CitedSource? = nil
  ) -> String? {
    guard let task = tracked[path]?.first(where: { $0.text == text }) else { return nil }
    let script = AgentScript.forTask(text)
    var clock = completedAt - 90_000
    func next() -> EpochMillis {
      clock += 4_000
      return clock
    }
    let threadId = nextID("thr")
    var messages: [ThreadMessage] = [
      Self.statusMessage(
        .working, "Started a \(script.subagent) subagent", at: next(), id: nextID("msg")),
      Self.agentText(
        "orchestrator", "Picked this up — handing it to a **\(script.subagent)** subagent.",
        at: next(), id: nextID("msg")),
      Self.agentText(script.author, script.intro, at: next(), id: nextID("msg")),
    ]
    for step in script.steps {
      let at = next()
      messages.append(
        .toolCall(
          ToolCallMessage(
            id: nextID("msg"), author: script.author, createdAt: at, toolCallId: nextID("call"),
            toolName: step.toolName,
            label: step.label, input: step.input, status: .ok, resultPreview: step.resultPreview,
            endedAt: at + step.durationMs)))
    }
    let artifactId = nextID("art")
    let data = Data(script.artifact.content.utf8)
    let meta = ArtifactMeta(
      id: artifactId, threadId: threadId, title: script.artifact.title, kind: .markdown,
      mimeType: "text/markdown",
      path: "\(FakeVaultPaths.sidecar)/artifacts/\(threadId)/\(artifactId).md", size: data.count,
      createdAt: next())
    artifacts[artifactId] = StoredArtifact(meta: meta, data: data)
    messages.append(
      .artifact(
        ArtifactMessage(
          id: nextID("msg"), author: script.author, createdAt: meta.createdAt,
          artifactId: artifactId)))
    var summary = script.doneSummary
    if let risky = script.risky {
      let at = next()
      let approval = ApprovalRequest(
        id: nextID("apr"), threadId: threadId, taskId: task.id, toolName: risky.toolName,
        toolLabel: risky.toolLabel,
        input: risky.input, summary: risky.summary, risk: risky.risk, categories: risky.categories,
        reason: risky.reason,
        status: .approved, scope: .once, createdAt: at, decidedAt: at + 30_000)
      approvals[approval.id] = approval
      messages.append(
        .approval(
          ApprovalMessage(
            id: nextID("msg"), author: "system", createdAt: at, approvalId: approval.id)))
      messages.append(
        Self.agentText(script.author, risky.approvedText, at: next(), id: nextID("msg")))
      summary = risky.approvedSummary
    } else {
      messages.append(
        Self.agentText(script.author, script.finalText, at: next(), id: nextID("msg")))
    }
    messages.append(Self.statusMessage(.done, "Task complete", at: completedAt, id: nextID("msg")))
    let sources = script.sources + (source.map { [$0] } ?? [])
    threads[threadId] = AgentThread(
      id: threadId, taskId: task.id, notePath: path, title: text, status: .done,
      createdAt: completedAt - 90_000,
      updatedAt: completedAt, messages: messages, artifacts: [meta],
      sources: sources.isEmpty ? nil : sources)
    records[task.id] = TaskAgentRecord(
      taskId: task.id, notePath: path, date: date.iso, text: text, line: task.line, status: .done,
      summary: summary,
      threadId: threadId, updatedAt: completedAt, unread: 0)
    return threadId
  }
}

extension String {
  /// `Buy milk` from `- [x] Buy milk`.
  fileprivate var dropTaskPrefix: String {
    FakeTaskParser.tasks(in: self).first?.text ?? self
  }
}
