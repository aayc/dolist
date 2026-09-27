import DailyDoListClient
import DailyDoListMobileKit
import Foundation
import Observation
import UIKit

@MainActor @Observable
final class PhoneAppModel {
  let connection: MobileConnection
  let pairing: PairingService
  private(set) var workspace: PhoneWorkspace?
  var error: String?
  @ObservationIgnored private let root: URL
  @ObservationIgnored private var selection: UInt64 = 0
  @ObservationIgnored private var started = false
  @ObservationIgnored private var workspaces: [UUID: PhoneWorkspace] = [:]

  init() {
    root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("DailyDoList", isDirectory: true)
    let profiles = FileConnectionProfileStore(directory: root)
    let credentials = KeychainConnectionCredentials()
    connection = MobileConnection(profiles: profiles, credentials: credentials) {
      origin, token, workspace in
      ConnectionChannel.native(origin: origin, token: token, expectedWorkspaceID: workspace)
    }
    pairing = PairingService(profiles: profiles, credentials: credentials) { origin, request in
      let channel = ConnectionChannel.native(origin: origin, token: "", expectedWorkspaceID: nil)
      defer { channel.close() }
      return try await channel.client.pair(request)
    }
    connection.onVerified = { [weak self] profile, client in
      guard let self, let client = client as? HTTPDaemonClient else { return }
      do {
        let workspace = try await self.workspace(for: profile)
        guard self.connection.selected?.id == profile.id, self.connection.actionsEnabled else {
          return
        }
        self.workspace = workspace
        await workspace.connect(client, serverVersion: self.connection.health?.version ?? "")
      } catch { self.error = error.localizedDescription }
    }
    connection.onInvalidated = { [weak self] profile in
      guard let id = profile?.id else { return }
      await self?.workspaces[id]?.suspend()
    }
    connection.onItem = { [weak self] item in
      guard let self, self.workspace?.profile.id == self.connection.selected?.id else { return }
      self.workspace?.receive(item)
    }
  }

  func start() async {
    guard !started else { return }
    started = true
    await connection.loadProfiles()
    if let saved = UserDefaults.standard.string(forKey: "selectedConnection"),
      let profile = connection.profiles.first(where: { $0.id.uuidString == saved })
    {
      await select(profile)
    }
  }

  func select(_ profile: ConnectionProfile) async {
    selection &+= 1
    let epoch = selection
    await connection.stop()
    guard epoch == selection else { return }
    await workspace?.checkpointAll()
    guard epoch == selection else { return }
    UserDefaults.standard.set(profile.id.uuidString, forKey: "selectedConnection")
    if profile.workspaceID != nil, profile.hostID != nil {
      do {
        let next = try await workspace(for: profile)
        guard epoch == selection else { return }
        workspace = next
        await next.hydrate()
        guard epoch == selection else { return }
      } catch { self.error = error.localizedDescription }
    } else {
      workspace = nil
    }
    guard epoch == selection else { return }
    await connection.select(profile)
  }

  func paired(_ profile: ConnectionProfile) async {
    await connection.loadProfiles()
    await select(profile)
  }

  func setActive(_ active: Bool) async {
    guard !active else {
      await connection.setActive(true)
      return
    }
    // iOS can suspend us soon after this callback. Only bounded local checkpointing uses the
    // background allowance; network authority is revoked by setActive before it awaits cleanup.
    let lease = LocalCheckpointAllowance()
    await connection.setActive(false)
    await workspace?.checkpointAll(finishComposition: true)
    await workspace?.composerDrafts.flush()
    lease.end()
  }

  private func workspace(for profile: ConnectionProfile) async throws -> PhoneWorkspace {
    if let existing = workspaces[profile.id] { return existing }
    guard let workspaceID = profile.workspaceID, let hostID = profile.hostID else {
      throw WorkspaceRepositoryError.invalidScope
    }
    let scope = WorkspaceScope(
      profileID: profile.id, workspaceID: workspaceID, hostID: hostID, origin: profile.origin)
    let root = root.appendingPathComponent("workspaces")
    let (repository, drawings, cache, captures, structural, recovery) = try await Task.detached {
      (
        try WorkspaceRepository(rootDirectory: root, scope: scope),
        try DrawingRepository(rootDirectory: root, scope: scope),
        try WorkspaceCache(rootDirectory: root, scope: scope),
        try CaptureOutbox(rootDirectory: root, scope: scope),
        try WorkspaceStructuralCoordinator(rootDirectory: root, scope: scope),
        try WorkspaceRecovery(rootDirectory: root, scope: scope)
      )
    }.value
    if let existing = workspaces[profile.id] { return existing }
    let created = PhoneWorkspace(
      rootDirectory: root, structural: structural, recovery: recovery,
      profile: profile, repository: repository, drawingRepository: drawings, cache: cache,
      captureOutbox: captures)
    workspaces[profile.id] = created
    return created
  }
}

@MainActor
private final class LocalCheckpointAllowance {
  private var identifier: UIBackgroundTaskIdentifier = .invalid
  init() {
    identifier = UIApplication.shared.beginBackgroundTask(withName: "Save local drafts") {
      [weak self] in
      Task { @MainActor in self?.end() }
    }
  }
  func end() {
    guard identifier != .invalid else { return }
    UIApplication.shared.endBackgroundTask(identifier)
    identifier = .invalid
  }
}
