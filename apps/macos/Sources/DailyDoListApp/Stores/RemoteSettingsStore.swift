import DailyDoListClient
import DailyDoListModels
import Foundation
import Observation

/// This device's side of the always-on setup, for Settings → Always-On: the device settings
/// (name, placement, remote hosts, sync), the sync status, the always-on machine, and the devices
/// paired with this daemon. Every action keeps its own inline error.
@MainActor
@Observable
final class RemoteSettingsStore {
  /// An action whose failure shows next to its control.
  enum Action: Hashable {
    case load, rename, remoteHosts, sync, turnOffSync, pairMachine, checkMachine, forgetMachine
    case pairingCode, devices, revoke
  }

  private(set) var device: DeviceSettingsResponse?
  private(set) var syncStatus: SyncStatusResponse?
  private(set) var machine: MachineStatusResponse?
  private(set) var devices: [PairedDevice]?
  /// The latest pairing code this device issued, until it's dismissed.
  private(set) var pairingCode: PairingCodeResponse?
  /// Actions on their way to the daemon.
  private(set) var busy: Set<Action> = []
  /// Why the last attempt of each action failed.
  private(set) var errors: [Action: String] = [:]
  /// This daemon answers 404 for the device routes (it predates them).
  private(set) var isUnsupported = false

  @ObservationIgnored var client: DaemonClient?

  func isBusy(_ action: Action) -> Bool { busy.contains(action) }
  func error(_ action: Action) -> String? { errors[action] }
  func dismissError(_ action: Action) { errors[action] = nil }

  /// Forgets everything (the client went away).
  func reset() {
    device = nil
    syncStatus = nil
    machine = nil
    devices = nil
    pairingCode = nil
    busy = []
    errors = [:]
    isUnsupported = false
  }

  // MARK: - Loading

  /// Fetches the device settings, the sync status, the machine and the paired devices.
  func load() async {
    guard let client else { return }
    await run(.load) {
      async let device = client.deviceSettings()
      async let sync = Self.optional { try await client.syncStatus() }
      async let machine = Self.optional { try await client.machineStatus() }
      async let devices = Self.optional { try await client.pairedDevices() }
      self.device = try await device
      self.syncStatus = await sync
      self.machine = await machine
      self.devices = await devices
    }
  }

  func loadDevices() async {
    guard let client else { return }
    await run(.devices) { self.devices = try await client.pairedDevices() }
  }

  // MARK: - This device

  @discardableResult
  func rename(_ name: String) async -> Bool {
    await update(.rename, DeviceSettingsPatch(name: name))
  }

  @discardableResult
  func setRemoteHosts(_ hosts: [String]) async -> Bool {
    await update(.remoteHosts, DeviceSettingsPatch(remoteHosts: hosts))
  }

  /// Points this device at the sync service; a nil `token` keeps the saved one.
  @discardableResult
  func setUpSync(url: String, vault: String, token: String?) async -> Bool {
    guard let client else { return false }
    return await run(.sync) {
      self.device = try await client.setUpSync(
        DeviceSyncSetupRequest(url: url, vault: vault, token: token))
      self.syncStatus = try? await client.syncStatus()
    }
  }

  @discardableResult
  func turnOffSync() async -> Bool {
    guard let client else { return false }
    return await run(.turnOffSync) {
      self.device = try await client.turnOffSync()
      self.syncStatus = try? await client.syncStatus()
    }
  }

  private func update(_ action: Action, _ patch: DeviceSettingsPatch) async -> Bool {
    guard let client else { return false }
    return await run(action) { self.device = try await client.updateDeviceSettings(patch) }
  }

  // MARK: - The always-on machine

  @discardableResult
  func pairMachine(url: String, code: String, name: String?) async -> Bool {
    guard let client else { return false }
    return await run(.pairMachine) {
      self.machine = try await client.pairMachine(
        MachinePairRequest(url: url, code: code, name: name))
    }
  }

