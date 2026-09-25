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
    #expect(model.agent?.placement?.heldHere == .noMachine)
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

  /// The panel's control in the workspace: "Run It on This Device Instead" runs the catalog's
  /// command, and the disabled control explains itself.
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
    let anchors = Self.anchors(model, workspace)
    let runHere = try #require(
      anchors.first {
        $0.tooltipContent()?.lines.first?.text == "Run the orchestrator on this device instead"
      })
    #expect(runHere.command == CommandID.runOrchestratorHere.rawValue)
    #expect(runHere.tooltipContent()?.lines.first?.keys == CommandID.runOrchestratorHere.shortcut)
    await model.teardown()
  }

  static func anchors(_ model: AppModel, _ workspace: Workspace) -> [TooltipAnchorView] {
    let size = CGSize(width: 1440, height: 800)
    let hosting = NSHostingView(
      rootView: WorkspaceView(model: model, workspace: workspace, ui: model.ui)
        .agentReferenceDate(referenceNow)
        .environment(\.tooltipCenter, QuietTooltips.makeCenter()))
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
