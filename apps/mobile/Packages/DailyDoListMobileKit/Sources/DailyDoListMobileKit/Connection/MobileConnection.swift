import DailyDoListClient
import DailyDoListModels
import Foundation
import Observation

public struct ConnectionChannel: Sendable {
  public let client: any DaemonClient
  public let close: @Sendable () -> Void
  public init(client: any DaemonClient, close: @escaping @Sendable () -> Void = {}) {
    self.client = client
    self.close = close
  }
}

/// Foreground connection authority. Cached documents outlive this object; a network failure or
/// rejected credential never clears them. Every asynchronous result is bound to its generation.
@MainActor @Observable
public final class MobileConnection {
  public enum Phase: Equatable, Sendable {
    case idle, connecting, online, offline, needsPairing, revoked, changedWorkspace
    case unsupported
    case failed(String)
  }
  public typealias Factory = @Sendable (ConnectionOrigin, String, String?) -> ConnectionChannel
  public private(set) var profiles: [ConnectionProfile] = []
  public private(set) var selected: ConnectionProfile?
  public private(set) var phase: Phase = .idle
  public private(set) var health: HealthResponse?
  public private(set) var client: (any DaemonClient)?
  public var onItem: ((DaemonStreamItem) -> Void)?
  public var onVerified: ((ConnectionProfile, any DaemonClient) async -> Void)?
  public var onInvalidated: ((ConnectionProfile?) async -> Void)?
  @ObservationIgnored private let profileStore: any ConnectionProfileStore
  @ObservationIgnored private let credentials: any ConnectionCredentials
  @ObservationIgnored private let factory: Factory
  @ObservationIgnored private var channel: ConnectionChannel?
  @ObservationIgnored private var eventTask: Task<Void, Never>?
  @ObservationIgnored private var verificationTask: Task<Void, Never>?
  @ObservationIgnored private var generation: UInt64 = 0
  @ObservationIgnored private var active = true

  public init(
    profiles: any ConnectionProfileStore, credentials: any ConnectionCredentials,
    factory: @escaping Factory
  ) {
    profileStore = profiles
    self.credentials = credentials
    self.factory = factory
  }

  public var actionsEnabled: Bool { phase == .online }

  public func loadProfiles() async {
    do { profiles = try await profileStore.profiles() } catch {
      phase = .failed(error.localizedDescription)
    }
  }

  public func select(_ profile: ConnectionProfile) async {
    let epoch = await stop()
    guard epoch == generation else { return }
    selected = profile
    health = nil
    guard active else {
      phase = .offline
      return
    }
    await open(profile)
  }

  public func setActive(_ value: Bool) async {
    guard active != value else { return }
    active = value
    if value, let selected {
      await open(selected)
    } else if !value {
      let epoch = await stop()
      guard epoch == generation else { return }
      phase = selected == nil ? .idle : .offline
    }
  }

  public func reconnect() async {
    guard let selected, active else { return }
    let epoch = await stop()
    guard epoch == generation, active else { return }
    await open(selected)
  }

  /// Stop streaming/pinging and revoke authority immediately, before awaiting transport cleanup.
  @discardableResult
  public func stop() async -> UInt64 {
    generation &+= 1
    let epoch = generation
    phase = .offline
    eventTask?.cancel()
    verificationTask?.cancel()
    eventTask = nil
    verificationTask = nil
    let previous = channel
    let profile = selected
    channel = nil
    client = nil
    previous?.close()
    await previous?.client.disconnect()
    await onInvalidated?(profile)
    return epoch
  }

  private func open(_ profile: ConnectionProfile) async {
    generation &+= 1
    let epoch = generation
    phase = .connecting
    do {
      guard let token = try await credentials.token(for: profile.id) else {
        guard epoch == generation else { return }
        phase = .needsPairing
        return
      }
      guard epoch == generation, active else { return }
      let bootstrap = factory(profile.origin, token, nil)
      defer { bootstrap.close() }
      let response = try await bootstrap.client.health()
      guard epoch == generation, active else { return }
      guard DaemonProtocol.isCompatible(apiVersion: response.apiVersion),
        response.capabilities?.contains("workspace-identity-v1") == true,
        let workspace = response.workspaceId, !workspace.isEmpty,
        let host = response.hostId, !host.isEmpty
      else {
        phase = .unsupported
        return
      }
      guard profile.workspaceID == nil || profile.workspaceID == workspace,
        profile.hostID == nil || profile.hostID == host
      else {
        phase = .changedWorkspace
        return
      }
      var verified = profile
      verified.workspaceID = workspace
      verified.hostID = host
      verified.vaultName = response.vaultName
      try await profileStore.save(verified)
      guard epoch == generation, active else { return }
      selected = verified
      profiles = try await profileStore.profiles()
      guard epoch == generation, active else { return }
      health = response
      let connected = factory(profile.origin, token, workspace)
      channel = connected
      client = connected.client
      let stream = connected.client.events()
      eventTask = Task { [weak self] in
        for await item in stream {
          guard let self, !Task.isCancelled, epoch == self.generation else { break }
          self.receive(item, profile: verified, channel: connected, epoch: epoch)
        }
      }
      await connected.client.connect()
    } catch {
      guard epoch == generation else { return }
      phase = Self.failure(error)
    }
  }

  private func receive(
    _ item: DaemonStreamItem, profile: ConnectionProfile, channel: ConnectionChannel, epoch: UInt64
  ) {
    switch item {
    case .state(.connected), .resync:
      phase = .connecting
      verifyLive(profile, channel: channel, epoch: epoch, connected: true)
    case .state(.reconnecting):
      phase = .offline
      verifyLive(profile, channel: channel, epoch: epoch, connected: false)
    case .state(.incompatible): phase = .unsupported
    case .state(.disconnected), .state(.idle): phase = .offline
    case .state(.connecting): phase = .connecting
    case .event: break
    }
    onItem?(item)
  }

  private func verifyLive(
    _ profile: ConnectionProfile, channel: ConnectionChannel, epoch: UInt64, connected: Bool
  ) {
    verificationTask?.cancel()
    verificationTask = Task { [weak self] in
      do {
        let health = try await channel.client.health()
        guard let self, !Task.isCancelled, self.generation == epoch else { return }
        guard health.workspaceId == profile.workspaceID, health.hostId == profile.hostID else {
          let stopped = await self.stop()
          guard self.generation == stopped else { return }
          self.phase = .changedWorkspace
          return
        }
        self.health = health
        if connected {
          self.phase = .online
          await self.onVerified?(profile, channel.client)
        }
      } catch {
        guard let self, !Task.isCancelled, self.generation == epoch else { return }
        let failure = Self.failure(error)
        if failure == .revoked || failure == .changedWorkspace || failure == .unsupported {
          let stopped = await self.stop()
          guard self.generation == stopped else { return }
        }
        self.phase = failure
      }
    }
  }

  private static func failure(_ error: any Error) -> Phase {
    guard let daemon = error as? DaemonClientError else {
      return .failed(error.localizedDescription)
    }
    switch daemon {
    case .unauthorized: return .revoked
    case .incompatibleApiVersion: return .unsupported
    case .http(status: 412, body: _): return .changedWorkspace
    case .unreachable, .cancelled: return .offline
    default: return .failed(daemon.localizedDescription)
    }
  }
}
