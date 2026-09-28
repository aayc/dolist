import DailyDoListClient
import DailyDoListMobileIntegration
import DailyDoListMobileKit
import Foundation
import Observation
import UIKit

@MainActor @Observable
final class PhoneAppModel {
  let connection: MobileConnection
  let pairing: PairingService
  /// Nil only when the saved protection policy cannot be read; storage then stays closed.
  let protection: PhoneStorageProtectionController?
  let protectionSetupError: String?
  let exportStaging: RecoveryExportStaging
  private(set) var workspace: PhoneWorkspace?
  private(set) var restored = false
  var error: String?
  var notificationError: String?
  var notificationPreferences = PhoneNotificationPreferences()
  var visibleThreads: Set<String> = []
  var visibleRoutines: Set<String> = []
  var appActive = true
  @ObservationIgnored var integrations: PhoneIntegrations?
  @ObservationIgnored var notificationCenter: SystemPhoneNotificationCenter?
  @ObservationIgnored var backgroundRefresh: PhoneBackgroundRefresh?
  @ObservationIgnored var notificationRefreshTask: Task<Void, Never>?
  @ObservationIgnored var notificationReceipts: [UUID: Task<Void, Never>] = [:]
  @ObservationIgnored var storageSuspended = false
  @ObservationIgnored var storageDrainPause: @MainActor () async throws -> Void = {
    try await Task.sleep(for: .milliseconds(50))
  }
  @ObservationIgnored private let privacyShield = PhonePrivacyShield()
  @ObservationIgnored private let credentials: KeychainConnectionCredentials
  @ObservationIgnored private let root: URL
  @ObservationIgnored let defaults: UserDefaults
  @ObservationIgnored private let workspaceFactory:
    (@MainActor (ConnectionProfile) async throws -> PhoneWorkspace)?
  @ObservationIgnored var selection: UInt64 = 0
  @ObservationIgnored private var started = false
  @ObservationIgnored var workspaces: [UUID: PhoneWorkspace] = [:]

