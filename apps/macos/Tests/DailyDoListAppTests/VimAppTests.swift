import AppKit
import DailyDoListAgent
import DailyDoListClient
import DailyDoListClientTestSupport
import DailyDoListEditor
import DailyDoListModels
import DailyDoListVim
import Foundation
import Testing

@testable import DailyDoListApp

/// Vim mode in the app: ex commands and keys doing workspace actions, the shared engine, the
/// vimrc from settings, the menu/palette toggle, the status bar, the clipboard registers and
/// badges through vim edits.
@MainActor
@Suite("Vim in the app")
struct VimAppTests {
  let client = FakeDaemonClient(notes: [
    "Daily/2026-09-23.md": "Intro\n- [ ] Book flights to Lisbon\n- [ ] Buy milk",
    "Ideas.md": "ideas",
    "Projects/Launch/Plan.md": "plan",
  ])
  let scheduler = ManualScheduler()
  let vim = Vim(scheduler: ManualVimScheduler())
  /// Kept for the whole test, like the app model keeps it (its commands stop with it).
  let integration: EditorVimIntegration

  init() {
    integration = EditorVimIntegration(
      vim: vim, pasteboard: SystemVimPasteboard(privatePasteboard()))
  }

  private func vimWorkspace(agent: AgentStore? = nil) async throws -> Workspace {
    var settings = AppSettings.defaults
    settings.editor.vimMode = true
    let workspace = makeWorkspace(
      client: client, scheduler: scheduler, settings: settings, agent: agent, vim: vim)
    workspace.applyTree(try await client.tree())
    await workspace.openToday()
    return workspace
  }

  private func session(_ workspace: Workspace) throws -> VimSession {
    try #require(workspace.editor.controller.vimSession)
  }

  private func ex(_ workspace: Workspace, _ input: String) throws {
    try vim.handleEx(input, in: try session(workspace))
  }

  private func keys(_ workspace: Workspace, _ keys: String...) throws {
    for key in keys { try session(workspace).handleKey(key) }
  }

  @Test func tabCommandsAndGtSwitchTabs() async throws {
    let workspace = try await vimWorkspace()
    await workspace.openNote("Ideas.md", OpenOptions(newTab: true))
    await workspace.openNote("Projects/Launch/Plan.md", OpenOptions(newTab: true))
    #expect(workspace.tabs.tabs == ["Daily/2026-09-23.md", "Ideas.md", "Projects/Launch/Plan.md"])
    #expect(workspace.activePath == "Projects/Launch/Plan.md")
    try ex(workspace, "tabnext")
    #expect(workspace.activePath == "Daily/2026-09-23.md", "wraps around")
    try ex(workspace, "tabn 3")
    #expect(workspace.activePath == "Projects/Launch/Plan.md")
    try ex(workspace, "tabp 2")
    #expect(workspace.activePath == "Daily/2026-09-23.md")
    try ex(workspace, "bn")
    #expect(workspace.activePath == "Ideas.md")
    try keys(workspace, "g", "t")
    #expect(workspace.activePath == "Projects/Launch/Plan.md")
    try keys(workspace, "1", "g", "t")
    #expect(workspace.activePath == "Daily/2026-09-23.md")
    try keys(workspace, "g", "T")
    #expect(workspace.activePath == "Projects/Launch/Plan.md")
    // Every switch is a new note for vim: a fresh session in normal mode.
    #expect(try session(workspace).mode == .normal)
  }

  @Test func quitCommandsCloseTabs() async throws {
    let workspace = try await vimWorkspace()
    await workspace.openNote("Ideas.md", OpenOptions(newTab: true))
    try ex(workspace, "q")
    #expect(workspace.tabs.tabs == ["Daily/2026-09-23.md"])
    await workspace.openNote("Ideas.md", OpenOptions(newTab: true))
    try ex(workspace, "qa")
    #expect(workspace.tabs.tabs.isEmpty)
    #expect(workspace.activePath == nil)
  }

  @Test func writeCommandsSave() async throws {
    let workspace = try await vimWorkspace()
    // Daily notes open with the caret at the end; start at the top.
    try keys(workspace, "g", "g", "x")
    #expect(workspace.notes.saveStates["Daily/2026-09-23.md"] == .dirty)
    try ex(workspace, "w")
    try await eventually("saved") {
      client.writes.last?.content == "ntro\n- [ ] Book flights to Lisbon\n- [ ] Buy milk"
    }
    try keys(workspace, "x")
    try ex(workspace, "wa")
    try await eventually("saved all") {
      client.writes.last?.content == "tro\n- [ ] Book flights to Lisbon\n- [ ] Buy milk"
    }
    try ex(workspace, "x")
    #expect(workspace.tabs.tabs.isEmpty)
  }

  @Test func editOpensNotesByNameOrTheSwitcher() async throws {
    let workspace = try await vimWorkspace()
    try ex(workspace, "e Ideas")
    try await eventually("Ideas open") { workspace.activePath == "Ideas.md" }
    #expect(workspace.tabs.tabs == ["Ideas.md"], ":e replaces the tab's note")
    try ex(workspace, "tabe Plan")
    try await eventually("Plan open") { workspace.activePath == "Projects/Launch/Plan.md" }
    #expect(workspace.tabs.tabs == ["Ideas.md", "Projects/Launch/Plan.md"])
    try ex(workspace, "e")
    #expect(workspace.ui.palette == .switcher)
  }

  @Test func obcommandRunsAppCommands() async throws {
    let workspace = try await vimWorkspace()
    var ran: [String] = []
    workspace.commandRunner = { id in
      ran.append(id)
      return id == "daily.today"
    }
    try ex(workspace, "obcommand daily.today")
    #expect(ran == ["daily.today"])
    try ex(workspace, "obcommand nope")
    #expect(try session(workspace).lastMessage == "No command nope")
  }

