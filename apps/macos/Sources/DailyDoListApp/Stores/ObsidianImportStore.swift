import DailyDoListClient
import DailyDoListModels
import Foundation
import Observation

/// Settings → General → Vault: the vault this daemon opens, where it was imported from, and the
/// import from Obsidian (the report, the job and its progress from `import.progress` events, and
/// "Update from Obsidian"). Switching to the new vault is ``AppModel/switchVault(to:)``: it
/// involves the supervisor and the app's preferences. Every action keeps its own inline error.
@MainActor
@Observable
final class ObsidianImportStore {
  /// An action whose failure shows next to its control.
  enum Action: Hashable {
    case load, preview, start, cancel, update, switchVault
  }

  private(set) var vault: DeviceVaultResponse?
  /// Where this vault was imported from (nil: it wasn't, or not known yet).
  private(set) var imported: ObsidianImportOrigin?
  /// The running import or update, or the last one since the daemon started.
  private(set) var job: ObsidianImportJob?
  private(set) var syncStatus: SyncStatusResponse?
  /// The Obsidian vault picked, and its report.
  private(set) var source: String?
  private(set) var preview: ObsidianImportPreview?
  /// The new vault's folder (starts as the report's suggestion).
  var destination = ""
  /// A finished import the user moved on from ("Start Over").
  private(set) var dismissedJobId: String?
  private(set) var busy: Set<Action> = []
  private(set) var errors: [Action: String] = [:]
  /// This client is a paired device: only the Mac running the daemon may import or switch.
  private(set) var isForbidden = false
  /// The daemon predates these routes (404).
  private(set) var isUnsupported = false

  @ObservationIgnored var client: DaemonClient?

  static let pairedDeviceReason =
    "Only the Mac that runs Daily Do List can import vaults or switch them, not a paired device."

  func isBusy(_ action: Action) -> Bool { busy.contains(action) }
  func error(_ action: Action) -> String? { errors[action] }
  func dismissError(_ action: Action) { errors[action] = nil }

  /// The import the flow shows: running, or finished and not moved on from.
  var currentImport: ObsidianImportJob? {
    guard let job, job.kind == .import, job.id != dismissedJobId else { return nil }
    return job
  }

  /// The update from Obsidian the Vault section shows.
  var currentUpdate: ObsidianImportJob? {
    guard let job, job.kind == .update else { return nil }
    return job
  }

  var isRunning: Bool { job?.state == .running }

  /// The vault syncs: switching now would sync the old notes into the new vault.
  var syncs: Bool { (syncStatus?.target ?? .none) != .none }

  /// Forgets everything (the client went away).
  func reset() {
    vault = nil
    imported = nil
    job = nil
    syncStatus = nil
    source = nil
    preview = nil
    destination = ""
    dismissedJobId = nil
    busy = []
    errors = [:]
    isForbidden = false
    isUnsupported = false
  }

  // MARK: - Loading

  /// The vault, the job and where the vault came from, and the sync status.
  func load() async {
    guard let client else { return }
    await run(.load) {
      async let vault = client.deviceVault()
      async let status = client.obsidianImportStatus()
      async let sync = Self.optional { try await client.syncStatus() }
      self.vault = try await vault
      self.applyStatus(try await status)
      self.syncStatus = await sync
    }
  }

  /// An `import.progress` event, or a job a call answered with. A late "running" snapshot of a
  /// job that already ended doesn't bring it back.
  func apply(_ next: ObsidianImportJob) {
    if let job, job.id == next.id, job.state != .running, next.state == .running { return }
    let finished = next.state != .running && job?.state == .running
    job = next
    if finished, next.kind == .update, next.state == .done {
      Task { await self.refreshStatus() }
    }
  }

  // MARK: - The import

  /// Reads the report of `source` (an absolute path or `~/…`); writes nothing.
  @discardableResult
  func readReport(source: String) async -> Bool {
    guard let client else { return false }
    self.source = source
    preview = nil
    errors[.start] = nil
    return await run(.preview) {
      let report = try await client.previewObsidianImport(
        ObsidianImportPreviewRequest(source: source))
      self.preview = report
      self.destination = report.defaultDestination
    }
  }

  @discardableResult
  func startImport() async -> Bool {
    guard let client, let preview else { return false }
    let target = destination.trimmingCharacters(in: .whitespaces)
    let ok = await run(.start) {
      self.apply(
        try await client.startObsidianImport(
          ObsidianImportRequest(source: preview.source, destination: target.isEmpty ? nil : target))
      )
    }
    if !ok, errors[.start] != nil { await refreshStatus() }
    return ok
  }

  @discardableResult
  func cancel() async -> Bool {
    guard let client else { return false }
    let ok = await run(.cancel) { self.apply(try await client.cancelObsidianImport()) }
    if !ok { await refreshStatus() }
    return ok
  }

  /// Moves on from a finished import (the report stays, to import again).
  func startOver() {
    dismissedJobId = currentImport?.id
    errors[.start] = nil
    errors[.switchVault] = nil
  }

  /// Picks another Obsidian vault.
  func clearSource() {
    source = nil
    preview = nil
    errors[.preview] = nil
    errors[.start] = nil
  }

  // MARK: - Update from Obsidian

  @discardableResult
  func update() async -> Bool {
    guard let client else { return false }
    let ok = await run(.update) { self.apply(try await client.updateFromObsidian()) }
    if !ok { await refreshStatus() }
    return ok
  }

  // MARK: - Switching (driven by AppModel)

  func beginSwitch() {
    busy.insert(.switchVault)
    errors[.switchVault] = nil
  }

  func endSwitch(error: String?) {
    busy.remove(.switchVault)
    errors[.switchVault] = error
  }

  // MARK: - Helpers

  /// The job and the vault's origin again, quietly.
  func refreshStatus() async {
    guard let client, let status = try? await client.obsidianImportStatus() else { return }
    applyStatus(status)
    syncStatus = (try? await client.syncStatus()) ?? syncStatus
  }

  private func applyStatus(_ status: ObsidianImportStatusResponse) {
    if let next = status.job { apply(next) } else { job = nil }
    imported = status.imported
  }

  @discardableResult
  private func run(_ action: Action, _ body: @MainActor () async throws -> Void) async -> Bool {
    busy.insert(action)
    errors[action] = nil
    defer { busy.remove(action) }
    do {
      try await body()
      if action == .load {
        isForbidden = false
        isUnsupported = false
      }
      return true
    } catch let error as DaemonClientError {
      if error.apiErrorCode == .forbiddenDevice {
        isForbidden = true
        errors[action] = Self.pairedDeviceReason
      } else if action == .load, error.httpStatus == 404 {
        isUnsupported = true
      } else {
        errors[action] = Self.message(for: error)
      }
      return false
    } catch {
      errors[action] = error.localizedDescription
      return false
    }
  }

  static func message(for error: DaemonClientError) -> String {
    if case .unreachable = error {
      return "Daily Do List didn't answer. Check that it's running, then try again."
    }
    return error.errorDescription ?? "Something went wrong."
  }

  private static func optional<T: Sendable>(_ body: @Sendable () async throws -> T) async -> T? {
    try? await body()
  }
}
