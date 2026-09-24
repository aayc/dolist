import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListAgent

@Suite("Formatting")
struct FormattingTests {
  static var calendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/Los_Angeles") ?? .current
    return calendar
  }

  static let locale = Locale(identifier: "en_US")

  /// Wednesday, September 23, 2026, 9:43 PM in Los Angeles.
  static var now: Date {
    calendar.date(from: DateComponents(year: 2026, month: 9, day: 23, hour: 21, minute: 43)) ?? Date()
  }

  /// ICU puts a narrow no-break space before AM/PM.
  func plain(_ text: String?) -> String? { text?.replacingOccurrences(of: "\u{202F}", with: " ") }

  @Test(arguments: [
    (0.0, "0 ms"), (420, "420 ms"), (999.9, "999 ms"), (1_000, "1.0 s"), (3_240, "3.2 s"),
    (59_949, "59.9 s"), (59_960, "1m 0s"), (61_000, "1m 1s"), (2_296_000, "38m 16s"),
    (3_599_400, "59m 59s"), (3_600_000, "1h 0m"), (7_500_000, "2h 5m"), (-50, "0 ms"), (.nan, "0 ms"),
  ])
  func durations(milliseconds: Double, expected: String) {
    #expect(AgentFormat.duration(milliseconds: milliseconds) == expected)
  }

  @Test func absurdWireValuesDontCrash() {
    #expect(AgentFormat.duration(milliseconds: 1e300) == "2777777h 46m")
    #expect(AgentFormat.duration(milliseconds: .infinity) == "0 ms")
    #expect(SurfaceAction(kind: "click", x: 1e300, y: 5, ts: 1).summary == "click")
    #expect(SurfaceAction(kind: "click", x: .nan, y: .infinity, ts: 1).summary == "click")
    let point = SurfaceGeometry.point(x: .nan, y: .infinity, frameWidth: 10, frameHeight: 10, viewSize: CGSize(width: 50, height: 50))
    #expect(point == CGPoint(x: 0, y: 0))
  }

  @Test func toolCallDurationsNeedAnEnd() {
    guard case .toolCall(let running) = Fixture.toolCall(createdAt: 1_000),
      case .toolCall(let finished) = Fixture.toolCall(status: .ok, createdAt: 1_000, endedAt: 2_297_000)
    else { return }
    #expect(AgentFormat.duration(of: running) == nil)
    #expect(AgentFormat.duration(of: finished) == "38m 16s")
  }

  @Test func timestamps() {
    let calendar = Self.calendar
    let today = calendar.date(byAdding: .hour, value: -12, to: Self.now) ?? Self.now
    let yesterday = calendar.date(byAdding: .day, value: -1, to: Self.now) ?? Self.now
    #expect(plain(AgentFormat.timestamp(today, now: Self.now, calendar: calendar, locale: Self.locale)) == "9:43 AM")
    #expect(plain(AgentFormat.timestamp(yesterday, now: Self.now, calendar: calendar, locale: Self.locale)) == "Sep 22, 9:43 PM")
    #expect(plain(AgentFormat.timestamp(Self.now.epochMillis, now: Self.now, calendar: calendar, locale: Self.locale)) == "9:43 PM")
  }

  @Test func relativeTimes() {
    let calendar = Self.calendar
    func relative(_ seconds: TimeInterval) -> String {
      AgentFormat.relativeTime(Self.now.addingTimeInterval(-seconds), now: Self.now, calendar: calendar, locale: Self.locale)
    }
    #expect(relative(20) == "now")
    #expect(relative(-300) == "now")
    #expect(relative(5 * 60) == "5m")
    #expect(relative(3 * 3600 + 120) == "3h")
    #expect(relative(24 * 3600) == "Yesterday")
    #expect(relative(3 * 24 * 3600) == "Sep 20")
  }

  @Test func decisions() {
    let decidedAt = Self.now.epochMillis
    func text(_ status: ApprovalStatus, _ scope: ApprovalScope? = nil, decided: Bool = true) -> String? {
      plain(
        AgentFormat.decision(
          of: Fixture.approval(status: status, scope: scope, decidedAt: decided ? decidedAt : nil),
          now: Self.now, calendar: Self.calendar, locale: Self.locale))
    }
    #expect(text(.pending) == nil)
    #expect(text(.approved) == "Approved once · 9:43 PM")
    #expect(text(.approved, .once) == "Approved once · 9:43 PM")
    #expect(text(.approved, .task) == "Approved for this task · 9:43 PM")
    #expect(text(.approved, .always) == "Always approved · 9:43 PM")
    #expect(text(.denied) == "Denied · 9:43 PM")
    #expect(text(.expired) == "Expired (auto-denied) · 9:43 PM")
    #expect(text(.cancelled, decided: false) == "Cancelled")
    #expect(text("superseded") == "Superseded · 9:43 PM")
  }

  @Test func expiries() {
    let calendar = Self.calendar
    let soon = Self.now.addingTimeInterval(10 * 60).epochMillis
    let tomorrow = Self.now.addingTimeInterval(11 * 3600 + 22 * 60).epochMillis
    #expect(plain(AgentFormat.expiry(soon, now: Self.now, calendar: calendar, locale: Self.locale)) == "Auto-denies at 9:53 PM")
    #expect(plain(AgentFormat.expiry(tomorrow, now: Self.now, calendar: calendar, locale: Self.locale)) == "Auto-denies Sep 24, 9:05 AM")
  }

  @Test(arguments: [
    ("orchestrator", "Orchestrator"), ("you", "You"), ("system", "System"),
    ("subagent:research", "Research agent"), ("subagent:price-watch", "Price watch agent"),
    ("subagent:", "Agent"), ("robot", "robot"),
  ])
  func authorLabels(author: String, expected: String) {
    #expect(AgentFormat.authorLabel(author) == expected)
  }

  @Test func previewsAndSizes() {
    #expect(AgentFormat.plainPreview("## Found **3** `options`\n\n> nice  one") == "Found 3 options nice one")
    #expect(AgentFormat.bytes(12) == "12 B")
    #expect(AgentFormat.bytes(3_482) == "3.4 KB")
    #expect(AgentFormat.bytes(1_300_000) == "1.2 MB")
    #expect(AgentFormat.noteName("Daily/2026-09-23.md") == "2026-09-23")
    #expect(AgentFormat.noteName("Inbox") == "Inbox")
    #expect(AgentFormat.noteName(".hidden") == ".hidden")
  }

  @Test func conflictMessagesNameTheActualState() {
    #expect(AgentFormat.conflictMessage(for: Fixture.approval(status: .approved)) == "This approval was already approved.")
    #expect(AgentFormat.conflictMessage(for: Fixture.approval(status: .denied)) == "This approval was already denied.")
    #expect(AgentFormat.conflictMessage(for: Fixture.approval(status: .cancelled)) == "This approval was cancelled.")
    #expect(AgentFormat.conflictMessage(for: Fixture.approval(status: .pending)) == "This approval is no longer pending.")
  }
}

