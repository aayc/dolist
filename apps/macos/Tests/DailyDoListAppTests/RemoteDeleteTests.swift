import DailyDoListClient
import DailyDoListDomain
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListApp

/// Lines deleted outside an open note (another app, another client, the agent) stay deleted: no
/// editor writes them back unless its user types them again. These replay the incident (the agent
/// added a line under a task, then an API client removed both while the note was open) and the races
/// around it, through the real workspace: editor coordinator, text view and notes store.
@MainActor
@Suite("Lines deleted elsewhere")
struct RemoteDeleteTests {
  static let path = "Daily/2026-09-23.md"
  static let task = "- [ ] Rehearsal: count the bots"
  static let result = "\t- Done: 11 bots %%agent:thr_1%%"
  static let day = "# Wednesday\n- [ ] Water the plants\n\(task)"
  static let withResult = "\(day)\n\(result)"
  static let cleaned = "# Wednesday\n- [ ] Water the plants"

  let client = FakeDaemonClient(notes: [path: withResult, "Ideas.md": "ideas"])
  let scheduler = ManualScheduler()

  private func openWorkspace() async throws -> Workspace {
    let workspace = makeWorkspace(client: client, scheduler: scheduler)
    workspace.applyTree(try await client.tree())
    await workspace.openToday()
    return workspace
  }

  /// Someone else writes the note; the daemon announces it to `workspaces` (nil: don't announce).
  @discardableResult
  private func writeElsewhere(
    _ content: String, origin: VaultChangeOrigin = .external, announceTo workspaces: [Workspace]
  ) -> String {
    let version = client.setNote(Self.path, content)
    for workspace in workspaces { announce(version, origin: origin, to: workspace) }
    return version
  }

  private func announce(
    _ version: String?, origin: VaultChangeOrigin = .external, clientId: String? = nil,
    to workspace: Workspace
  ) {
    workspace.handleVaultChanged(
      VaultChangedEvent(
        changes: [VaultChange(path: Self.path, kind: .modified, version: version)], origin: origin,
        clientId: clientId))
  }

  /// The incident's cleanup: an API client reads the note and writes it back without `lines`.
  private func removeLines(_ lines: [String], announceTo workspaces: [Workspace]) {
    let current = client.note(Self.path)!.content
    let next = Self.remove(lines, from: current)
    writeElsewhere(next, announceTo: workspaces)
  }

  /// The user types `suffix` at the end of the line `line` (a keystroke's worth of change).
  private func type(_ suffix: String, after line: String, in workspace: Workspace) {
    let text = workspace.editor.controller.text
    let lines = TextMerge.lines(text).map { $0 == line ? $0 + suffix : $0 }
    DailyDoListAppTests.type(lines.joined(separator: "\n"), in: workspace)
  }

  private func addLine(_ added: String, after line: String, in workspace: Workspace) {
    var lines = TextMerge.lines(workspace.editor.controller.text)
    lines.insert(added, at: (lines.firstIndex(of: line) ?? lines.count - 1) + 1)
    DailyDoListAppTests.type(lines.joined(separator: "\n"), in: workspace)
  }

  private static func remove(_ lines: [String], from text: String) -> String {
    TextMerge.lines(text).filter { !lines.contains($0) }.joined(separator: "\n")
  }

