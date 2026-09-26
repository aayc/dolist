import DailyDoListClientTestSupport
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListApp

@MainActor
@Suite("Command palette & quick switcher")
struct PaletteTests {
  /// A command with its catalog shortcut (``CommandID/shortcut``).
  private func command(_ id: CommandID, _ title: String) -> AppCommand {
    AppCommand(id, title) {}
  }

  @Test func emptyQueryListsCommandsAlphabeticallyWithShortcuts() {
    let palette = PaletteModel(
      mode: .commands,
      commands: [
        command(.todaysNote, "Open today's daily note"),
        command(.newNote, "Create new note"),
        command(.toggleTheme, "Toggle light/dark theme"),
      ])
    #expect(
      palette.items.map(\.title) == [
        "Create new note", "Open today's daily note", "Toggle light/dark theme",
      ])
    #expect(palette.items.map { $0.shortcut?.display } == ["⌘N", "⇧⌘D", nil])
  }

  @Test func queryRanksMatchesAndHighlightsCharacters() throws {
    let palette = PaletteModel(
      mode: .commands,
      commands: [
        command(.todaysNote, "Open today's daily note"),
        command(.newNote, "Create new note"),
        command(.toggleTheme, "Toggle light/dark theme"),
      ])
    palette.query = "today"
    let first = try #require(palette.items.first)
    #expect(first.kind == .command(.todaysNote))
    #expect(!palette.items.contains { $0.kind == .command(.newNote) })
    palette.query = "zzz"
    #expect(palette.items.isEmpty)
  }

  @Test func keyboardSelectionWrapsAndResetsOnTyping() {
    let palette = PaletteModel(
      mode: .commands,
      commands: [
        command(.newNote, "A"), command(.newFolder, "B"), command(.toggleTheme, "C"),
      ])
    #expect(palette.selectedIndex == 0)
    palette.moveSelection(by: -1)
    #expect(palette.selectedItem?.title == "C")
    palette.moveSelection(by: 1)
    #expect(palette.selectedItem?.title == "A")
    palette.moveSelection(by: 1)
    palette.query = "c"
    #expect(palette.selectedIndex == 0)
  }

  @Test func switcherShowsRecentNotesFirstForAnEmptyQuery() {
    let palette = PaletteModel(
      mode: .switcher,
      files: ["Daily/2026-09-21.md", "Daily/2026-09-23.md", "Ideas.md", "Projects/Plan.md"],
      recent: ["Projects/Plan.md", "Missing.md"], openTabs: ["Ideas.md"])
    #expect(palette.items.map(\.title) == ["Plan", "Ideas", "2026-09-23", "2026-09-21"])
    #expect(palette.items.first?.subtitle == "Projects")
  }

  @Test func switcherPrefersNameMatchesOverPathMatches() {
    let items = PaletteRanking.notes(
      "plan", files: ["Planning/Other.md", "Projects/Plan.md", "Archive/Old Plan.md"])
    #expect(items.first?.kind == .note("Projects/Plan.md"))
    #expect(items.contains { $0.kind == .note("Planning/Other.md") }, "path matches still count")
  }

  @Test func switcherOffersToCreateTheQuery() {
    let palette = PaletteModel(mode: .switcher, files: ["Ideas.md"])
    palette.query = "  Trip to Lisbon "
    #expect(palette.creatableName == "Trip to Lisbon")
    #expect(PaletteModel(mode: .commands).creatableName == nil)
  }

  @Test func highlightingMarksMatchedCharacters() {
    let attributed = HighlightedText.attributed("Plan 🚀 x", highlights: [0, 5, 99])
    let highlighted = attributed.runs.filter { $0.foregroundColor != nil }.map {
      String(attributed[$0.range].characters)
    }
    #expect(highlighted.contains("P"))
    #expect(highlighted.contains("🚀"), "a surrogate-pair offset highlights the whole character")
  }

  @Test func shortcutDisplayUsesAppleModifierOrder() {
    #expect(Shortcut("d", [.command, .shift]).display == "⇧⌘D")
    #expect(Shortcut("\t", [.control, .shift]).display == "⌃⇧⇥")
    #expect(Shortcut("\\").display == "⌘\\")
  }
}

@MainActor
@Suite("Command catalog")
struct CommandCatalogTests {
  @Test func everyCommandIsDefinedOnceAndShortcutsDontCollide() async throws {
    let model = AppModel(environment: makeEnvironment(client: FakeDaemonClient()))
    let all = CommandCatalog(model: model).all
    #expect(Set(all.map(\.id)).count == all.count)
    #expect(Set(all.map(\.id)) == Set(CommandID.allCases))
    let shortcuts = all.compactMap(\.shortcut)
    #expect(Set(shortcuts).count == shortcuts.count, "no two commands share a shortcut")
  }

