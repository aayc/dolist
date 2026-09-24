import DailyDoListAgent
import DailyDoListClient
import DailyDoListDomain
import DailyDoListEditor
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListApp

@MainActor
@Suite("Workspace navigation")
struct WorkspaceNavigationTests {
  let client = FakeDaemonClient(notes: [
    "Daily/2026-09-18.md": "- [x] old",
    "Daily/2026-09-21.md": "- [ ] monday",
    "Daily/2026-09-23.md": "- [ ] today",
    "Daily/2026-09-26.md": "- [ ] saturday",
    "Ideas.md": "ideas",
    "Projects/Launch/Plan.md": "plan",
    "Templates/Weekly.md": "# Week of {{date:YYYY-MM-DD}}\n{{title}}\n{{unknown}}",
  ])
  let scheduler = ManualScheduler()
  let workspace: Workspace

  init() async throws {
    workspace = makeWorkspace(client: client, scheduler: scheduler)
    workspace.applyTree(try await client.tree())
  }

  @Test func todayOpensTheDailyNoteForTheLocalDate() async {
    await workspace.openToday()
    #expect(workspace.activePath == "Daily/2026-09-23.md")
    #expect(workspace.editor.controller.text == "- [ ] today")
    #expect(client.calls("dailyNote") == ["dailyNote:2026-09-23"])
  }

  @Test func dailyNotesOpenWithTheCaretAtTheEndSoTypingAddsToTheList() async throws {
    await workspace.openToday()
    let editor = workspace.editor.controller
    #expect(
      editor.snapshot().selectedRange
        == NSRange(location: ("- [ ] today" as NSString).length, length: 0))