  private func expectNeverWrittenBack(_ lines: [String], since index: Int = 0) {
    for write in client.landed.dropFirst(index) where write.path == Self.path {
      for line in lines {
        #expect(!TextMerge.lines(write.content).contains(line), "wrote \(line) back")
      }
    }
    let current = TextMerge.lines(client.note(Self.path)?.content ?? "")
    for line in lines { #expect(!current.contains(line)) }
  }

  // MARK: The note is shown

  @Test func anExternalDeleteWhileOpenAndCleanIsShownAndNeverWrittenBack() async throws {
    let workspace = try await openWorkspace()
    removeLines([Self.task, Self.result], announceTo: [workspace])
    try await eventually("shown") { workspace.editor.controller.text == Self.cleaned }
    await workspace.notes.flushAll()  // the window loses focus
    scheduler.advance(by: 10)
    await settle()
    #expect(client.landed.isEmpty, "a clean note writes nothing")
    type(" today", after: "- [ ] Water the plants", in: workspace)
    scheduler.advance(by: 0.3)
    try await eventually("saved") {
      client.note(Self.path)?.content == "# Wednesday\n- [ ] Water the plants today"
    }
    expectNeverWrittenBack([Self.task, Self.result])
  }

  @Test func anExternalDeleteWhileTypingElsewhereInTheNote() async throws {
    let workspace = try await openWorkspace()
    type(" today", after: "- [ ] Water the plants", in: workspace)
    removeLines([Self.task, Self.result], announceTo: [workspace])
    let expected = "# Wednesday\n- [ ] Water the plants today"
    try await eventually("merged") { workspace.editor.controller.text == expected }
    scheduler.advance(by: 0.3)
    try await eventually("saved") { client.note(Self.path)?.content == expected }
    expectNeverWrittenBack([Self.task, Self.result])
  }

  @Test func anAgentEditThenAnExternalDeleteThenTyping() async throws {
    client.setNote(Self.path, Self.day)
    let workspace = try await openWorkspace()
    writeElsewhere(Self.withResult, origin: .agent, announceTo: [workspace])
    try await eventually("agent line shown") {
      workspace.editor.controller.text == Self.withResult
    }
    removeLines([Self.task, Self.result], announceTo: [workspace])
    try await eventually("delete shown") { workspace.editor.controller.text == Self.cleaned }
    type(" today", after: "- [ ] Water the plants", in: workspace)
    scheduler.advance(by: 0.3)
    try await eventually("saved") {
      client.note(Self.path)?.content == "# Wednesday\n- [ ] Water the plants today"
    }
    expectNeverWrittenBack([Self.task, Self.result])
  }

  @Test func twoWindowsOnTheNoteWhileAThirdClientDeletesThenBothType() async throws {
    let first = try await openWorkspace()
    let second = try await openWorkspace()
    removeLines([Self.task, Self.result], announceTo: [first, second])
    try await eventually("both show it") {
      first.editor.controller.text == Self.cleaned && second.editor.controller.text == Self.cleaned
    }
    type(" today", after: "- [ ] Water the plants", in: first)
    addLine("- [ ] Call mom", after: "# Wednesday", in: second)
    scheduler.advance(by: 0.3)
    try await eventually("both saved") {
      !first.notes.isBusy(Self.path) && !second.notes.isBusy(Self.path)
    }
    // Each window hears about the other's write (the daemon tags it with the writer's id).
    announce(client.note(Self.path)?.version, origin: .client, clientId: "other", to: first)
    announce(client.note(Self.path)?.version, origin: .client, clientId: "other", to: second)
    let expected = "# Wednesday\n- [ ] Call mom\n- [ ] Water the plants today"
    try await eventually("converged") {
      first.editor.controller.text == expected && second.editor.controller.text == expected
    }
    #expect(client.note(Self.path)?.content == expected)
    expectNeverWrittenBack([Self.task, Self.result])
  }

  @Test func aDeleteRacingAPendingDebouncedSave() async throws {
    let workspace = try await openWorkspace()
    type(" today", after: "- [ ] Water the plants", in: workspace)
    scheduler.advance(by: 0.2)
    // The delete lands, but its vault.changed arrives only after the save fired (stale base).
    let version = writeElsewhere(
      Self.remove([Self.task, Self.result], from: Self.withResult), announceTo: [])
    scheduler.advance(by: 0.1)
    let expected = "# Wednesday\n- [ ] Water the plants today"
    try await eventually("merged and saved") { client.note(Self.path)?.content == expected }
    announce(version, to: workspace)
    await settle()
    #expect(workspace.editor.controller.text == expected)
    expectNeverWrittenBack([Self.task, Self.result])
  }

  @Test func a409AfterAnExternalDeleteMergesInsteadOfRestoringTheLines() async throws {
    let workspace = try await openWorkspace()
    client.holdWrites = true
    type(" today", after: "- [ ] Water the plants", in: workspace)
    scheduler.advance(by: 0.3)
    try await eventually("write held") { client.heldWriteCount == 1 }
    removeLines([Self.task, Self.result], announceTo: [workspace])
    await settle()
    type("!", after: "- [ ] Water the plants today", in: workspace)
    client.holdWrites = false
    client.releaseAllWrites()
    let expected = "# Wednesday\n- [ ] Water the plants today!"
    try await eventually("saved") { client.note(Self.path)?.content == expected }
    try await eventually("shown") { workspace.editor.controller.text == expected }
    expectNeverWrittenBack([Self.task, Self.result])
  }

  @Test func aCleanNoteNeverWritesHoweverOftenTheWindowLosesFocus() async throws {
    let first = try await openWorkspace()
    let second = try await openWorkspace()
    for workspace in [first, second] { await workspace.notes.flushAll() }
    removeLines([Self.task, Self.result], announceTo: [first, second])
    for workspace in [first, second] { await workspace.notes.flushAll() }
    await settle()
    for workspace in [first, second] { await workspace.notes.flushAll() }
    scheduler.advance(by: 10)
    await settle()
    #expect(client.landed.isEmpty)
  }

  // MARK: The note is in another tab

  @Test func comingBackToANoteDeletedFromInTheBackgroundShowsTheVaultsText() async throws {
    client.setNote(Self.path, Self.day)
    let workspace = try await openWorkspace()
    writeElsewhere(Self.withResult, origin: .agent, announceTo: [workspace])
    try await eventually("agent line shown") {
      workspace.editor.controller.text == Self.withResult
    }
    // The user looks at another note; switching saves (and used to capture) the daily note.
    await workspace.openNote("Ideas.md", OpenOptions(newTab: true))
    removeLines([Self.task, Self.result], announceTo: [workspace])
    try await eventually("delete received") {
      workspace.notes.serverContent(Self.path) == Self.cleaned
    }
    workspace.activateTab(Self.path)
    #expect(workspace.editor.controller.text == Self.cleaned, "shows the vault's text")
    type(" today", after: "- [ ] Water the plants", in: workspace)
    scheduler.advance(by: 0.3)
    try await eventually("saved") { !workspace.notes.isBusy(Self.path) }
    #expect(client.note(Self.path)?.content == "# Wednesday\n- [ ] Water the plants today")
    expectNeverWrittenBack([Self.task, Self.result])
  }

  @Test func comingBackToANoteTheAgentEditedInTheBackgroundKeepsTheAgentsLine() async throws {
    client.setNote(Self.path, Self.day)
    let workspace = try await openWorkspace()
    await workspace.openNote("Ideas.md", OpenOptions(newTab: true))
    await workspace.notes.flushAll()  // the window loses focus
    writeElsewhere(Self.withResult, origin: .agent, announceTo: [workspace])
    try await eventually("agent edit received") {
      workspace.notes.serverContent(Self.path) == Self.withResult
    }
    workspace.activateTab(Self.path)
    #expect(workspace.editor.controller.text == Self.withResult)
    type(" today", after: "- [ ] Water the plants", in: workspace)
    scheduler.advance(by: 0.3)
    try await eventually("saved") { !workspace.notes.isBusy(Self.path) }
    #expect(
      client.note(Self.path)?.content
        == Self.withResult.replacingOccurrences(of: "plants", with: "plants today"))
  }

