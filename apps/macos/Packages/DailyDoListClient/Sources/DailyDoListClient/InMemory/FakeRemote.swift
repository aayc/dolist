import DailyDoListModels
import Foundation

extension InMemoryDaemonClient {
  /// This device's side of the always-on setup when the fake starts: sync, the always-on machine,
  /// the placement and what environment variables lock.
  public struct Remote: Sendable {
    public var deviceName: String
    /// The sync service's address, or nil for a device that doesn't sync.
    public var syncURL: String?
    public var vault: String?
    /// The vault's always-on machine (a synced setting).
    public var machine: AlwaysOnMachine?
    /// This device holds a credential for the machine.
    public var machinePaired: Bool
    public var placement: AgentPlacement
    public var remoteHosts: [String]
    public var lockedByEnv: [DeviceSettingField]

    public init(
      deviceName: String = "This Mac", syncURL: String? = nil, vault: String? = nil,
      machine: AlwaysOnMachine? = nil, machinePaired: Bool = false,
      placement: AgentPlacement = .thisDevice, remoteHosts: [String] = [],
      lockedByEnv: [DeviceSettingField] = []
    ) {
      self.deviceName = deviceName
      self.syncURL = syncURL
      self.vault = vault
      self.machine = machine
      self.machinePaired = machinePaired
      self.placement = placement
      self.remoteHosts = remoteHosts
      self.lockedByEnv = lockedByEnv
    }

    /// No sync and no always-on machine: the agent is held on this device (today's setup).
    public static let standalone = Remote()

    /// Syncing, with a paired, reachable always-on machine (`vm-name`); the agent runs here.
    public static let alwaysOn = Remote(
      syncURL: "https://sync.example.com", vault: "demo_vault", machine: demoMachine,
      machinePaired: true)

    /// The always-on machine itself.
    public static let host = Remote(
      deviceName: "vm-name", syncURL: "https://sync.example.com", vault: "demo_vault",
      machine: demoMachine, placement: .alwaysOnHost,
      remoteHosts: ["vm-name.tailnet-name.ts.net"], lockedByEnv: [.placement, .remoteHosts])

    static let demoMachine = AlwaysOnMachine(
      name: "vm-name", url: "https://vm-name.tailnet-name.ts.net")
  }
}

/// Who holds the agent lease, as the fake simulates it.
enum FakeHolder: Hashable, Sendable {
  case thisDevice
  case machine
  /// Another device set to run the agent itself (equal priority: it keeps the lease).
  case other(String)
}

/// The fake's device-local settings, pairing state and the simulated always-on machine.
struct FakeRemote: Sendable {
  struct Handover: Sendable {
    var to: FakeHolder
    var note: String
    var generation: Int
  }

  struct PairingCode: Sendable {
    var expiresAt: EpochMillis
    var name: String?
  }

  static let deviceId = "dev_this_device"
  static let machineDeviceId = "dev_always_on"
  static let pairingCodeLifetime: EpochMillis = 5 * 60 * 1000
  static let maxOutstandingCodes = 3
  static let pairAttemptsPerMinute = 5
  static let failuresBeforeReset = 10

  var deviceName: String
  var placement: AgentPlacement
  var remoteHosts: [String]
  var syncURL: String?
  var vault: String?
  var hasSyncToken: Bool
  var lockedByEnv: [DeviceSettingField]

  var pairedDevices: [PairedDevice] = []
  var pairingCodes: [String: PairingCode] = [:]
  var pairAttempts: [EpochMillis] = []
  var pairFailures = 0
  var codeCounter = 0

  var machinePaired: Bool
  var machineCheckedAt: EpochMillis?
  /// Simulation: whether the machine answers.
  var machineReachable = true
  /// Simulation: whether the machine refuses every pairing code.
  var machineRejectsCodes = false

  var holder: FakeHolder = .thisDevice
  var handover: Handover?
  var handoverGeneration = 0

  init(_ setup: InMemoryDaemonClient.Remote) {
    deviceName = setup.deviceName
    placement = setup.placement
    remoteHosts = setup.remoteHosts
    syncURL = setup.syncURL
    vault = setup.vault
    hasSyncToken = setup.syncURL != nil
    lockedByEnv = setup.lockedByEnv
    machinePaired = setup.machinePaired
  }

  var syncs: Bool { syncURL != nil }

  func isLocked(_ field: DeviceSettingField) -> Bool { lockedByEnv.contains(field) }
}
