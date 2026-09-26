import DailyDoListAgent
import DailyDoListAgentTestSupport
import DailyDoListClient
import DailyDoListClientTestSupport
import DailyDoListDomain
import DailyDoListEditor
import DailyDoListModels
import DailyDoListUI
import Foundation
import Testing

@testable import DailyDoListApp

/// The agent in the note: badges on anchored lines, sparkles, link previews, and agent edits that
/// merge with the user's typing.
@MainActor
@Suite("Living list")
struct LivingListTests {
  static let path = "Daily/2026-09-23.md"
  static let note = [
    "- [ ] Book a table for Friday",
    "  - Trattoria Sole has a table at 7 PM ([Sole](https://sole.example/book)) %%agent:thr_ab12%%",
    "How tall is Ridge Tower downtown?",
    "- [ ] Call the restaurant to confirm %%agent:thr_ab12%%",
    "See [[Ideas]].",
  ].joined(separator: "\n")

  let client = FakeDaemonClient(notes: [
    Self.path: Self.note,
    "Ideas.md": "---\ntags: [x]\n---\n# Ideas\n\n- Batch errands %%agent%%\n- Try a no-meeting day",
  ])
  let scheduler = ManualScheduler()

  private func openWorkspace(agent: AgentStore? = nil) async throws -> Workspace {
    let workspace = makeWorkspace(client: client, scheduler: scheduler, agent: agent)
    workspace.applyTree(try await client.tree())
    await workspace.openToday()
    return workspace
  }

  // MARK: Badges

  @Test func anchoredRecordsBadgeTheirLineAndHighlightIt() {
    var question = TaskAgentRecord.sample(
      "anc_q", note: Self.path, text: "How tall is Ridge Tower downtown?", line: 1, status: .done,
      summary: "About 1,250 ft", threadId: "thr_q")
    question.anchor = .line
    let task = TaskAgentRecord.sample(
      "t1", note: Self.path, text: "Call the restaurant to confirm", line: 2, status: .working,
      threadId: "thr_ab12")
    let badges = BadgeBuilder.badges(for: [question, task], in: Self.note)
    #expect(badges.map(\.id) == ["anc_q", "t1"])
    #expect(badges.map(\.line) == [2, 3])
    #expect(badges.map(\.highlightsLine) == [true, false])
    #expect(badges.first?.label == "Done · About 1,250 ft")
    // An anchor whose line is gone gets no badge; the task keeps its own.
    let edited = Self.note.replacingOccurrences(of: "How tall is Ridge Tower downtown?\n", with: "")
    #expect(BadgeBuilder.badges(for: [question, task], in: edited).map(\.id) == ["t1"])
    #expect(BadgeBuilder.line(of: question, in: "- [ ] New\n" + Self.note) == 3)
    #expect(BadgeBuilder.line(of: task, in: Self.note) == 3)
  }

