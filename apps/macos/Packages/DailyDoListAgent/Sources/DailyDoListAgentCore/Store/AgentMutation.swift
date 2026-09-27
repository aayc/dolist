import DailyDoListClient
import DailyDoListModels
import Foundation

/// Exact, persistable user intent. Credentials and connection addresses never enter this value.
public enum AgentMutationCommand: Codable, Hashable, Sendable {
  case message(threadID: String, text: String)
  case cancelThread(String)
  case retryThread(String)
  case approval(id: String, decision: ApprovalDecisionRequest)
  case createRoutine(CreateRoutineRequest)
  case runRoutine(String)
  case pauseRoutine(String)
  case resumeRoutine(String)

  /// An unresolved control cannot acquire a replacement ID, even if its payload was changed.
  public var exclusionKey: String? {
    switch self {
    case .message(let id, _): "message/" + id
    case .cancelThread(let id): "cancel/" + id
    case .retryThread(let id): "retry/" + id
    case .approval(let id, _): "approval/" + id
    case .createRoutine: "create-routine"
    case .runRoutine(let id): "run/" + id
    case .pauseRoutine(let id), .resumeRoutine(let id): "routine-state/" + id
    }
  }

  public func send(using client: any DaemonClient, operationID: String?) async throws
    -> AgentMutationResult
  {
    switch self {
    case .message(let id, let text):
      if let operationID {
        return .thread(
          try await client.postMessage(threadId: id, text: text, operationId: operationID))
      }
      return .thread(try await client.postMessage(threadId: id, text: text))
    case .cancelThread(let id):
      if let operationID {
        return .thread(try await client.cancelThread(id, operationId: operationID))
      }
      return .thread(try await client.cancelThread(id))
    case .retryThread(let id):
      if let operationID {
        return .thread(try await client.retryThread(id, operationId: operationID))
      }
      return .thread(try await client.retryThread(id))
    case .approval(let id, let decision):
      if let operationID {
        return .approval(try await client.decideApproval(id, decision, operationId: operationID))
      }
      return .approval(try await client.decideApproval(id, decision))
    case .createRoutine(let request):
      if let operationID {
        return .routine(try await client.createRoutine(request, operationId: operationID))
      }
      return .routine(try await client.createRoutine(request))
    case .runRoutine(let id):
      if let operationID { return .run(try await client.runRoutine(id, operationId: operationID)) }
      return .run(try await client.runRoutine(id))
    case .pauseRoutine(let id):
      if let operationID {
        return .routine(try await client.pauseRoutine(id, operationId: operationID))
      }
      return .routine(try await client.pauseRoutine(id))
    case .resumeRoutine(let id):
      if let operationID {
        return .routine(try await client.resumeRoutine(id, operationId: operationID))
      }
      return .routine(try await client.resumeRoutine(id))
    }
  }

  public func decodeReceipt(_ response: AgentOperationResponse.Response) throws
    -> AgentMutationResult
  {
    let data = try JSONEncoder().encode(response.body)
    let decoder = JSONDecoder()
    guard (200..<300).contains(response.status) else {
      if case .approval = self, response.status == 409,
        let conflict = try? decoder.decode(ApprovalConflictResponse.self, from: data)
      {
        throw DaemonClientError.approvalConflict(conflict)
      }
      throw DaemonClientError.http(
        status: response.status, body: try? decoder.decode(ApiErrorBody.self, from: data))
    }
    switch self {
    case .message, .cancelThread, .retryThread:
      return .thread(try decoder.decode(ThreadActionResponse.self, from: data))
    case .approval:
      return .approval(try decoder.decode(ApprovalResponse.self, from: data).approval)
    case .createRoutine, .pauseRoutine, .resumeRoutine:
      return .routine(try decoder.decode(RoutineResponse.self, from: data).routine)
    case .runRoutine:
      return .run(try decoder.decode(RoutineRunResponse.self, from: data))
    }
  }
}

public enum AgentMutationResult: Codable, Hashable, Sendable {
  case thread(ThreadActionResponse)
  case approval(ApprovalRequest)
  case routine(Routine)
  case run(RoutineRunResponse)
}

public struct PendingAgentMutation: Codable, Hashable, Sendable, Identifiable {
  public let id: String
  public let command: AgentMutationCommand
  public let createdAt: Date

  public init(id: String, command: AgentMutationCommand, createdAt: Date) {
    self.id = id
    self.command = command
    self.createdAt = createdAt
  }
}

/// Phone implementations persist before dispatch and never replay restored controls. Approval
/// authorization is checked again after preparation, immediately before the first dispatch.
public protocol AgentMutationJournal: Sendable {
  func perform(
    _ command: AgentMutationCommand, operationID: String?,
    authorize: @escaping @MainActor @Sendable () -> Bool
  ) async throws -> AgentMutationResult
  func pending() async throws -> [PendingAgentMutation]
  func resolve(_ operationID: String) async throws -> AgentMutationResult
}

public enum AgentMutationError: Error, Equatable, Sendable, LocalizedError {
  case uncertain(String)
  case changedIntent(String)
  case authorizationChanged
  case unsupportedHost
  case corruptJournal

  public var errorDescription: String? {
    switch self {
    case .uncertain:
      "Delivery is unconfirmed. Check the saved operation's receipt before taking this action again."
    case .changedIntent:
      "An earlier action is unresolved. Review its receipt before submitting a different action."
    case .authorizationChanged: "This action changed or is no longer available. Review it again."
    case .unsupportedHost: "Update the host to support durable agent actions."
    case .corruptJournal: "The saved action cannot be read safely. Its records have been preserved."
    }
  }
}