@Suite("Styles and icons")
struct StyleTests {
  @Test func statusLabelsAndTones() {
    let expected: [(TaskAgentStatus, String, Tone)] = [
      (.idle, "Idle", .faint), (.triaging, "Triaging", .accent), (.queued, "Queued", .faint),
      (.working, "Working", .info), (.waitingApproval, "Needs approval", .warning),
      (.waitingUser, "Needs you", .warning), (.done, "Done", .success), (.failed, "Failed", .danger),
      (.cancelled, "Stopped", .faint), (.ignored, "Ignored", .faint),
      ("waiting_for_input", "Waiting for input", .faint),
    ]
    for (status, label, tone) in expected {
      #expect(status.displayLabel == label)
      #expect(status.tone == tone)
    }
    #expect(TaskAgentStatus.triaging.pulses)
    #expect(!TaskAgentStatus.working.pulses)
  }

  @Test func riskTones() {
    #expect(RiskLevel.low.tone == .success)
    #expect(RiskLevel.medium.tone == .warning)
    #expect(RiskLevel.high.tone == .danger)
    #expect(RiskLevel.critical.tone == .danger)
    #expect(RiskLevel("extreme").tone == .warning)
    #expect(RiskLevel.high.displayLabel == "High risk")
    #expect(RiskLevel("extreme").displayLabel == "Extreme risk")
  }

