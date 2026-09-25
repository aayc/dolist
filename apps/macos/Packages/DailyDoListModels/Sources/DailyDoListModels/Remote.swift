import Foundation

// Swift mirror of the placement, device settings, pairing and always-on machine shapes of
// `packages/core/src/protocol.ts`. Enums a newer daemon may extend are `WireEnum`s.

// MARK: - Placement, readiness

/// Where this device's agent runs (a device-local setting): here and taking the agent over from the
/// always-on machine (`thisDevice`), relayed to the always-on machine (`alwaysOnMachine`), or this
/// is the always-on machine (`alwaysOnHost`). Without sync a daemon runs its own agent anyway.
public struct AgentPlacement: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let thisDevice: Self = "this_device"
  public static let alwaysOnMachine: Self = "always_on_machine"
  public static let alwaysOnHost: Self = "always_on_host"
}

/// The device that holds the agent lease.
public struct AgentRunsOn: Codable, Hashable, Sendable {
  public var deviceId: String
  public var name: String
  public var thisDevice: Bool
  /// The holder requested the lease with priority "host".
  public var alwaysOnMachine: Bool

  public init(deviceId: String, name: String, thisDevice: Bool, alwaysOnMachine: Bool) {
    self.deviceId = deviceId
    self.name = name
    self.thisDevice = thisDevice
    self.alwaysOnMachine = alwaysOnMachine
  }
}

/// The link to the always-on machine's agent.
public struct RelayState: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let off: Self = "off"
  public static let connecting: Self = "connecting"
  public static let connected: Self = "connected"
  public static let unreachable: Self = "unreachable"
  public static let notPaired: Self = "not_paired"
}

/// Why the agent is held on this device despite the stored placement: no always-on machine is set
/// up, or this device doesn't sync.
public struct HeldHereReason: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let noMachine: Self = "no_machine"
  public static let noSync: Self = "no_sync"
}

/// This device's placement and who runs the agent now.
public struct AgentPlacementStatus: Codable, Hashable, Sendable {
  /// The stored choice (see `heldHere` for when it can't apply).
  public var placement: AgentPlacement
  /// Why the agent runs on this device anyway; nil when the stored choice applies.
  public var heldHere: HeldHereReason?
  /// Who runs the agent now (nil: nobody, or unknown without sync).
  public var runsOn: AgentRunsOn?
  public var relay: RelayState
  /// Short, human ("Taking over from vm-1…", "Handing the agent to vm-1…").
  public var note: String?

  public init(
    placement: AgentPlacement, heldHere: HeldHereReason? = nil, runsOn: AgentRunsOn?,
    relay: RelayState, note: String? = nil
  ) {
    self.placement = placement
    self.heldHere = heldHere
    self.runsOn = runsOn
    self.relay = relay
    self.note = note
  }

  enum CodingKeys: String, CodingKey { case placement, heldHere, runsOn, relay, note }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(placement, forKey: .placement)
    try c.encodeIfPresent(heldHere, forKey: .heldHere)
    // Required on the wire: null when nobody runs the agent.
    try c.encode(runsOn, forKey: .runsOn)
    try c.encode(relay, forKey: .relay)
    try c.encodeIfPresent(note, forKey: .note)
  }
}

/// Whether desktop control can run on a daemon's machine.
public struct ComputerReadiness: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let available: Self = "available"
  public static let needsPermissions: Self = "needs_permissions"
  public static let unsupported: Self = "unsupported"
}

/// Whether a daemon can run the agent: its harness, a model credential (never the value), the
/// browser, desktop control and connectors.
public struct AgentReadiness: Codable, Hashable, Sendable {
  public struct Harness: Codable, Hashable, Sendable {
    /// The harness's wire value, kept as sent so a harness a newer daemon added still decodes.
    public var kind: String
    public var ready: Bool
    public var problem: String?

    public init(kind: String, ready: Bool, problem: String? = nil) {
      self.kind = kind
      self.ready = ready
      self.problem = problem
    }

    public init(kind: AgentHarnessKind, ready: Bool, problem: String? = nil) {
      self.init(kind: kind.rawValue, ready: ready, problem: problem)
    }

    /// The harness, when this client knows it.
    public var knownKind: AgentHarnessKind? { AgentHarnessKind(rawValue: kind) }
  }

  public struct Connectors: Codable, Hashable, Sendable {
    public var configured: Int
    public var connected: Int

    public init(configured: Int, connected: Int) {
      self.configured = configured
      self.connected = connected
    }
  }

  public var harness: Harness
  /// A model credential for the configured harness is present.
  public var modelCredential: Bool
  public var browser: Bool
  public var computer: ComputerReadiness
  public var connectors: Connectors

