import DailyDoListMobileIntegration
import DailyDoListMobileKit
import Foundation

extension PhoneAppModel {
  /// Startup and every App Intent share this gate before any profile or workspace store opens.
  func prepareStorage() async throws {
    guard let protection else { throw MobileStorageProtectionError.unsupportedState }
    try await protection.prepare()
  }

  /// Background work follows the protection actually in force, never a saved preference.
  var integrationPreferences: PhoneNotificationPreferences {
    var value = notificationPreferences
    value.requiresUnlockedStorage = protection?.permitsBackgroundRefresh != true
    return value
  }

  /// No workspace may open or regain authority while a protection change owns the storage.
  var storageClosed: Bool { storageSuspended && protection?.ready != true }

  func requireOpenStorage() throws {
    guard !storageClosed else { throw MobileStorageProtectionError.busy }
  }

  /// A live protection change needs every SQLite handle closed. Live work that cannot be saved
  /// keeps the workspace exactly as it is; a handle that outlives teardown leaves a retry state.
  func quiesceStorage() async throws {
    // Teardown returns first: its local references would otherwise keep every workspace open.
    try await releaseStorageUsers()
    try await drainStorage()
  }

  private func releaseStorageUsers() async throws {
    storageSuspended = true
    let open = Array(workspaces.values)
    do {
      for workspace in open { try await workspace.prepareRecoveryExport() }
    } catch {
      refuseProtectionChange()
      throw MobileStorageProtectionError.busy
    }
    selection &+= 1
    var running = notificationWork()
    for workspace in open { running += workspace.stopForStorageChange() }
    await connection.stop()
    await backgroundRefresh?.cancelAndWait()
    for task in running { await task.value }
    do {
      for workspace in open {
        await workspace.suspend()
        try await workspace.prepareRecoveryExport()
      }
    } catch {
      refuseProtectionChange()
      await connection.reconnect()
      throw MobileStorageProtectionError.busy
    }
    releaseWorkspaces()
    visibleThreads.removeAll()
    visibleRoutines.removeAll()
  }

  func resumeStorage() async {
    storageSuspended = false
    guard restored else {
      await restore()
      return
    }
    try? await backgroundRefresh?.schedule()
    guard workspace == nil, let id = connection.selected?.id ?? savedSelection,
      let profile = connection.profiles.first(where: { $0.id == id })
    else { return }
    await select(profile)
  }

  var savedSelection: UUID? {
    defaults.string(forKey: "selectedConnection").flatMap(UUID.init(uuidString:))
  }

  private func refuseProtectionChange() {
    storageSuspended = false
    workspace?.error =
      "Storage protection was not changed because some changes could not be saved on this iPhone. Resolve the save error, then retry."
  }

  private func notificationWork() -> [Task<Void, Never>] {
    let running = [notificationRefreshTask].compactMap { $0 } + notificationReceipts.values
    notificationRefreshTask = nil
    for task in running { task.cancel() }
    return running
  }

  /// SwiftUI releases removed workspace views on a later update than the one clearing the model.
  private func drainStorage() async throws {
    guard let storage = protection?.migration.storage else { return }
    var pauses = 0
    while storage.openAccessCount > 0, pauses < 40 {
      pauses += 1
      try await storageDrainPause()
    }
    guard storage.openAccessCount == 0 else { throw MobileStorageProtectionError.busy }
  }
}
