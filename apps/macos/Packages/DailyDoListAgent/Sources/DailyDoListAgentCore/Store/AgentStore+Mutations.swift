import DailyDoListClient
import DailyDoListModels
import Foundation

extension AgentStore {
  func performMutation(
    _ command: AgentMutationCommand, operationID: String? = nil,
    authorize: @escaping @MainActor @Sendable () -> Bool = { true }
  ) async throws -> AgentMutationResult {
    guard let mutationJournal else {
      return try await command.send(using: client, operationID: nil)
    }
    do {
      let result = try await mutationJournal.perform(
        command, operationID: operationID, authorize: authorize)
      await refreshPendingMutations()
      return result
    } catch {
      await refreshPendingMutations()
      throw error
    }
  }

  public func refreshPendingMutations() async {
    guard let mutationJournal else { return }
    do { pendingMutations = try await mutationJournal.pending() } catch {
      report(error, title: "Couldn't load saved actions")
    }
  }

  /// A user-initiated receipt check. Refresh/reconnect never dispatches a saved control.
  @discardableResult
  public func resolveMutation(_ operationID: String) async -> Bool {
    guard let mutationJournal else { return false }
    do {
      let result = try await mutationJournal.resolve(operationID)
      switch result {
      case .approval(let approval): mutate { $0.upsertApproval(approval, force: true) }
      case .routine(let routine): mutate { $0.upsertRoutine(routine) }
      case .run(let run): mutate { $0.upsertRoutine(run.routine) }
      case .thread: break
      }
      unsentMessages[operationID] = nil
      await refreshPendingMutations()
      await refresh()
      return true
    } catch {
      await refreshPendingMutations()
      report(error, title: "Action still needs review")
      return false
    }
  }

  func restorePendingMessages(threadID: String) {
    for operation in pendingMutations {
      guard case .message(let id, let text) = operation.command, id == threadID else { continue }
      guard state.loadedThreads[id]?.messages.contains(where: { $0.id == operation.id }) == false,
        !state.optimisticReplacements.values.contains(operation.id)
      else { continue }
      let message = TextMessage(
        id: operation.id, author: "you", createdAt: operation.createdAt.epochMillis,
        role: .user, text: text)
      mutate { $0.insertOptimisticMessage(message, threadId: id) }
      unsentMessages[operation.id] = AgentMutationError.uncertain(operation.id).localizedDescription
    }
  }
}