  // MARK: Conflicts

  @Test func aLineAddedBetweenLinesDeletedElsewhereKeepsOnlyTheUsersLine() async throws {
    let workspace = try await openWorkspace()
    addLine("\t- ask about the missing ones", after: Self.task, in: workspace)
    removeLines([Self.task, Self.result], announceTo: [workspace])
    let expected = "\(Self.cleaned)\n\t- ask about the missing ones"
    scheduler.advance(by: 0.3)
    try await eventually("saved") { client.note(Self.path)?.content == expected }
    try await eventually("shown") { workspace.editor.controller.text == expected }
    #expect(!client.writes.contains { $0.path.contains("conflict") })
    expectNeverWrittenBack([Self.task, Self.result])
  }

  @Test func aConflictOnOneLineDoesntBringBackLinesDeletedElsewhere() async throws {
    let workspace = try await openWorkspace()
    type(" (all of them)", after: "- [ ] Water the plants", in: workspace)
    client.setNote(
      Self.path, Self.withResult.replacingOccurrences(of: "- [ ] Water", with: "- [x] Water"))
    removeLines([Self.task, Self.result], announceTo: [workspace])
    let expected = "# Wednesday\n- [ ] Water the plants (all of them)"
    scheduler.advance(by: 0.3)
    try await eventually("resolved") { workspace.notes.saveStates[Self.path] == .saved }
    #expect(client.note(Self.path)?.content == expected)
    #expect(workspace.editor.controller.text == expected)
    #expect(
      client.note("Daily/2026-09-23 (conflict).md")?.content
        == "# Wednesday\n- [x] Water the plants", "their version is kept as a copy")
    expectNeverWrittenBack([Self.task, Self.result])
  }
}

/// Random interleavings (seeded) of the user typing, switching tabs and leaving the window, the
/// agent adding lines under tasks, an API client appending tasks and deleting lines with
/// `baseVersion`, and `vault.changed` events delivered in any order. The user types only on the
/// first line and at the end, so nothing conflicts, and every line is unique.
@MainActor
@Suite("Lines deleted elsewhere (model-based)")
struct RemoteDeleteModelTests {
  static let path = "Daily/2026-09-23.md"

  @Test func nothingDeletedElsewhereComesBackAndACleanNoteWritesNothingNew() async throws {
    for seed in 1...(thoroughTests ? 40 : 10) { try await run(seed: UInt64(seed)) }
  }

