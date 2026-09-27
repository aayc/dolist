import DailyDoListAgentCore
import DailyDoListModels
import Foundation

/// The journal and recovery exporter share one decoder so future formats fail closed in both.
struct AgentMutationRecoveryRecord: Codable {
  var version = 1
  let scope: WorkspaceScope
  let intent: PendingAgentMutation
  var result: AgentMutationResult?
  var receipt: AgentOperationResponse.Response?
  var notDispatched = false

  var unresolved: Bool { result == nil && receipt == nil && !notDispatched }

  static func decode(_ stored: WorkspaceStoredValue, scope: WorkspaceScope) throws -> Self {
    guard let record = try? JSONDecoder().decode(Self.self, from: stored.data),
      record.version == 1, record.scope == scope,
      stored.key == "agent-operation/" + record.intent.id
    else { throw AgentMutationError.corruptJournal }
    return record
  }
}

public struct RecoveryAgentMutation: Codable, Sendable {
  public let scope: WorkspaceScope
  public let intent: PendingAgentMutation
  public let revision: Int64
}

struct RecoveryAgentMutations {
  var operations: [RecoveryAgentMutation] = []
  var recognizedKeys: Set<String> = []

  init(values: [WorkspaceStoredValue], scope: WorkspaceScope) {
    let slots = Dictionary(uniqueKeysWithValues: values.map { ($0.key, $0) })
    for value in values where value.key.hasPrefix("agent-operation/") {
      guard let record = try? AgentMutationRecoveryRecord.decode(value, scope: scope),
        record.unresolved, let exclusion = record.intent.command.exclusionKey
      else { continue }
      let slotKey = "agent-operation-slot/" + MarkdownCheckpointStore.digest(Data(exclusion.utf8))
      guard let slot = slots[slotKey], slot.retention == .durable,
        slot.data == Data(record.intent.id.utf8)
      else { continue }
      operations.append(
        RecoveryAgentMutation(scope: scope, intent: record.intent, revision: value.revision))
      recognizedKeys.formUnion([value.key, slotKey])
    }
    operations.sort { $0.intent.id < $1.intent.id }
  }
}
