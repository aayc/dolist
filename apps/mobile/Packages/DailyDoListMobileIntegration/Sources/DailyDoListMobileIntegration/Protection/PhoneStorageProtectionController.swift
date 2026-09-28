import DailyDoListMobileKit
import Foundation
import Observation

/// Native preferences state. Quiesce must checkpoint, stop/cancel work and release every workspace
/// and cache handle; resume recreates them after a successful runtime settings change.
@MainActor @Observable
public final class PhoneStorageProtectionController {
  public private(set) var state: PhoneProtectionState
  public private(set) var busy = false
  public private(set) var ready = false
  public private(set) var error: String?
  public var quiesce: @MainActor @Sendable () async throws -> Void
  public var resume: @MainActor @Sendable () async throws -> Void
  @ObservationIgnored public let migration: PhoneProtectionMigration
  @ObservationIgnored private var requiresQuiescence = false
  #if os(iOS)
    @ObservationIgnored private let availability: PhoneProtectionAvailability
  #endif

  public init(
    migration: PhoneProtectionMigration,
    quiesce: @escaping @MainActor @Sendable () async throws -> Void,
    resume: @escaping @MainActor @Sendable () async throws -> Void
  ) {
    self.migration = migration
    state = migration.initialState
    self.quiesce = quiesce
    self.resume = resume
    #if os(iOS)
      availability = PhoneProtectionAvailability(storage: migration.storage)
    #endif
  }

  public var permitsBackgroundRefresh: Bool {
    ready && !busy && state.permitsBackgroundRefresh
  }

  /// Startup and foreground App Intents await this before creating any profile/workspace stores.
  /// Concurrent invocations share the migration's single preparation operation.
  public func prepare() async throws {
    // Live migration is draining these callers; awaiting that same migration would deadlock.
    guard !busy || !requiresQuiescence else { throw MobileStorageProtectionError.busy }
    guard !ready else { return }
    refreshAvailability()
    busy = true
    error = nil
    do {
      // Cold storage starts blocked, before any workspace can open. Cancelling the background
      // task that is itself awaiting cold preparation would otherwise wait on that same task.
      let quiesce = quiesce
      let requiresQuiescence = requiresQuiescence
      try await migration.prepare { if requiresQuiescence { try await quiesce() } }
      state = await migration.snapshot()
      self.requiresQuiescence = false
      ready = true
      busy = false
    } catch {
      await failed(error)
      throw error
    }
  }

  public func change(to mode: MobileStorageProtectionMode) async {
    guard !busy else { return }
    refreshAvailability()
    ready = false
    busy = true
    requiresQuiescence = true
    error = nil
    do {
      let quiesce = quiesce
      try await migration.change(to: mode) { try await quiesce() }
      state = await migration.snapshot()
      requiresQuiescence = false
      ready = true
      busy = false
      try await resume()
    } catch { await failed(error) }
  }

  public func retry() async {
    guard !busy else { return }
    do {
      try await prepare()
      try await resume()
    } catch { await failed(error) }
  }

  /// An application usually builds this controller before it finishes launching, when
  /// `isProtectedDataAvailable` still reads false and no availability notification follows.
  private func refreshAvailability() {
    #if os(iOS)
      availability.refresh()
    #endif
  }

  private func failed(_ failure: Error) async {
    state = await migration.snapshot()
    ready = await migration.isPrepared()
    busy = false
    error =
      (failure as? MobileStorageProtectionError)?.localizedDescription
      ?? "Storage protection could not be changed. Your notes and credentials were kept. Unlock this iPhone and retry."
  }
}

#if os(iOS)
  import UIKit

  @MainActor private final class PhoneProtectionAvailability: NSObject {
    let storage: MobileStorageProtection
    init(storage: MobileStorageProtection) {
      self.storage = storage
      super.init()
      refresh()
      NotificationCenter.default.addObserver(
        self, selector: #selector(unavailable),
        name: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil)
      NotificationCenter.default.addObserver(
        self, selector: #selector(available),
        name: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil)
    }
    deinit { NotificationCenter.default.removeObserver(self) }
    func refresh() {
      storage.setProtectedDataAvailable(UIApplication.shared.isProtectedDataAvailable)
    }
    @objc private func unavailable() { storage.setProtectedDataAvailable(false) }
    @objc private func available() { storage.setProtectedDataAvailable(true) }
  }
#endif
