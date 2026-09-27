import DailyDoListModels

/// Compatibility defaults for clients predating durable operations. Callers must feature-check.
extension DaemonClient {
  public func postMessage(threadId: String, text: String, operationId: String) async throws
    -> ThreadActionResponse
  {
    try await postMessage(threadId: threadId, text: text)
  }

  public func cancelThread(_ id: String, operationId: String) async throws -> ThreadActionResponse {
    try await cancelThread(id)
  }

  public func retryThread(_ id: String, operationId: String) async throws -> ThreadActionResponse {
    try await retryThread(id)
  }

  public func decideApproval(_ id: String, _ decision: ApprovalDecisionRequest, operationId: String)
    async throws -> ApprovalRequest
  {
    try await decideApproval(id, decision)
  }

  public func createRoutine(_ request: CreateRoutineRequest, operationId: String) async throws
    -> Routine
  {
    try await createRoutine(request)
  }

  public func runRoutine(_ id: String, operationId: String) async throws -> RoutineRunResponse {
    try await runRoutine(id)
  }

  public func pauseRoutine(_ id: String, operationId: String) async throws -> Routine {
    try await pauseRoutine(id)
  }

  public func resumeRoutine(_ id: String, operationId: String) async throws -> Routine {
    try await resumeRoutine(id)
  }

  public func agentOperation(_ operationId: String) async throws -> AgentOperationResponse {
    throw DaemonClientError.notFound("This client does not serve agent operation receipts.")
  }

}
