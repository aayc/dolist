import DailyDoListModels
import Foundation

/// The orchestrator's own chat, like the daemon's: a thread with a well-known id that records each
/// simulated decision (a status line saying what woke it, the tool call it made with the task it
/// acts on) and answers the user's messages with a streamed reply. Only with the simulated agent:
/// the disabled simulation, like the daemon's null runtime, has no threads at all.
extension FakeDaemon {
  func seedOrchestratorChat() {
    guard simulation == .enabled, threads[OrchestratorThread.id] == nil else { return }
    threads[OrchestratorThread.id] = AgentThread(
      id: OrchestratorThread.id, taskId: nil, notePath: nil, title: OrchestratorThread.title,
      status: .idle, createdAt: nowMillis, updatedAt: nowMillis)
  }

  /// A task was handed to a subagent: one turn with its `spawn_subagent` call.
  func recordDelegation(taskId: String, notePath: String, text: String, subagent: String) {
    let id = OrchestratorThread.id
    guard threads[id] != nil else { return }
    beginOrchestratorTurn("\(notePath) changed: 1 task")
    pushMessage(
      id,
      .toolCall(
        ToolCallMessage(
          id: nextID("msg"), author: "orchestrator", createdAt: nowMillis,
          toolCallId: nextID("call"), toolName: "spawn_subagent", label: "Delegate to subagent",
          input: [
            "taskId": .string(taskId), "goal": .string(text),
            "capabilities": [.string(subagent == "browser" ? "browser" : "web")],
          ], status: .ok, resultPreview: "Subagent started for \(taskId).", endedAt: nowMillis)))
    endOrchestratorTurn()
  }

  /// A subagent's work ended; the orchestrator reads the report and leaves it be.
  func recordReport(taskText: String, status: TaskAgentStatus) {
    guard threads[OrchestratorThread.id] != nil else { return }
    let outcome = status == .done ? "finished" : status == .failed ? "failed" : "stopped"
    beginOrchestratorTurn("“\(Self.excerpt(taskText))” \(outcome)")
    endOrchestratorTurn()
  }

  /// The user wrote in the chat (the message is already there): a turn that streams a reply.
  func startOrchestratorReply(to text: String) {
    let id = OrchestratorThread.id
    let reply = orchestratorReply(to: text)
    jobGeneration += 1
    let jobId = nextID("reply")
    jobs[jobId] = Job(
      id: jobId, taskId: nil, threadId: id, script: nil,
      beats: [Job.Beat(delay: 200, step: .turn("You wrote to me"))]
        + say("orchestrator", reply, after: 1_000) + [Job.Beat(delay: 0, step: .end)],
      generation: jobGeneration)
    scheduleNextBeat(jobId)
  }

  /// Stop in the chat: ends the reply in progress, if any.
  func stopOrchestratorTurn() {
    let running = jobs.values.filter { $0.threadId == OrchestratorThread.id }
    guard !running.isEmpty else { return }
    for job in running.sorted(by: { $0.id < $1.id }) { abort(job) }
    pushMessage(
      OrchestratorThread.id,
      Self.statusMessage(.cancelled, "You stopped this run", at: nowMillis, id: nextID("msg")))
    endOrchestratorTurn()
  }

  func beginOrchestratorTurn(_ trigger: String) {
    let id = OrchestratorThread.id
    threads[id]?.status = .working
    pushMessage(id, Self.statusMessage(.working, trigger, at: nowMillis, id: nextID("msg")))
  }

  func endOrchestratorTurn() {
    let id = OrchestratorThread.id
    guard threads[id]?.status != .idle else { return }
    threads[id]?.status = .idle
    emitThread(id)
  }

  private func orchestratorReply(to text: String) -> String {
    let lowered = text.lowercased()
    let asksStatus = ["what", "status", "doing", "working", "running", "progress"].contains {
      lowered.contains($0)
    }
    guard asksStatus else { return "Got it — I'll keep that in mind for your tasks." }
    let working = jobs.values.compactMap { $0.taskId.flatMap { records[$0]?.text } }.sorted()
    let today = self.today.iso
    let done = records.values.filter { $0.status == .done && $0.date == today }.count
    let now =
      working.isEmpty
      ? "Nothing is running right now."
      : "Working on \(working.map { "“\(Self.excerpt($0))”" }.joined(separator: " and "))."
    return done > 0 ? "\(now) Done today: \(done)." : now
  }

  static func excerpt(_ text: String) -> String {
    text.count > 60 ? "\(text.prefix(59))…" : text
  }
}