    await workspace.openNote("Ideas.md", OpenOptions(newTab: true))
    #expect(
      editor.snapshot().selectedRange == NSRange(location: 0, length: 0),
      "other notes open at the top")

    // Back on the daily note, its own caret comes back (not forced to the end again).
    workspace.activateTab("Daily/2026-09-23.md")
    #expect(editor.snapshot().selectedRange.location == ("- [ ] today" as NSString).length)
  }

  @Test func previousAndNextSkipGapsToTheNearestExistingNote() async {
    await workspace.openToday()
    #expect(await workspace.openAdjacentDaily(.previous))
    #expect(workspace.activePath == "Daily/2026-09-21.md")
    #expect(await workspace.openAdjacentDaily(.previous))
    #expect(workspace.activePath == "Daily/2026-09-18.md")
    #expect(await workspace.openAdjacentDaily(.previous) == false, "nothing before the oldest note")
    #expect(workspace.activePath == "Daily/2026-09-18.md")
    #expect(await workspace.openAdjacentDaily(.next))
    #expect(await workspace.openAdjacentDaily(.next))
    #expect(await workspace.openAdjacentDaily(.next))
    #expect(workspace.activePath == "Daily/2026-09-26.md")
    #expect(await workspace.openAdjacentDaily(.next) == false)
  }

  @Test func adjacentDailyFromANonDailyNoteIsRelativeToToday() async {
    await workspace.openNote("Ideas.md")
    #expect(workspace.adjacentDailyPath(.previous, from: "Ideas.md") == "Daily/2026-09-21.md")
    #expect(workspace.adjacentDailyPath(.next, from: "Ideas.md") == "Daily/2026-09-26.md")
  }

  @Test func weeklyNoteIsCreatedFromTheTemplateWithCreateOnly() async throws {
    await workspace.openWeekly()
    let expected = DailyNotes.weeklyPath(
      for: LocalDate(year: 2026, month: 9, day: 23), settings: .defaults)
    #expect(workspace.activePath == expected)
    let write = try #require(client.writes.last)
    #expect(write.path == expected)
    #expect(write.base == .createOnly)
    #expect(write.content == "# Week of 2026-09-23\n\(VaultPath.stem(expected))\n{{unknown}}")
    // Opening it again doesn't write.
    await workspace.openWeekly()
    #expect(client.writes.count == 1)
  }

  @Test func weeklyNoteWithoutTemplateStartsEmpty() async throws {
    var settings = AppSettings.defaults
    settings.weeklyNotes.template = ""
    workspace.settings.apply(settings)
    await workspace.openWeekly()
    #expect(client.writes.last?.content == "")
  }

  @Test func backAndForwardReturnToPreviousNotes() async {
    await workspace.openNote("Ideas.md")
    await workspace.openNote("Projects/Launch/Plan.md")
    #expect(workspace.tabs.tabs == ["Projects/Launch/Plan.md"])
    await workspace.goBack()
    #expect(workspace.activePath == "Ideas.md")
    #expect(workspace.editor.controller.text == "ideas")
    await workspace.goForward()
    #expect(workspace.activePath == "Projects/Launch/Plan.md")
  }

  @Test func reopenClosedTabRestoresItsPlaceAndText() async {
    await workspace.openNote("Ideas.md")
    await workspace.openNote("Projects/Launch/Plan.md", OpenOptions(newTab: true))
    workspace.closeTab("Projects/Launch/Plan.md")
    #expect(workspace.tabs.tabs == ["Ideas.md"])
    #expect(workspace.activePath == "Ideas.md")
    await workspace.reopenClosedTab()
    #expect(workspace.tabs.tabs == ["Ideas.md", "Projects/Launch/Plan.md"])
    #expect(workspace.activePath == "Projects/Launch/Plan.md")
    #expect(workspace.editor.controller.text == "plan")
  }

  @Test func closingTheLastTabLeavesNoActiveNote() async {
    await workspace.openNote("Ideas.md")
    workspace.closeActiveTab()
    #expect(workspace.activePath == nil)
    #expect(workspace.editor.activePath == nil)
  }

  @Test func tabSwitchKeepsEachNotesUnsavedText() async throws {
    await workspace.openNote("Ideas.md")
    type("ideas, edited", in: workspace)
    await workspace.openNote("Projects/Launch/Plan.md", OpenOptions(newTab: true))
    #expect(workspace.editor.controller.text == "plan")
    workspace.activateTab("Ideas.md")
    #expect(workspace.editor.controller.text == "ideas, edited")
    try await eventually("switch flushed the edit") {
      client.note("Ideas.md")?.content == "ideas, edited"
    }
  }

  @Test func wikiLinksResolveLikeObsidianOrCreateTheNote() async throws {
    await workspace.openWikiLink("plan", newTab: false)
    #expect(workspace.activePath == "Projects/Launch/Plan.md")
    await workspace.openWikiLink("Plan#Goals|the plan", newTab: false)
    #expect(workspace.activePath == "Projects/Launch/Plan.md")
    await workspace.openWikiLink("Meeting notes", newTab: true)
    #expect(workspace.activePath == "Meeting notes.md")
    #expect(client.note("Meeting notes.md")?.content == "")
    #expect(workspace.tabs.tabs.count == 2)
  }

  @Test func untitledNotesGetUniqueNamesAndTitleFocus() async {
    let first = await workspace.createNote()
    let second = await workspace.createNote()
    #expect(first == "Untitled.md")
    #expect(second == "Untitled 1.md")
    #expect(workspace.ui.titleFocusPath == "Untitled 1.md")
    #expect(workspace.tabs.tabs == ["Untitled.md", "Untitled 1.md"])
  }

  @Test func namedNotesAreValidated() async {
    #expect(await workspace.createNote(name: "Bad:Name") == nil)
    #expect(await workspace.createNote(name: "Projects/Roadmap") == "Projects/Roadmap.md")
  }

  @Test func titleRenameUpdatesTabsNotesAndVault() async throws {
    await workspace.openNote("Ideas.md")
    #expect(await workspace.renameNoteTitle("Ideas.md", to: "Thoughts"))
    #expect(workspace.activePath == "Thoughts.md")
    #expect(workspace.vault.isFile("Thoughts.md"))
    #expect(!workspace.vault.has("Ideas.md"))
    #expect(workspace.notes.has("Thoughts.md"))
    #expect(client.note("Thoughts.md")?.content == "ideas")
  }

  @Test func renamingADailyNoteUsesTheExplorerBecauseItsTitleIsTheDate() async {
    workspace.ui.sidebarVisible = false
    workspace.ui.sidebarMode = .search
    workspace.beginRename("Daily/2026-09-21.md")
    #expect(workspace.ui.titleFocusPath == nil)
    #expect(workspace.ui.renamingPath == "Daily/2026-09-21.md")
    #expect(workspace.ui.sidebarVisible && workspace.ui.sidebarMode == .files)
    #expect(workspace.ui.expandedFolders.contains("Daily"))

    workspace.ui.renamingPath = nil
    workspace.beginRename("Projects/Launch/Plan.md")
    #expect(
      workspace.ui.titleFocusPath == "Projects/Launch/Plan.md", "other notes rename in their title")
    #expect(workspace.ui.renamingPath == nil)
  }

  @Test func renameRefusesExistingTargets() async {
    #expect(await workspace.renamePath("Ideas.md", to: "Daily/2026-09-23.md") == false)
    #expect(workspace.vault.isFile("Ideas.md"))
  }

  @Test func folderRenameMovesOpenNotes() async {
    await workspace.openNote("Projects/Launch/Plan.md")
    #expect(await workspace.renameEntry("Projects", to: "Work"))
    #expect(workspace.activePath == "Work/Launch/Plan.md")
    #expect(workspace.editor.activePath == "Work/Launch/Plan.md")
  }

  @Test func deleteClosesTheTabAndSoftDeletes() async {
    await workspace.openNote("Ideas.md")
    workspace.requestDelete("Ideas.md")
    #expect(workspace.ui.pendingDeletion?.path == "Ideas.md")
    #expect(await workspace.deletePath("Ideas.md"))
    #expect(workspace.tabs.tabs.isEmpty)
    #expect(!workspace.vault.has("Ideas.md"))
    #expect(client.calls("deleteNote") == ["deleteNote:Ideas.md"])
    #expect(!workspace.tabs.canReopenClosedTab, "a deleted note can't be reopened")
  }

  @Test func restoredTabsOpenExistingNotesOnly() async {
    await workspace.restoreTabs(
      ["Ideas.md", "Gone.md", "Projects/Launch/Plan.md"], active: "Projects/Launch/Plan.md")
    #expect(workspace.tabs.tabs == ["Ideas.md", "Projects/Launch/Plan.md"])
    #expect(workspace.activePath == "Projects/Launch/Plan.md")
  }
}