  /// The machine's last known status, quietly (no error shows when it fails).
  func refreshMachine() async {
    guard let client, let status = try? await client.machineStatus() else { return }
    machine = status
  }

  func checkMachine() async {
    guard let client else { return }
    await run(.checkMachine) { self.machine = try await client.checkMachine() }
  }

  func forgetMachine() async {
    guard let client else { return }
    await run(.forgetMachine) { self.machine = try await client.forgetMachine() }
  }

  // MARK: - Pairing other devices

  func createPairingCode(name: String?) async {
    guard let client else { return }
    await run(.pairingCode) {
      self.pairingCode = try await client.createPairingCode(PairingCodeRequest(name: name))
    }
  }

  func dismissPairingCode() { pairingCode = nil }

  func revoke(_ device: PairedDevice) async {
    guard let client else { return }
    await run(.revoke) {
      try await client.revokeDevice(device.id)
      self.devices?.removeAll { $0.id == device.id }
    }
  }

  // MARK: - Plumbing

  @discardableResult
  private func run(_ action: Action, _ body: () async throws -> Void) async -> Bool {
    busy.insert(action)
    defer { busy.remove(action) }
    do {
      try await body()
      errors[action] = nil
      if action == .load { isUnsupported = false }
      return true
    } catch {
      if case DaemonClientError.cancelled = error { return false }
      if action == .load, (error as? DaemonClientError)?.httpStatus == 404 { isUnsupported = true }
      errors[action] = RemoteSettingsMessages.message(for: error, action: action)
      return false
    }
  }

  private nonisolated static func optional<T: Sendable>(
    _ body: @Sendable () async throws -> T
  ) async -> T? {
    try? await body()
  }
}

/// Clear, inline wording for what the daemon answered, by error code.
enum RemoteSettingsMessages {
  static func message(for error: Error, action: RemoteSettingsStore.Action) -> String {
    guard let error = error as? DaemonClientError else { return error.localizedDescription }
    let said = error.daemonMessage
    switch error {
    case .pairingRejected:
      return action == .pairMachine
        ? "The always-on machine refused that code: it's wrong, expired or already used. Get a new one there."
        : "That code is wrong, expired or already used."
    case .unauthorized:
      return "The daemon rejected this app's token."
    case .unreachable:
      return "Can't reach the daemon."
    case .rateLimited(let retryAfter, _):
      if action == .pairingCode {
        return
          "Too many pairing codes are waiting. Use one, or wait a few minutes for them to expire."
      }
      guard let retryAfter else { return "Too many attempts. Wait a minute, then try again." }
      return retryAfter == 1
        ? "Too many attempts. Try again in a second."
        : "Too many attempts. Try again in \(retryAfter) seconds."
    default:
      break
    }
    switch error.apiErrorCode {
    case .lockedByEnv?:
      return said ?? "An environment variable sets this. Change it there."
    case .machineUnreachable?:
      return said
        ?? "The always-on machine didn't answer. Is it running, and on the same private network?"
    case .invalidRequest?, .invalidJSON?:
      return said.map(cleanValidation) ?? "The daemon didn't accept that."
    case .notFound?:
      return action == .revoke
        ? "That device isn't paired anymore." : "This daemon doesn't support this yet. Update it."
    default:
      return said ?? error.localizedDescription
    }
  }

  /// The daemon's validation report (`✖ must use https…\n  → at url`, one pair per problem) as
  /// `url: must use https…`, problems separated by semicolons.
  static func cleanValidation(_ message: String) -> String {
    ApiErrorBody(error: .invalidRequest, message: message).problems.map(\.description)
      .joined(separator: "; ")
  }
}

extension DaemonClientError {
  /// The daemon's own message, when it sent one.
  var daemonMessage: String? {
    switch self {
    case .http(_, let body), .rateLimited(_, let body):
      body?.message.flatMap { $0.isEmpty ? nil : $0 }
    case .pairingRejected(let message): message
    default: nil
    }
  }
}
