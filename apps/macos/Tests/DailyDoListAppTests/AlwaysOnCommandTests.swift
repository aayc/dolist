import AppKit
import DailyDoListAgent
import DailyDoListClient
import DailyDoListModels
import DailyDoListUI
import DailyDoListUITestSupport
import SwiftUI
import Testing

@testable import DailyDoListApp

/// Where the orchestrator runs, from the Agent menu and the palette, and the panel's control
/// opening Settings where the missing setup gets done.
@MainActor
@Suite("Always-on commands", .serialized)
struct AlwaysOnCommandTests {
  func bootedModel(_ remote: InMemoryDaemonClient.Remote) async throws -> AppModel {
    let client = InMemoryDaemonClient(
      seed: .empty, clock: .immediate(), agent: .enabled, clientId: "macos_test", remote: remote)
    let model = AppModel(environment: makeEnvironment(client: client))
    await model.boot()
    try await eventually("the agent's placement") { model.agent?.placement != nil }
    return model
  }

  @Test func theCommandsAreNamedAndHaveNoShortcut() async throws {
    let model = try await bootedModel(.alwaysOn)
    let catalog = CommandCatalog(model: model)
    let here = try #require(catalog.command(.runOrchestratorHere))
    #expect(here.title == "Run the Orchestrator on This Device")
    #expect(here.paletteTitle == "Run the orchestrator on this device")
    let machine = try #require(catalog.command(.runOrchestratorOnMachine))
    #expect(machine.title == "Run the Orchestrator on the Always-On Machine")
    #expect(machine.paletteTitle == "Run the orchestrator on the always-on machine")
    #expect(here.shortcut == nil && machine.shortcut == nil)
    #expect(CommandID(vimCommandID: "agent:run-here") == .runOrchestratorHere)
    #expect(CommandID(vimCommandID: "agent.runOnMachine") == .runOrchestratorOnMachine)
    await model.teardown()
  }

  @Test func theMenuChecksWhereItRunsAndThePaletteOffersTheOther() async throws {
    let model = try await bootedModel(.alwaysOn)
    let catalog = CommandCatalog(model: model)
    var here = try #require(catalog.command(.runOrchestratorHere))
    var machine = try #require(catalog.command(.runOrchestratorOnMachine))
    #expect(here.isOn?() == true && !here.isEnabled())
    #expect(machine.isOn?() == false && machine.isEnabled())
    var palette = catalog.paletteCommands.map(\.id)
    #expect(palette.contains(.runOrchestratorOnMachine) && !palette.contains(.runOrchestratorHere))

    #expect(catalog.run(.runOrchestratorOnMachine))
    try await eventually("the machine runs it") {
      model.agent?.placement?.runsOn?.alwaysOnMachine == true
    }
    here = try #require(CommandCatalog(model: model).command(.runOrchestratorHere))
    machine = try #require(CommandCatalog(model: model).command(.runOrchestratorOnMachine))
    #expect(here.isEnabled() && machine.isOn?() == true && !machine.isEnabled())
    palette = CommandCatalog(model: model).paletteCommands.map(\.id)
    #expect(palette.contains(.runOrchestratorHere) && !palette.contains(.runOrchestratorOnMachine))
    await model.teardown()
  }

  @Test func whileHeldHereNeitherCommandRuns() async throws {
    let model = try await bootedModel(.standalone)
    let catalog = CommandCatalog(model: model)
    #expect(!catalog.run(.runOrchestratorHere))
    #expect(!catalog.run(.runOrchestratorOnMachine))
    #expect(catalog.command(.runOrchestratorHere)?.isOn?() == true, "it runs here")
    #expect(model.agent?.placement?.heldHere == .noSync)
    await model.teardown()
  }