  init(
    rootDirectory: URL? = nil, defaults: UserDefaults = .standard,
    credentials: KeychainConnectionCredentials = KeychainConnectionCredentials(),
    workspaceFactory: (@MainActor (ConnectionProfile) async throws -> PhoneWorkspace)? = nil,
    exportStaging: RecoveryExportStaging = .app,
    installIntegrations: Bool = true
  ) {
    root =
      rootDirectory
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("DailyDoList", isDirectory: true)
    self.defaults = defaults
    self.workspaceFactory = workspaceFactory
    self.credentials = credentials
    self.exportStaging = exportStaging
    // Registers the root as blocked before any profile or workspace store can open under it.
    do {
      let legacy = defaults.data(forKey: "phoneNotifications").flatMap {
        try? JSONDecoder().decode(PhoneNotificationPreferences.self, from: $0)
      }
      let migration = try PhoneProtectionMigration(
        rootDirectory: root, credentials: credentials,
        initialMode: legacy?.requiresUnlockedStorage == true ? .whileUnlocked : .afterFirstUnlock)
      protection = PhoneStorageProtectionController(
        migration: migration, quiesce: {}, resume: {})
      protectionSetupError = nil
    } catch {
      protection = nil
      protectionSetupError =
        (error as? MobileStorageProtectionError ?? .unsupportedState).localizedDescription
    }
    let profiles = FileConnectionProfileStore(directory: root)
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
        guard self.connection.selected?.id == profile.id, self.connection.actionsEnabled,
          !self.storageClosed
        else { return }
        self.workspace = workspace
        await workspace.connect(client, serverVersion: self.connection.health?.version ?? "")
        self.scheduleNotificationRefresh()
      } catch {
        if !self.storageClosed { self.error = error.localizedDescription }
      }
    }
    connection.onInvalidated = { [weak self] profile in
      guard let id = profile?.id else { return }
      await self?.workspaces[id]?.suspend()
    }
    connection.onItem = { [weak self] item in
      guard let self, self.workspace?.profile.id == self.connection.selected?.id else { return }
      self.workspace?.receive(item)
      self.receiveNotificationEvent(item)
    }
    if installIntegrations {
      installPhoneIntegrations(profiles: profiles, credentials: credentials, rootDirectory: root)
    }
    protection?.quiesce = { [weak self] in try await self?.quiesceStorage() }
    protection?.resume = { [weak self] in await self?.resumeStorage() }
  }

  func start() async {
    guard !started else { return }
    started = true
    // A failure leaves the controller's retry state; its resume finishes this restoration.
    do { try await prepareStorage() } catch { return }
    await restore()
  }

  func restore() async {
    await connection.loadProfiles()
    // Unreadable (for example locked) profiles are not missing ones; the next activation retries.
    if case .failed = connection.phase { return }
    restored = true
    for profile in connection.profiles {
      do { _ = try await finishRetiredConnection(profile) } catch {
        self.error = error.localizedDescription
      }
    }
    do { try await exportStaging.removeAbandoned() } catch {
      self.error = error.localizedDescription
    }
    if let saved = defaults.string(forKey: "selectedConnection"),
      let profile = connection.profiles.first(where: { $0.id.uuidString == saved })
    {
      await select(profile)
    }
  }

  func select(_ profile: ConnectionProfile) async {
    selection &+= 1
    let epoch = selection
    do { if try await finishRetiredConnection(profile) { return } } catch {
      if epoch == selection { self.error = error.localizedDescription }
      return
    }
    guard epoch == selection else { return }
    await connection.stop()
    guard epoch == selection else { return }
    await workspace?.checkpointAll()
    guard epoch == selection else { return }
    // Construction can fail for a locked, corrupted or future offline index. Never expose the
    // previous editor under a newly selected profile or reroute Siri before this succeeds.
    workspace = nil
    if profile.workspaceID != nil, profile.hostID != nil {
      do {
        let next = try await workspace(for: profile)
        guard epoch == selection else { return }
        await next.hydrate()
        guard epoch == selection else { return }
        workspace = next
      } catch {
        if epoch == selection { self.error = error.localizedDescription }
        return
      }
    }
    guard epoch == selection else { return }
    defaults.set(profile.id.uuidString, forKey: "selectedConnection")
    await connection.select(profile)
  }

  func forget(_ scope: WorkspaceScope, proof: VerifiedRecoveryExport?) async throws {
    guard let target = workspaces[scope.profileID], target.repository.scope == scope,
      connection.selected?.id == scope.profileID
    else {
      throw WorkspaceRepositoryError.workspaceMismatch
    }
    selection &+= 1
    let epoch = selection
    await connection.stop()
    try await target.prepareRecoveryExport()
    guard epoch == selection, connection.selected?.id == scope.profileID else {
      throw WorkspaceRepositoryError.connectionChanged
    }
    if let proof {
      try await target.recovery.forget(afterExport: proof)
    } else {
      try await target.recovery.forget()
    }
    // Profile identities cannot change after adoption (FileConnectionProfileStore); one
    // profile therefore owns exactly this protected namespace, including after re-pairing.
    workspaces[scope.profileID] = nil
    if workspace?.profile.id == scope.profileID { workspace = nil }
    do { _ = try await finishRetiredConnection(target.profile) } catch {
      self.error = error.localizedDescription
      throw error
    }
  }

  /// A retired namespace is the durable record that the user already completed Forget. Finish
  /// only that exact profile's remaining cleanup. Every step is idempotent, and the profile goes
  /// last: it is what `start()` enumerates to resume cleanup after an interruption.
  private func finishRetiredConnection(_ profile: ConnectionProfile) async throws -> Bool {
    guard let workspaceID = profile.workspaceID, let hostID = profile.hostID else { return false }
    let scope = WorkspaceScope(
      profileID: profile.id, workspaceID: workspaceID,
      hostID: hostID, origin: profile.origin)
    let recovery = try WorkspaceRecovery(
      rootDirectory: root.appendingPathComponent("workspaces"), scope: scope)
    guard try await recovery.isRetired() else { return false }
    try await recovery.forget()
    await integrations?.clearNotifications(for: scope)
    try await exportStaging.removeAbandoned(for: profile.id)
    workspaces[profile.id] = nil
    if workspace?.profile.id == profile.id { workspace = nil }
    if defaults.string(forKey: "selectedConnection") == profile.id.uuidString {
      defaults.removeObject(forKey: "selectedConnection")
    }
    try await connection.removeRetiredProfile(profile.id)
    return true
  }

  func paired(_ profile: ConnectionProfile) async {
    await connection.loadProfiles()
    await select(profile)
  }

  func setActive(_ active: Bool) async {
    appActive = active
    guard !active else {
      await connection.setActive(true)
      if !restored, case .failed = connection.phase, protection?.ready == true { await restore() }
      scheduleNotificationRefresh()
      return
    }
    // iOS can suspend us soon after this callback. Only bounded local checkpointing uses the
    // background allowance; network authority is revoked by setActive before it awaits cleanup.
    let lease = LocalCheckpointAllowance()
    await connection.setActive(false)
    await workspace?.checkpointAll(finishComposition: true)
    await workspace?.composerDrafts.flush()
    lease.end()
    try? await backgroundRefresh?.schedule()
  }

  /// Callers first checkpoint every workspace and await its work; this drops their stores.
  func releaseWorkspaces() {
    for workspace in workspaces.values {
      workspace.offlineChannel?.close()
      workspace.offlineChannel = nil
    }
    workspaces.removeAll()
    workspace = nil
  }

  private func workspace(for profile: ConnectionProfile) async throws -> PhoneWorkspace {
    if let existing = workspaces[profile.id] { return existing }
    try requireOpenStorage()
    if let workspaceFactory {
      let created = try await workspaceFactory(profile)
      if let existing = workspaces[profile.id] { return existing }
      try requireOpenStorage()
      workspaces[profile.id] = created
      return created
    }
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
    try requireOpenStorage()
    let created = try PhoneWorkspace(
      rootDirectory: root, structural: structural, recovery: recovery,
      profile: profile, repository: repository, drawingRepository: drawings, cache: cache,
      captureOutbox: captures)
    workspaces[profile.id] = created
    // Construct the offline store without opening a socket or granting mutation authority.
    // Missing credentials still permit reading saved content; pairing is handled separately.
    let token = (try? await credentials.token(for: profile.id)) ?? ""
    let channel = ConnectionChannel.native(
      origin: profile.origin, token: token, expectedWorkspaceID: scope.workspaceID)
    created.offlineChannel = channel
    if let client = channel.client as? HTTPDaemonClient { try await created.prepareAgent(client) }
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