  @Test func showInNoteFindsAnAnchoredLine() async throws {
    let workspace = try await openWorkspace()
    var question = TaskAgentRecord.sample(
      "anc_q", note: Self.path, text: "How tall is Ridge Tower downtown?", line: 0, status: .done)
    question.anchor = .line
    await workspace.revealTask(notePath: Self.path, record: question)
    #expect(
      workspace.editor.controller.textView.selectedRange().location
        == (Self.note as NSString).range(of: "How tall").location)
  }

  // MARK: Sparkles and previews

  @Test func aSparkleOpensTheThreadThatWroteTheLine() async throws {
    let workspace = try await openWorkspace()
    workspace.editor.editor(workspace.editor.controller, didClickAgentThread: "thr_ab12")
    #expect(workspace.ui.inspectorPresented)
    #expect(workspace.ui.selectedThreadId == "thr_ab12")
  }

  @Test func pageLinksInAgentLinesArePreviewedFromTheThreadsSources() async throws {
    let agent = SampleData.makeStore(now: referenceNow)
    let workspace = try await openWorkspace(agent: agent)
    let cited = EditorLinkPreview(
      target: .external(URL(string: "https://desks.example/rise-pro")!), label: "Rise Pro",
      agentThreadId: SampleData.desksThreadId)
    #expect(
      workspace.editor.editor(workspace.editor.controller, previewFor: cited)
        == "Example Rise Pro — Desks Example\ndesks.example\nDual-motor standing desk, 25–50 in height range, 7-year warranty. Free shipping.\nhttps://desks.example/rise-pro"
    )
    // A user's line: the link itself.
    let plain = EditorLinkPreview(
      target: .external(URL(string: "https://desks.example/rise-pro")!), label: "Rise Pro")
    #expect(
      workspace.linkPreviewText(for: plain)
        == "Rise Pro\ndesks.example\nhttps://desks.example/rise-pro")
  }

  @Test func anUnloadedThreadIsLoadedOnceForItsSources() async throws {
    let agent = AgentStore(client: client)
    let workspace = try await openWorkspace(agent: agent)
    let link = EditorLinkPreview(
      target: .external(URL(string: "https://sole.example/book")!), label: "Sole",
      agentThreadId: "thr_ab12")
    #expect(workspace.linkPreviewText(for: link) == "Sole\nsole.example\nhttps://sole.example/book")
    _ = workspace.linkPreviewText(for: link)
    try await eventually("thread requested") { client.calls("thread").contains("thread:thr_ab12") }
    await settle()
    #expect(client.calls("thread").filter { $0 == "thread:thr_ab12" }.count == 1)
  }

  @Test func notePreviewsShowTheFirstLinesWithoutMarkersOrFrontmatter() async throws {
    let workspace = try await openWorkspace()
    let link = EditorLinkPreview(target: .note(target: "Ideas", subpath: nil), label: "Ideas")
    #expect(workspace.linkPreviewText(for: link) == nil, "not read yet: the editor shows the name")
    try await eventually("read") { workspace.linkPreviewText(for: link) != nil }
    #expect(
      workspace.linkPreviewText(for: link)
        == "Ideas\n# Ideas\n- Batch errands\n- Try a no-meeting day")
    // The thread view's cards read the same previews; unknown notes have none.
    #expect(await workspace.agentNoteLinks.preview("Ideas")?.lines.count == 3)
    #expect(await workspace.agentNoteLinks.preview("Nowhere") == nil)
    // A change to the note drops the cached preview.
    client.setNote("Ideas.md", "# Ideas v2")
    workspace.handleVaultChanged(
      VaultChangedEvent(
        changes: [VaultChange(path: "Ideas.md", kind: .modified, version: nil)], origin: .agent,
        clientId: nil))
    #expect(workspace.notePreviews.cachedPreview(for: "Ideas") == nil)
    // Open notes are previewed from the editor, unsaved edits included.
    #expect(
      workspace.notePreviews.cachedPreview(for: Self.path)?.lines.first
        == "- [ ] Book a table for Friday")
    #expect(
      NotePreviewCache.preview(
        path: "a/B.md", content: (1...12).map { "line \($0)" }.joined(separator: "\n")
      ).lines.count == 8)
  }

  // MARK: Merging agent edits

  @Test func mergeEditsTurnTheTextIntoTheMergedVersion() {
    var generator = SeededGenerator(seed: 5)
    let choices = ["- [ ] a", "- [ ] b", "text", "", "  - note %%agent%%", "## h", "é"]
    func randomText() -> String {
      (0..<Int.random(in: 0...8, using: &generator)).map { _ in
        choices[Int.random(in: 0..<choices.count, using: &generator)]
      }
      .joined(separator: "\n") + (Bool.random(using: &generator) ? "\n" : "")
    }
    let editor = MarkdownEditorController()
    for _ in 0..<300 {
      let current = randomText()
      let merged = randomText()
      editor.setText(current, resetUndo: true)
      editor.applyRemoteChanges(MergeEdits.changes(from: current, to: merged))
      #expect(editor.text == merged, "\(current.debugDescription) → \(merged.debugDescription)")
    }
  }

  @Test func anAgentEditWhileTheUserTypesMergesWithoutAConflictCopy() async throws {
    let workspace = try await openWorkspace()
    let controller = workspace.editor.controller
    let typed = Self.note.replacingOccurrences(
      of: "Book a table for Friday", with: "Book a table for Friday at 8")
    type(typed, in: workspace)
    let caret = (typed as NSString).range(of: "at 8").location + 4
    controller.textView.setSelectedRange(NSRange(location: caret, length: 0))

    // The agent adds a line under the question (not seen by the user yet).
    let remote = Self.note.replacingOccurrences(
      of: "downtown?\n",
      with: "downtown?\n  - About 1,250 ft ([City](https://city.example/ridge)) %%agent:thr_q%%\n")
    let version = client.setNote(Self.path, remote)
    workspace.handleVaultChanged(
      VaultChangedEvent(
        changes: [VaultChange(path: Self.path, kind: .modified, version: version)], origin: .agent,
        clientId: nil))

    let merged = typed.replacingOccurrences(
      of: "downtown?\n",
      with: "downtown?\n  - About 1,250 ft ([City](https://city.example/ridge)) %%agent:thr_q%%\n")
    try await eventually("merged into the editor") { controller.text == merged }
    #expect(
      controller.textView.selectedRange() == NSRange(location: caret, length: 0),
      "the caret stays where the user was typing")
    try await eventually("saved") { client.note(Self.path)?.content == merged }
    #expect(!client.writes.contains { $0.path.contains("conflict") })
    try await eventually("clean") { workspace.notes.saveStates[Self.path] == .saved }
    // Undo takes back the agent's line first, then the typing is still undoable.
    let undo = try #require(controller.textView.undoManager)
    try await eventually("undo group closed") { undo.groupingLevel == 0 }
    undo.undo()
    #expect(controller.text == typed)
  }
}

/// Deterministic RNG (SplitMix64) for property tests.
struct SeededGenerator: RandomNumberGenerator {
  private var state: UInt64
  init(seed: UInt64) { state = seed }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}