  @Test func theAlwaysOnMachineOffersNoChoice() async throws {
    let model = try await bootedModel(.host)
    let catalog = CommandCatalog(model: model)
    #expect(catalog.command(.runOrchestratorHere)?.isEnabled() == false)
    #expect(catalog.command(.runOrchestratorOnMachine)?.isEnabled() == false)
    #expect(model.agent?.orchestratorLocation?.isHost == true)
    await model.teardown()
  }

  @Test func setUpOpensSettingsOnTheAlwaysOnPane() async throws {
    let model = try await bootedModel(.standalone)
    model.ui.settingsPane = .general
    model.showAlwaysOnSettings(AlwaysOnSection(.alwaysOnMachine))
    #expect(model.ui.settingsPane == .alwaysOn)
    await model.teardown()
  }

  /// The panel's controls in the workspace: the Remote switch and "Run It on This Device Instead"
  /// run the catalog's commands.
  @Test func thePanelsControlsRunTheCatalogsCommands() async throws {
    var remote = InMemoryDaemonClient.Remote.alwaysOn
    remote.placement = .alwaysOnMachine
    let client = InMemoryDaemonClient(
      seed: .empty, clock: .immediate(), agent: .enabled, clientId: "macos_test", remote: remote)
    let model = AppModel(environment: makeEnvironment(client: client))
    await model.boot()
    let workspace = try #require(model.workspace)
    await client.simulateMachine(reachable: false)
    try await eventually("the relay is down") { model.agent?.placement?.relay == .unreachable }
    model.ui.inspectorPresented = true
    let anchors = Self.anchors(
      WorkspaceView(model: model, workspace: workspace, ui: model.ui)
        .agentReferenceDate(referenceNow))
    for (text, command) in [
      ("Run the orchestrator on this device instead", CommandID.runOrchestratorHere),
      ("Run the orchestrator on this device", .runOrchestratorHere),
    ] {
      let anchor = try #require(anchors.first { $0.tooltipContent()?.lines.first?.text == text })
      #expect(anchor.command == command.rawValue)
      #expect(anchor.tooltipContent()?.lines.first?.keys == command.shortcut)
    }
    await model.teardown()
  }

  /// Settings has the same switch, running the same commands, and says when an environment
  /// variable sets it.
  @Test func theSettingsSwitchRunsTheCatalogsCommands() async throws {
    func anchors(_ remote: InMemoryDaemonClient.Remote) async throws -> [TooltipAnchorView] {
      let model = try await bootedModel(remote)
      await model.remote.load()
      model.ui.alwaysOnSection = .agentLocation
      let anchors = Self.anchors(AlwaysOnSettingsPane(model: model, remote: model.remote))
      await model.teardown()
      return anchors
    }
    let remote = try #require(
      try await anchors(.alwaysOn).first {
        $0.tooltipContent()?.lines.first?.text == "Run the orchestrator on your always-on machine"
      })
    #expect(remote.command == CommandID.runOrchestratorOnMachine.rawValue)
    #expect(
      remote.tooltipContent()?.lines.first?.keys == CommandID.runOrchestratorOnMachine.shortcut)

    var locked = InMemoryDaemonClient.Remote.alwaysOn
    locked.lockedByEnv = [.placement]
    #expect(
      try await anchors(locked).contains {
        $0.tooltipContent()?.plainText == "Set by an environment variable"
      })
  }

  static func anchors(_ view: some View) -> [TooltipAnchorView] {
    let size = CGSize(width: 1440, height: 800)
    let hosting = NSHostingView(
      rootView: view.environment(\.tooltipCenter, QuietTooltips.makeCenter()))
    let window = NSWindow(
      contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless],
      backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    hosting.frame = NSRect(origin: .zero, size: size)
    window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
    window.orderFrontRegardless()
    for _ in 0..<6 {
      hosting.layoutSubtreeIfNeeded()
      window.displayIfNeeded()
      RunLoop.main.run(until: Date().addingTimeInterval(0.03))
    }
    let anchors = tooltipAnchors(in: hosting)
    window.close()
    return anchors
  }
}