  @Test func commandIdsFromEitherApp() {
    #expect(CommandID(vimCommandID: "daily.today") == .todaysNote)
    #expect(CommandID(vimCommandID: "daily:today") == .todaysNote)
    #expect(CommandID(vimCommandID: "editor:live-preview") == .toggleLivePreview)
    #expect(CommandID(vimCommandID: "editor:line-numbers") == .toggleLineNumbers)
    #expect(CommandID(vimCommandID: "editor:vim") == .toggleVim)
    #expect(CommandID(vimCommandID: "panel:left") == .toggleSidebar)
    #expect(CommandID(vimCommandID: "nope:nothing") == nil)
    #expect(CommandID(vimCommandID: "") == nil)
  }

  @Test func theStatusFollowsVimAndClearsWhenItIsOff() async throws {
    let workspace = try await vimWorkspace()
    #expect(workspace.editor.vimStatus == EditorVimStatus(mode: .normal))
    try keys(workspace, "i")
    #expect(workspace.editor.vimStatus?.mode == .insert)
    try keys(workspace, "<Esc>", "q", "a")
    #expect(workspace.editor.vimStatus == EditorVimStatus(mode: .normal, recording: "a"))
    try keys(workspace, "q", "\"", "b", "2")
    #expect(workspace.editor.vimStatus?.pending == "\"b2")
    var settings = AppSettings.defaults
    settings.editor.vimMode = false
    workspace.editor.configure(settings.editor)
    #expect(workspace.editor.vimStatus == nil)
    #expect(workspace.editor.controller.vimSession == nil)
    #expect(VimIndicator.color(.insert) == Theme.success)
    #expect(VimIndicator.color(.visualBlock) == Theme.warning)
    #expect(VimIndicator.color(.normal) == Theme.accent)
  }

}

/// The engine, the settings and the menu in a running app model.
@MainActor
@Suite("Vim app model")
struct VimAppModelTests {
  @Test func settingsTurnVimOnAndApplyTheVimrc() async throws {
    let client = FakeDaemonClient(notes: ["Ideas.md": "ideas"])
    client.withState {
      $0.settings.editor.vimMode = true
      $0.settings.editor.vimrc = "nmap Q i\n\" comment\nset bogus"
    }
    let model = AppModel(environment: makeEnvironment(client: client))
    await model.boot()
    let workspace = try #require(model.workspace)
    let session = try #require(workspace.editor.controller.vimSession)
    #expect(session.vim === model.vim)
    #expect(model.vimrcProblems == [VimrcProblem(line: 2, message: "Unknown option: bogus")])
    session.handleKey("Q")
    #expect(session.mode == .insert)
    session.handleKey("<Esc>")

    await model.settings.update(SettingsPatch(editor: .init(vimrc: "nmap Z i")))
    #expect(model.vimrcProblems.isEmpty)
    session.handleKey("Q")
    #expect(session.mode == .normal)

    // The palette and menu toggle.
    let command = try #require(CommandCatalog(model: model).command(.toggleVim))
    #expect(command.isOn?() == true)
    #expect(command.run())
    try await eventually("vim off") { workspace.editor.controller.vimSession == nil }
    #expect(model.settings.settings.editor.vimMode == false)
    #expect(command.isOn?() == false)
    await model.teardown()
  }

  @Test func obcommandRunsCatalogCommands() async throws {
    let client = FakeDaemonClient(notes: ["Ideas.md": "ideas"])
    client.withState { $0.settings.editor.vimMode = true }
    let model = AppModel(environment: makeEnvironment(client: client))
    await model.boot()
    let workspace = try #require(model.workspace)
    let session = try #require(workspace.editor.controller.vimSession)
    try model.vim.handleEx("obcommand editor:line-numbers", in: session)
    try await eventually("line numbers on") { model.settings.settings.editor.showLineNumbers }
    try model.vim.handleEx("obcommand switcher.open", in: session)
    #expect(model.ui.palette == .switcher)
    await model.teardown()
  }

  @Test func clipboardRegistersUseThePasteboard() async throws {
    let client = FakeDaemonClient()
    client.withState { $0.settings.editor.vimMode = true }
    let pasteboard = privatePasteboard()
    var environment = makeEnvironment(client: client)
    environment.vimPasteboard = { SystemVimPasteboard(pasteboard) }
    let model = AppModel(environment: environment)
    await model.boot()
    let workspace = try #require(model.workspace)
    let session = try #require(workspace.editor.controller.vimSession)
    for key in ["\"", "+", "y", "y"] { session.handleKey(key) }
    #expect(pasteboard.string(forType: .string) == "- [ ] \n")
    pasteboard.clearContents()
    pasteboard.setString("from another app", forType: .string)
    for key in ["0", "\"", "*", "P"] { session.handleKey(key) }
    #expect(workspace.editor.controller.text.hasPrefix("from another app"))
    await model.teardown()
  }

  @Test func theEngineOutlivesReconnects() async throws {
    let client = FakeDaemonClient()
    client.withState { $0.settings.editor.vimMode = true }
    let model = AppModel(environment: makeEnvironment(client: client))
    await model.boot()
    let first = try #require(model.workspace?.editor.controller.vimSession)
    for key in ["y", "y"] { first.handleKey(key) }
    #expect(model.vim.register("\"").text.string == "- [ ] \n")
    await model.boot()
    let second = try #require(model.workspace?.editor.controller.vimSession)
    #expect(second !== first)
    #expect(second.vim === model.vim)
    #expect(model.vim.register("\"").text.string == "- [ ] \n")
    await model.teardown()
  }
}