  @Test func requiredShortcutsAreBound() async throws {
    let model = AppModel(environment: makeEnvironment(client: FakeDaemonClient()))
    let catalog = CommandCatalog(model: model)
    let expected: [CommandID: String] = [
      .newNote: "⌘N", .todaysNote: "⇧⌘D", .previousDaily: "⇧⌘P", .nextDaily: "⇧⌘N",
      .weeklyNote: "⇧⌘W",
      .quickOpen: "⌘O", .closeTab: "⌘W", .reopenTab: "⇧⌘T", .toggleAgentPanel: "⌘\\",
      .agentInbox: "⇧⌘A",
      .search: "⇧⌘F", .commandPalette: "⌘P", .back: "⌘[", .forward: "⌘]", .increaseFontSize: "⌘+",
      .decreaseFontSize: "⌘-", .resetFontSize: "⌘0", .tab1: "⌘1", .tab9: "⌘9",
      .insertDrawing: "⇧⌘X",
    ]
    for (id, display) in expected {
      #expect(catalog.command(id)?.shortcut?.display == display, "\(id)")
    }
  }

  @Test func insertDrawingIsInThePaletteWhenANoteIsOpen() async throws {
    let client = FakeDaemonClient(notes: ["Ideas.md": "ideas"])
    let model = AppModel(environment: makeEnvironment(client: client))
    let catalog = CommandCatalog(model: model)
    #expect(catalog.command(.insertDrawing)?.isEnabled() == false, "nothing open before boot")
    await model.boot()
    let workspace = try #require(model.workspace)
    await workspace.openNote("Ideas.md")
    let command = try #require(catalog.paletteCommands.first { $0.id == .insertDrawing })
    #expect(command.paletteTitle == "Insert drawing")
    #expect(command.title == "Insert Drawing")
    #expect(CommandID(vimCommandID: "editor:insert-drawing") == .insertDrawing)
    await model.teardown()
  }

  @Test func availabilityFollowsTheWorkspaceState() async throws {
    let client = FakeDaemonClient(notes: ["Ideas.md": "ideas"])
    let model = AppModel(environment: makeEnvironment(client: client))
    let catalog = CommandCatalog(model: model)
    #expect(catalog.paletteCommands.isEmpty == false)
    #expect(catalog.command(.todaysNote)?.isEnabled() == false, "nothing works before boot")
    #expect(catalog.run(.newNote) == false)

    await model.boot()
    #expect(catalog.command(.todaysNote)?.isEnabled() == true)
    #expect(catalog.command(.save)?.isEnabled() == true)
    #expect(catalog.command(.back)?.isEnabled() == false)
    #expect(catalog.command(.reopenTab)?.isEnabled() == false)
    #expect(
      !catalog.paletteCommands.contains { $0.id == .back }, "unavailable commands aren't listed")
    #expect(!catalog.paletteCommands.contains { $0.id == .commandPalette })
    #expect(!catalog.paletteCommands.contains { $0.id == .tab1 })

    let workspace = try #require(model.workspace)
    await workspace.openNote("Ideas.md")
    #expect(catalog.command(.back)?.isEnabled() == true)
    workspace.closeActiveTab()
    #expect(catalog.command(.reopenTab)?.isEnabled() == true)
    #expect(catalog.command(.save)?.isEnabled() == false, "no active note")
    await model.teardown()
  }

  @Test func revealInFinderGoesThroughTheEnvironment() async throws {
    var environment = makeEnvironment(client: FakeDaemonClient(notes: ["Projects/Ideas.md": "x"]))
    var revealed: [URL] = []
    environment.revealInFinder = { revealed.append($0) }
    let model = AppModel(environment: environment)
    await model.boot()
    let workspace = try #require(model.workspace)
    workspace.localVaultURL = URL(fileURLWithPath: "/Users/me/Vault", isDirectory: true)
    await workspace.openNote("Projects/Ideas.md")
    #expect(CommandCatalog(model: model).run(.revealNote))
    #expect(revealed.map(\.path) == ["/Users/me/Vault/Projects/Ideas.md"])
    await model.teardown()
  }

  @Test func paletteCommandsRunAgainstTheModel() async throws {
    let model = AppModel(environment: makeEnvironment(client: FakeDaemonClient()))
    await model.boot()
    let catalog = CommandCatalog(model: model)
    #expect(catalog.run(.toggleAgentPanel))
    #expect(model.ui.inspectorPresented)
    #expect(catalog.run(.agentInbox))
    #expect(model.ui.inspectorPresented == false, "⇧⌘A toggles the inbox off again")
    #expect(catalog.run(.quickOpen))
    #expect(model.ui.palette == .switcher)
    #expect(catalog.run(.search))
    #expect(model.ui.sidebarMode == .search)
    #expect(catalog.run(.increaseFontSize))
    try await eventually { model.settings.settings.editor.fontSize == 17 }
    #expect(catalog.run(.resetFontSize))
    try await eventually { model.settings.settings.editor.fontSize == 16 }
    await model.teardown()
  }
}
