import Foundation

public struct WorkspaceRecoverySummary: Sendable {
  public let notes: Int
  public let composers: Int
  public let captures: Int
  public let structuralOperations: Int
  public let agentOperations: Int
  public let unknownRecords: Int
  public var requiresDecision: Bool {
    notes + composers + captures + structuralOperations + agentOperations + unknownRecords > 0
  }

  init(snapshot: WorkspaceRecoverySnapshot, scope: WorkspaceScope) {
    let agent = RecoveryAgentMutations(values: snapshot.values, scope: scope)
    agentOperations = agent.operations.count
    notes = snapshot.documents.filter { $0.state != .synced || !$0.recoveryCopies.isEmpty }.count
    var composers = 0
    var captures = 0
    var structural = 0
    var unknown = 0
    for value in snapshot.values
    where value.retention == .durable && !agent.recognizedKeys.contains(value.key) {
      if value.key.hasPrefix("composer/") {
        if let text = try? JSONDecoder().decode(String.self, from: value.data) {
          composers += text.isEmpty ? 0 : 1
        } else {
          unknown += 1
        }
      } else if value.key.hasPrefix("capture/") {
        if let capture = try? JSONDecoder().decode(QueuedCapture.self, from: value.data) {
          captures += capture.state.blocksNoteWrites ? 1 : 0
        } else {
          unknown += 1
        }
      } else if value.key.hasPrefix("structural/") {
        if let operation = try? JSONDecoder().decode(
          WorkspaceStructuralOperation.self, from: value.data)
        {
          structural +=
            operation.state.unresolved
              || operation.cachedNotes.contains(where: { !$0.recoveryCopies.isEmpty }) ? 1 : 0
        } else {
          unknown += 1
        }
      } else if value.key != "notifications" {
        unknown += 1
      }
    }
    self.composers = composers
    self.captures = captures
    self.structuralOperations = structural
    self.unknownRecords = unknown
  }
}

public struct RecoveryExportEntry: Codable, Sendable {
  public let kind: String
  public let sourcePath: String?
  public let relativePath: String
  public let contentHash: String
  public let byteCount: Int
  public let revision: Int64?
  public let baseVersion: String?
  public let context: String?
}

public struct RecoveryExportManifest: Codable, Sendable {
  public let formatVersion: Int
  public let scope: WorkspaceScope
  public let createdAt: Date
  public let entries: [RecoveryExportEntry]
  public let captures: [QueuedCapture]
  public let structuralOperations: [WorkspaceStructuralOperation]
  public let agentOperations: [RecoveryAgentMutation]
  public let snapshotFingerprint: String
  public let unsupportedRecordCount: Int
}

public struct RecoveryExportResult: Sendable {
  public let directory: URL
  public let manifest: RecoveryExportManifest
  let manifestHash: String
}

/// Issued only after reading back the completed copy selected in Files. It binds the exact
/// protected snapshot and cannot authorize forgetting new work created after that snapshot.
public struct VerifiedRecoveryExport: Sendable {
  public var scope: WorkspaceScope { exported.manifest.scope }
  public let directory: URL
  let exported: RecoveryExportResult
}

public struct RecoveryExportLocation: Sendable {
  public let staging: URL
  public let destination: URL

  public init(staging: URL, destination: URL) {
    self.staging = staging
    self.destination = destination
  }
}

/// Export streams each file independently so an entire offline vault is not duplicated in RAM.
/// Implementations publish the final directory only after every file and manifest is durable.
public protocol RecoveryFileSystem: Sendable {
  func beginExport(in parent: URL, id: UUID) throws -> RecoveryExportLocation
  func write(_ data: Data, relativePath: String, to location: RecoveryExportLocation) throws
  func finishExport(_ location: RecoveryExportLocation) throws -> URL
  func abandonExport(_ location: RecoveryExportLocation)
  func removeCheckpoints(at directory: URL) throws
}