@MainActor
@Suite("Editor integration")
struct EditorIntegrationTests {
  let client = FakeDaemonClient(notes: [
    "Daily/2026-09-23.md": "Intro\n- [ ] Book flights to Lisbon\n- [ ] Buy milk"
  ])
  let scheduler = ManualScheduler()

  @Test func badgesFollowRecordsAndEditsDebounced() async throws {
    let agent = AgentStore(client: client)
    let workspace = makeWorkspace(client: client, scheduler: scheduler, agent: agent)
    workspace.applyTree(try await client.tree())
    await workspace.openToday()
    let path = "Daily/2026-09-23.md"
    agent.apply(
      .taskRecords(
        TaskRecordsEvent(
          notePath: path,
          records: [
            .sample(
              "t1", note: path, text: "Book flights to Lisbon", line: 1, status: .working,
              summary: "Comparing fares", threadId: "th1"),
            .sample("t2", note: path, text: "Buy milk", line: 2, status: .idle),
          ])))
    workspace.editor.recordsDidChange(for: path)
    scheduler.advance(by: 0)
    #expect(workspace.editor.controller.badges.map(\.id) == ["t1"], "idle records get no badge")
    #expect(workspace.editor.controller.badges.first?.line == 1)
    #expect(workspace.editor.controller.badges.first?.label == "Comparing fares")

    // While typing, badges are rebuilt ~150 ms after the last edit (not per keystroke).
    type("Intro\nNew first task\n- [ ] Book flights to Lisbon\n- [ ] Buy milk", in: workspace)
    agent.apply(
      .taskRecords(
        TaskRecordsEvent(
          notePath: path,
          records: [
            .sample(
              "t1", note: path, text: "Book flights to Lisbon", line: 1, status: .working,
              summary: "Holding seats", threadId: "th1")
          ])))
    scheduler.advance(by: 0.1)
    #expect(workspace.editor.controller.badges.first?.label == "Comparing fares")
    scheduler.advance(by: 0.1)
    #expect(workspace.editor.controller.badges.first?.label == "Holding seats")
    #expect(
      workspace.editor.controller.badges.first?.line == 2, "re-anchored against the edited text")
  }

  @Test func badgeClickOpensTheThreadInTheInspector() async throws {
    let workspace = makeWorkspace(client: client, scheduler: scheduler)
    workspace.editorDidClickBadge(
      EditorBadge(id: "t1", line: 1, status: "working", label: "x", threadId: "th1"))
    #expect(workspace.ui.inspectorPresented)
    #expect(workspace.ui.selectedThreadId == "th1")
    workspace.editorDidClickBadge(EditorBadge(id: "t9", line: 1, status: "triaging", label: "x"))
    #expect(workspace.ui.selectedThreadId == nil, "no thread yet: the inbox")
  }

  @Test func presenceIsThrottledToFourHundredMilliseconds() {
    var sent: [Int] = []
    let presence = PresenceReporter(scheduler: scheduler) { _, line in sent.append(line) }
    presence.cursorMoved(path: "a.md", line: 1)
    presence.cursorMoved(path: "a.md", line: 2)
    presence.cursorMoved(path: "a.md", line: 3)
    #expect(sent == [1])
    scheduler.advance(by: 0.4)
    #expect(sent == [1, 3])
    presence.cursorMoved(path: "a.md", line: 3)
    scheduler.advance(by: 1)
    #expect(sent == [1, 3], "the same position isn't re-sent")
    presence.edited(path: "a.md")
    #expect(sent == [1, 3, 3], "typing on the line refreshes presence")
    presence.reset()
    presence.edited(path: "a.md")
    #expect(sent == [1, 3, 3])
  }

  @Test func cursorMovesAreReportedToTheDaemon() async throws {
    let workspace = makeWorkspace(client: client, scheduler: scheduler)
    workspace.applyTree(try await client.tree())
    await workspace.openToday()
    scheduler.advance(by: 1)
    workspace.editor.editor(workspace.editor.controller, cursorDidMoveToLine: 2)
    scheduler.advance(by: 1)
    try await eventually("editor.activity sent") {
      client.sent.contains(.editorActivity(notePath: "Daily/2026-09-23.md", line: 2))
    }
    #expect(workspace.editor.cursorLine == 2)
  }

  @Test func wordCountIsDebounced() async throws {
    let workspace = makeWorkspace(client: client, scheduler: scheduler)
    workspace.applyTree(try await client.tree())
    await workspace.openToday()
    #expect(workspace.editor.wordCount == 7)
    type("just three words", in: workspace)
    #expect(workspace.editor.wordCount == 7)
    scheduler.advance(by: 0.6)
    #expect(workspace.editor.wordCount == 3)
  }

  @Test func typingIsUndoableAndEachNoteKeepsItsOwnText() async throws {
    client.setNote("Ideas.md", "ideas")
    let workspace = makeWorkspace(client: client, scheduler: scheduler)
    workspace.applyTree(try await client.tree())
    await workspace.openToday()
    await workspace.openNote("Ideas.md", OpenOptions(newTab: true))
    workspace.activateTab("Daily/2026-09-23.md")
    let textView = workspace.editor.controller.textView
    textView.setSelectedRange(NSRange(location: 0, length: 0))
    textView.insertText("New: ", replacementRange: textView.selectedRange())
    #expect(workspace.editor.controller.text.hasPrefix("New: Intro"))
    #expect(workspace.notes.saveStates["Daily/2026-09-23.md"] == .dirty)
    let undo = try #require(textView.undoManager)
    // Typing opens an event-scoped undo group that the run loop closes.
    try await eventually("undo group closed") { undo.groupingLevel == 0 }
    #expect(undo.canUndo)
    undo.undo()
    #expect(workspace.editor.controller.text.hasPrefix("Intro"))
  }

  @Test func editorFontAndPreviewFollowSettings() async {
    let workspace = makeWorkspace(client: client, scheduler: scheduler)
    var settings = AppSettings.defaults
    settings.editor.fontSize = 20
    settings.editor.livePreview = false
    workspace.editor.configure(settings.editor)
    #expect(workspace.editor.controller.configuration.fontSize == 20)
    #expect(workspace.editor.controller.configuration.livePreview == false)
  }
}