  private func run(seed: UInt64) async throws {
    var random = SeededGenerator(seed: seed)
    let client = FakeDaemonClient(notes: [Self.path: "# Wednesday\n- [ ] start", "Ideas.md": "x"])
    let scheduler = ManualScheduler()
    let workspace = makeWorkspace(client: client, scheduler: scheduler)
    workspace.applyTree(try await client.tree())
    await workspace.openToday()

    var events: [String] = []
    var counter = 0
    var apiRead: (content: String, version: String)?
    /// Lines the API client deleted, with how many writes had landed by then.
    var deletes: [(landed: Int, lines: [String])] = []
    /// Tokens the user typed, with how many writes had landed by then.
    var typed: [(landed: Int, token: String)] = []

    func vault() -> (content: String, version: String) {
      let note = client.note(Self.path)!
      return (note.content, note.version)
    }
    func writeElsewhere(_ content: String) {
      events.append(client.setNote(Self.path, content))
    }
    func edit(_ change: ([String]) -> [String], token: String) {
      guard workspace.activePath == Self.path else { return }
      typed.append((client.landed.count, token))
      type(
        change(TextMerge.lines(workspace.editor.controller.text)).joined(separator: "\n"),
        in: workspace)
    }

    for _ in 0..<40 {
      counter += 1
      switch Int.random(in: 0..<20, using: &random) {
      case 0..<3:
        edit({ lines in [lines[0] + " t\(counter)"] + lines.dropFirst() }, token: "t\(counter)")
      case 3..<5:
        edit({ $0 + ["- [ ] u\(counter)"] }, token: "u\(counter)")
      case 5..<7:
        if workspace.activePath == Self.path {
          await workspace.openNote("Ideas.md", OpenOptions(newTab: true))
        } else {
          workspace.activateTab(Self.path)
        }
      case 7:
        await workspace.notes.flushAll()
      case 8..<10:
        var lines = TextMerge.lines(vault().content)
        let tasks = lines.indices.filter { lines[$0].hasPrefix("- [ ]") }
        let at =
          tasks.isEmpty ? lines.count - 1 : tasks[Int.random(in: 0..<tasks.count, using: &random)]
        lines.insert("\t- r\(counter) %%agent:thr_\(counter)%%", at: at + 1)
        writeElsewhere(lines.joined(separator: "\n"))
      case 10:
        writeElsewhere(vault().content + "\n- [ ] a\(counter)")
      case 11:
        apiRead = vault()
      case 12..<14:
        guard let read = apiRead, read.version == vault().version else { break }
        apiRead = nil
        let lines = TextMerge.lines(read.content)
        let candidates = lines.dropFirst(2).filter { !$0.contains(" u") }
        guard !candidates.isEmpty else { break }
        let first = Int.random(in: 0..<candidates.count, using: &random)
        let victims = Set(
          [first, (first + 1) % candidates.count].map { candidates[candidates.startIndex + $0] })
        deletes.append((client.landed.count, Array(victims)))
        writeElsewhere(lines.filter { !victims.contains($0) }.joined(separator: "\n"))
      case 14..<18:
        guard !events.isEmpty else { break }
        let version = events.remove(at: Int.random(in: 0..<events.count, using: &random))
        workspace.handleVaultChanged(
          VaultChangedEvent(
            changes: [VaultChange(path: Self.path, kind: .modified, version: version)],
            origin: .external))
      default:
        scheduler.advance(by: [0.1, 0.3, 2][Int.random(in: 0..<3, using: &random)])
      }
      await settle(2)
    }

    if workspace.activePath != Self.path { workspace.activateTab(Self.path) }
    for version in events {
      workspace.handleVaultChanged(
        VaultChangedEvent(
          changes: [VaultChange(path: Self.path, kind: .modified, version: version)],
          origin: .external))
    }
    for _ in 0..<10 {
      await settle(2)
      scheduler.advance(by: 2)
    }
    try await eventually("seed \(seed): saved") { !workspace.notes.isBusy(Self.path) }

    let landed = client.landed
    for (index, write) in landed.enumerated() where write.path == Self.path {
      for delete in deletes where delete.landed <= index {
        for line in delete.lines {
          #expect(!TextMerge.lines(write.content).contains(line), "seed \(seed): \(line) came back")
        }
      }
      let unsaved = typed.filter { $0.landed <= index && !(write.before ?? "").contains($0.token) }
      if unsaved.isEmpty {
        #expect(write.content == write.before, "seed \(seed): wrote with nothing unsaved")
      }
    }
    let content = client.note(Self.path)!.content
    #expect(workspace.editor.controller.text == content, "seed \(seed): shows the vault's text")
    for entry in typed {
      #expect(content.contains(entry.token), "seed \(seed): lost \(entry.token)")
    }
    #expect(!client.writes.contains { $0.path.contains("conflict") }, "seed \(seed): no conflict")
  }
}
