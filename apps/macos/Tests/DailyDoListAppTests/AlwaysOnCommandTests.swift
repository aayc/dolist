import AppKit
import DailyDoListAgent
import DailyDoListClient
import DailyDoListClientTestSupport
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
  nonisolated static let thisMac = AgentRunsOn(
    deviceId: "dev_mac", name: "Studio Mac", thisDevice: true, alwaysOnMachine: false)
  nonisolated static let vm = AgentRunsOn(
    deviceId: "dev_vm", name: "vm-name", thisDevice: false, alwaysOnMachine: true)
  nonisolated static let runsHere = AgentPlacementStatus(
    placement: .thisDevice, runsOn: thisMac, relay: .off)
  nonisolated static let heldHere = AgentPlacementStatus(
    placement: .thisDevice, heldHere: .noSync, runsOn: thisMac, relay: .off)

  /// A booted app whose daemon reports `placement`, and hands the agent over at once when asked.
  func bootedModel(
    _ placement: AgentPlacementStatus, lockedByEnv: [DeviceSettingField] = []
  ) async throws -> AppModel {
    let client = FakeDaemonClient()
    let base = client.withState { $0.agentStatus }
    let current = Locked(placement)
    client.script {
      $0.agentStatus = {
        var status = base
        status.placement = current.current
        return status
      }
      $0.deviceSettings = {
        DeviceSettingsResponse(
          device: .init(id: "dev_mac", name: "Studio Mac"), placement: current.current.placement,
          remoteHosts: [], sync: DeviceSyncSetup(url: nil, vault: nil, hasToken: false),
          lockedByEnv: lockedByEnv)
      }
      $0.updateDeviceSettings = { patch in
        let target = patch.placement ?? .thisDevice
        current.mutate {
          $0 = AgentPlacementStatus(
            placement: target, runsOn: target == .alwaysOnMachine ? Self.vm : Self.thisMac,
            relay: target == .alwaysOnMachine ? .connected : .off)
        }
        return DeviceSettingsResponse(
          device: .init(id: "dev_mac", name: "Studio Mac"), placement: target, remoteHosts: [],
          sync: DeviceSyncSetup(url: nil, vault: nil, hasToken: false))
      }
    }
    let model = AppModel(environment: makeEnvironment(client: client))
    await model.boot()
    try await eventually("the agent's placement") { model.agent?.placement != nil }
    return model
  }

  @Test func theCommandsAreNamedAndHaveNoShortcut() async throws {
    let model = try await bootedModel(Self.runsHere)
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
    let model = try await bootedModel(Self.runsHere)
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
    let model = try await bootedModel(Self.heldHere)
    let catalog = CommandCatalog(model: model)
    #expect(!catalog.run(.runOrchestratorHere))
    #expect(!catalog.run(.runOrchestratorOnMachine))
    #expect(catalog.command(.runOrchestratorHere)?.isOn?() == true, "it runs here")
    #expect(model.agent?.placement?.heldHere == .noSync)
    await model.teardown()
  }

  @Test func theAlwaysOnMachineOffersNoChoice() async throws {
    let host = AgentRunsOn(
      deviceId: "dev_vm", name: "vm-name", thisDevice: true, alwaysOnMachine: true)
    let model = try await bootedModel(
      AgentPlacementStatus(placement: .alwaysOnHost, runsOn: host, relay: .off))
    let catalog = CommandCatalog(model: model)
    #expect(catalog.command(.runOrchestratorHere)?.isEnabled() == false)
    #expect(catalog.command(.runOrchestratorOnMachine)?.isEnabled() == false)
    #expect(model.agent?.orchestratorLocation?.isHost == true)
    await model.teardown()
  }

  @Test func setUpOpensSettingsOnTheAlwaysOnPane() async throws {
    let model = try await bootedModel(Self.heldHere)
    model.ui.settingsPane = .general
    model.showAlwaysOnSettings(AlwaysOnSection(.alwaysOnMachine))
    #expect(model.ui.settingsPane == .alwaysOn)
    await model.teardown()
  }

  /// The panel's controls in the workspace: the Remote switch and "Run It on This Device Instead"
  /// run the catalog's commands.
  @Test func thePanelsControlsRunTheCatalogsCommands() async throws {
    let model = try await bootedModel(
      AgentPlacementStatus(placement: .alwaysOnMachine, runsOn: Self.vm, relay: .unreachable))
    let workspace = try #require(model.workspace)
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
    func anchors(_ lockedByEnv: [DeviceSettingField]) async throws -> [TooltipAnchorView] {
      let model = try await bootedModel(Self.runsHere, lockedByEnv: lockedByEnv)
      await model.remote.load()
      model.ui.alwaysOnSection = .agentLocation
      let anchors = Self.anchors(AlwaysOnSettingsPane(model: model, remote: model.remote))
      await model.teardown()
      return anchors
    }
    let remote = try #require(
      try await anchors([]).first {
        $0.tooltipContent()?.lines.first?.text == "Run the orchestrator on your always-on machine"
      })
    #expect(remote.command == CommandID.runOrchestratorOnMachine.rawValue)
    #expect(
      remote.tooltipContent()?.lines.first?.keys == CommandID.runOrchestratorOnMachine.shortcut)

    #expect(
      try await anchors([.placement]).contains {
        $0.tooltipContent()?.plainText == "Set by an environment variable"
      })
  }

  static func anchors(_ view: some View) -> [TooltipAnchorView] {
    tooltipAnchors(of: view, size: CGSize(width: 1440, height: 800))
  }
}