  @Test func categoryLabels() {
    #expect(ActionCategory.payment.displayLabel == "Spends money")
    #expect(ActionCategory.communication.displayLabel == "Contacts someone")
    #expect(ActionCategory.formSubmission.displayLabel == "Submits a form")
    #expect(ActionCategory("quantum_leap").displayLabel == "Quantum leap")
  }

  @Test(arguments: [
    ("browser_click", "globe"), ("computer_type", "cursorarrow.rays"), ("web_search", "magnifyingglass"),
    ("web_fetch", "magnifyingglass"), ("bash", "terminal"), ("read", "doc.text"),
    ("write", "square.and.pencil"), ("edit", "square.and.pencil"), ("grep", "doc.text.magnifyingglass"),
    ("mcp__mail__send_message", "puzzlepiece.extension"), ("post_update", "text.bubble"),
    ("ask_user", "questionmark.bubble"), ("create_artifact", "doc.richtext"), ("read_note", "note.text"),
    ("spawn_subagent", "person.2"), ("something_new", "wrench.and.screwdriver"),
  ])
  func toolIcons(tool: String, symbol: String) {
    #expect(ToolIcon.systemName(for: tool) == symbol)
  }

  @Test func toolCallStatuses() {
    #expect(ToolCallStatus.ok.systemImage == "checkmark.circle.fill")
    #expect(ToolCallStatus.error.systemImage == "xmark.circle.fill")
    #expect(ToolCallStatus.blocked.systemImage == "shield.lefthalf.filled")
    #expect(ToolCallStatus.blocked.tone == .warning)
    #expect(ToolCallStatus.blocked.displayLabel == "Blocked by safety policy")
    #expect(ToolCallStatus.running.tone == .info)
  }

  @Test func artifactKinds() {
    #expect(ArtifactKind.json.displayLabel == "JSON")
    #expect(ArtifactKind.markdown.displayLabel == "Markdown")
    let code = ArtifactMeta(id: "a", threadId: "t", title: "x", kind: .code, mimeType: "text/plain", language: "python", path: "p", size: 1, createdAt: 1)
    #expect(code.kindLabel == "python")
    #expect(ArtifactFiles.kind(forMimeType: "image/png") == .image)
    #expect(ArtifactFiles.kind(forMimeType: "text/markdown; charset=utf-8") == .markdown)
    #expect(ArtifactFiles.kind(forMimeType: "application/json") == .json)
    #expect(ArtifactFiles.kind(forMimeType: "text/csv") == .text)
    #expect(ArtifactFiles.kind(forMimeType: "application/pdf") == .file)
  }

  @Test func artifactFileNames() {
    let meta = ArtifactMeta(id: "a", threadId: "t", title: "Q3: report/draft?", kind: .code, mimeType: "text/x-python", language: "Python", path: "p", size: 1, createdAt: 1)
    #expect(ArtifactFiles.fileName(meta: meta, kind: .code, mimeType: "text/x-python") == "Q3- report-draft-.py")
    #expect(ArtifactFiles.fileName(meta: nil, kind: .image, mimeType: "image/jpeg") == "artifact.jpg")
    #expect(ArtifactFiles.fileName(meta: nil, kind: .file, mimeType: "application/pdf") == "artifact.bin")
    #expect(ArtifactFiles.prettyJSON(Data(#"{"b":1,"a":[true]}"#.utf8)) == "{\n  \"a\" : [\n    true\n  ],\n  \"b\" : 1\n}")
    #expect(ArtifactFiles.prettyJSON(Data("not json".utf8)) == nil)
  }

  @Test func dockBadgeLabels() {
    #expect(DockBadge.label(forPendingCount: 0) == nil)
    #expect(DockBadge.label(forPendingCount: -1) == nil)
    #expect(DockBadge.label(forPendingCount: 3) == "3")
    #expect(DockBadge.label(forPendingCount: 120) == "99+")
  }
}