  public init(
    harness: Harness, modelCredential: Bool, browser: Bool, computer: ComputerReadiness,
    connectors: Connectors
  ) {
    self.harness = harness
    self.modelCredential = modelCredential
    self.browser = browser
    self.computer = computer
    self.connectors = connectors
  }
}

// MARK: - This daemon's device-local settings

/// This device's link to the sync service. The vault token is never returned.
public struct DeviceSyncSetup: Codable, Hashable, Sendable {
  /// nil: not syncing with the sync service.
  public var url: String?
  public var vault: String?
  /// A vault token is saved.
  public var hasToken: Bool

  public init(url: String?, vault: String?, hasToken: Bool) {
    self.url = url
    self.vault = vault
    self.hasToken = hasToken
  }

  enum CodingKeys: String, CodingKey { case url, vault, hasToken }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    // Required on the wire: null when not syncing.
    try c.encode(url, forKey: .url)
    try c.encode(vault, forKey: .vault)
    try c.encode(hasToken, forKey: .hasToken)
  }
}

/// A device setting an environment variable can fix (`DeviceSettingsResponse.lockedByEnv`).
public struct DeviceSettingField: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let placement: Self = "placement"
  public static let remoteHosts: Self = "remoteHosts"
  public static let sync: Self = "sync"
}

/// `GET /api/device`: this daemon's device-local settings (never synced).
public struct DeviceSettingsResponse: Codable, Hashable, Sendable {
  public struct Device: Codable, Hashable, Sendable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
      self.id = id
      self.name = name
    }
  }

  public var device: Device
  public var placement: AgentPlacement
  /// Names this daemon answers to besides loopback (e.g. its tailnet name), lowercase.
  public var remoteHosts: [String]
  public var sync: DeviceSyncSetup
  /// Fields set by environment variables; shown read-only.
  public var lockedByEnv: [DeviceSettingField]

  public init(
    device: Device, placement: AgentPlacement, remoteHosts: [String], sync: DeviceSyncSetup,
    lockedByEnv: [DeviceSettingField] = []
  ) {
    self.device = device
    self.placement = placement
    self.remoteHosts = remoteHosts
    self.sync = sync
    self.lockedByEnv = lockedByEnv
  }

  public func isLocked(_ field: DeviceSettingField) -> Bool { lockedByEnv.contains(field) }
}

/// Body of `PATCH /api/device`: only non-nil fields are sent.
public struct DeviceSettingsPatch: Codable, Hashable, Sendable {
  /// 1–64 characters, trimmed.
  public var name: String?
  public var placement: AgentPlacement?
  /// DNS names with an optional `:port`, at most 8 (no IPs, schemes or paths).
  public var remoteHosts: [String]?

  public init(name: String? = nil, placement: AgentPlacement? = nil, remoteHosts: [String]? = nil) {
    self.name = name
    self.placement = placement
    self.remoteHosts = remoteHosts
  }
}

/// Body of `PUT /api/device/sync`.
public struct DeviceSyncSetupRequest: Codable, Hashable, Sendable {
  /// https (plain http only to loopback).
  public var url: String
  public var vault: String
  /// nil keeps the saved token.
  public var token: String?

  public init(url: String, vault: String, token: String? = nil) {
    self.url = url
    self.vault = vault
    self.token = token
  }
}

// MARK: - Pairing

/// What a paired device is: a browser (HttpOnly cookie), a native app, or another daemon.
public struct PairedDeviceKind: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let browser: Self = "browser"
  public static let app: Self = "app"
  public static let daemon: Self = "daemon"
}

/// A device holding a credential for this daemon.
public struct PairedDevice: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var name: String
  public var kind: PairedDeviceKind
  public var createdAt: EpochMillis
  public var lastSeenAt: EpochMillis?
  /// The device making this request.
  public var current: Bool?

  public init(
    id: String, name: String, kind: PairedDeviceKind, createdAt: EpochMillis,
    lastSeenAt: EpochMillis?, current: Bool? = nil
  ) {
    self.id = id
    self.name = name
    self.kind = kind
    self.createdAt = createdAt
    self.lastSeenAt = lastSeenAt
    self.current = current
  }

  enum CodingKeys: String, CodingKey { case id, name, kind, createdAt, lastSeenAt, current }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(name, forKey: .name)
    try c.encode(kind, forKey: .kind)
    try c.encode(createdAt, forKey: .createdAt)
    // Required on the wire: null before first use.
    try c.encode(lastSeenAt, forKey: .lastSeenAt)
    try c.encodeIfPresent(current, forKey: .current)
  }
}

