import Foundation

/// One screen's recovery export for the Files picker. Cancelling, verifying the copy, exporting
/// again and leaving the screen all discard the staged originals; the user's copy in Files and
/// its proof stay intact, since verification reads only that copy.
public actor RecoveryExportSession {
  private let recovery: WorkspaceRecovery
  private let staging: RecoveryExportStaging
  private var stage: RecoveryExportStage?

  public init(recovery: WorkspaceRecovery, staging: RecoveryExportStaging) {
    self.recovery = recovery
    self.staging = staging
  }

  /// The owner checkpoints live editors first. Replaces any earlier staged export.
  public func export() async throws -> RecoveryExportResult {
    try await discard()
    let stage = try await staging.begin(for: recovery.scope)
    do {
      let exported = try await recovery.export(into: stage)
      self.stage = stage
      return exported
    } catch {
      // A failed removal leaves an unleased container for the next cleanup.
      try? await staging.remove(stage)
      throw error
    }
  }

  /// A failed removal keeps the lease, so calling again retries.
  public func discard() async throws {
    guard let stage else { return }
    try await staging.remove(stage)
    self.stage = nil
  }
}
