import AppKit
import DailyDoListAgent
import DailyDoListClient
import DailyDoListClientTestSupport
import DailyDoListModels
import Testing

@testable import DailyDoListApp

/// Agent → Orchestrator Chat: one window of its own, opened on demand and focused when it's
/// already open, from the menu, the palette or vim's `:obcommand`.
@MainActor
@Suite("Orchestrator window", .serialized)
struct OrchestratorWindowTests {
  private func model() -> AppModel {
    AppModel(environment: makeEnvironment(client: FakeDaemonClient()))
  }

  /// Runs `body` with fresh window handles, restoring the shared ones afterwards.
  private func withHandles(_ body: (WindowHandles) throws -> Void) rethrows {
    let handles = WindowHandles.shared
    let (window, open) = (handles.orchestratorWindow, handles.openOrchestratorWindow)
    defer {
      handles.orchestratorWindow = window
      handles.openOrchestratorWindow = open
    }
    handles.orchestratorWindow = nil
    try body(handles)
  }

  @Test func isAnAgentMenuAndPaletteCommandWithoutAShortcut() throws {
    let catalog = CommandCatalog(model: model())
    let command = try #require(catalog.command(.orchestratorChat))
    #expect(command.title == "Orchestrator Chat")
    #expect(command.paletteTitle == "Open the orchestrator's chat")
    #expect(command.shortcut == nil)
    #expect(command.isEnabled())
    #expect(catalog.paletteCommands.contains { $0.id == .orchestratorChat })
    // The web app's id works in a vimrc too.
    #expect(CommandID(vimCommandID: "agent:orchestrator") == .orchestratorChat)
  }

  @Test func opensTheWindowOnceThenFocusesIt() throws {
    let model = model()
    try withHandles { handles in
      var opened = 0
      handles.openOrchestratorWindow = { opened += 1 }
      #expect(CommandCatalog(model: model).run(.orchestratorChat))
      #expect(opened == 1)

      let window = NSWindow(
        contentRect: NSRect(x: -20_000, y: -20_000, width: 300, height: 300),
        styleMask: [.titled, .miniaturizable], backing: .buffered, defer: false)
      window.isReleasedWhenClosed = false
      defer { window.close() }
      handles.orchestratorWindow = window
      window.orderFrontRegardless()
      model.showOrchestratorWindow()
      #expect(opened == 1, "an open window is brought forward, not opened again")
      #expect(window.isVisible)

      window.orderOut(nil)
      model.showOrchestratorWindow()
      #expect(opened == 2, "a closed window opens again")
    }
  }
}