/// Body of `POST /api/pairing-codes`.
public struct PairingCodeRequest: Codable, Hashable, Sendable {
  public var name: String?
  public init(name: String? = nil) { self.name = name }
}

/// A single-use pairing code.
public struct PairingCodeResponse: Codable, Hashable, Sendable {
  /// 8 characters without look-alikes; show it as `displayCode`.
  public var code: String
  public var expiresAt: EpochMillis
  /// `https://<first remote host>` for a QR code; nil without remote hosts.
  public var url: String?

  public init(code: String, expiresAt: EpochMillis, url: String?) {
    self.code = code
    self.expiresAt = expiresAt
    self.url = url
  }

  /// `XXXX-XXXX`.
  public var displayCode: String {
    guard code.count == 8 else { return code }
    return "\(code.prefix(4))-\(code.suffix(4))"
  }

  enum CodingKeys: String, CodingKey { case code, expiresAt, url }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(code, forKey: .code)
    try c.encode(expiresAt, forKey: .expiresAt)
    // Required on the wire: null without remote hosts.
    try c.encode(url, forKey: .url)
  }
}

/// Body of `POST /api/pair`: exchanges a pairing code (typed as shown, any case) for a credential.
public struct PairRequest: Codable, Hashable, Sendable {
  public var code: String
  public var name: String
  public var kind: PairedDeviceKind

  public init(code: String, name: String, kind: PairedDeviceKind) {
    self.code = code
    self.name = name
    self.kind = kind
  }
}

/// The paired device and, for `app` and `daemon` kinds, its token (shown once).
public struct PairResponse: Codable, Hashable, Sendable {
  public var device: PairedDevice
  public var token: String?

  public init(device: PairedDevice, token: String? = nil) {
    self.device = device
    self.token = token
  }
}

/// `GET /api/devices`.
public struct PairedDevicesResponse: Codable, Hashable, Sendable {
  public var devices: [PairedDevice]
  public init(devices: [PairedDevice]) { self.devices = devices }
}

// MARK: - The always-on machine

/// The always-on machine from this device's side: its address, this device's pairing and what the
/// machine reports.
public struct MachineStatusResponse: Codable, Hashable, Sendable {
  /// Where the agent runs, as the machine reports it.
  public struct Agent: Codable, Hashable, Sendable {
    public var runsOn: AgentRunsOn?
    public var problem: String?

    public init(runsOn: AgentRunsOn?, problem: String? = nil) {
      self.runsOn = runsOn
      self.problem = problem
    }

    enum CodingKeys: String, CodingKey { case runsOn, problem }

    public func encode(to encoder: Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(runsOn, forKey: .runsOn)
      try c.encodeIfPresent(problem, forKey: .problem)
    }
  }

  /// nil: no always-on machine configured.
  public var machine: AlwaysOnMachine?
  /// This device holds a credential for the machine.
  public var paired: Bool
  /// nil: not checked yet, or no machine.
  public var reachable: Bool?
  public var checkedAt: EpochMillis?
  public var version: String?
  public var agent: Agent?
  public var readiness: AgentReadiness?
  public var error: String?

  public init(
    machine: AlwaysOnMachine?, paired: Bool, reachable: Bool?, checkedAt: EpochMillis?,
    version: String? = nil, agent: Agent? = nil, readiness: AgentReadiness? = nil,
    error: String? = nil
  ) {
    self.machine = machine
    self.paired = paired
    self.reachable = reachable
    self.checkedAt = checkedAt
    self.version = version
    self.agent = agent
    self.readiness = readiness
    self.error = error
  }

  enum CodingKeys: String, CodingKey {
    case machine, paired, reachable, checkedAt, version, agent, readiness, error
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    // Required on the wire: null without a machine or before a check.
    try c.encode(machine, forKey: .machine)
    try c.encode(paired, forKey: .paired)
    try c.encode(reachable, forKey: .reachable)
    try c.encode(checkedAt, forKey: .checkedAt)
    try c.encodeIfPresent(version, forKey: .version)
    try c.encodeIfPresent(agent, forKey: .agent)
    try c.encodeIfPresent(readiness, forKey: .readiness)
    try c.encodeIfPresent(error, forKey: .error)
  }
}

/// Body of `POST /api/machine/pair`.
public struct MachinePairRequest: Codable, Hashable, Sendable {
  /// `https://<tailnet name>[:port]`, no path, query or credentials.
  public var url: String
  public var code: String
  /// nil: the first label of the host.
  public var name: String?

  public init(url: String, code: String, name: String? = nil) {
    self.url = url
    self.code = code
    self.name = name
  }
}
