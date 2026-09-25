import DailyDoListModels
import Foundation

extension SampleData {
  /// The orchestrator's chat in the sample: a morning of decisions on the sample's tasks, then the
  /// user asking what it's working on and redirecting the booking.
  static func orchestratorThread(now: Date, notePath: String) -> AgentThread {
    func ago(_ minutes: Double) -> EpochMillis {
      now.addingTimeInterval(-minutes * 60).epochMillis
    }
    func status(_ id: String, _ minutes: Double, _ text: String) -> ThreadMessage {
      .status(
        StatusMessage(
          id: id, author: "system", createdAt: ago(minutes), status: .working, text: text))
    }
    func thought(_ id: String, _ minutes: Double, seconds: Int) -> ThreadMessage {
      .status(
        StatusMessage(
          id: id, author: "orchestrator", createdAt: ago(minutes), status: .working,
          text: "Thought for \(seconds) s"))
    }
    func tool(
      _ id: String, _ minutes: Double, _ name: String, _ label: String, _ input: JSONValue,
      _ result: String
    ) -> ThreadMessage {
      .toolCall(
        ToolCallMessage(
          id: id, author: "orchestrator", createdAt: ago(minutes), toolCallId: "call_\(id)",
          toolName: name, label: label, input: input, status: .ok, resultPreview: result,
          endedAt: ago(minutes) + 180))
    }
    func text(_ id: String, _ minutes: Double, role: MessageRole, _ body: String) -> ThreadMessage {
      .text(
        TextMessage(
          id: id, author: role == .user ? "you" : "orchestrator", createdAt: ago(minutes),
          role: role, text: body))
    }
    let messages: [ThreadMessage] = [
      status("msg_o01", 95, "\(notePath) changed: 4 tasks"),
      thought("msg_o02", 95, seconds: 2),
      tool(
        "msg_o03", 94.9, "spawn_subagent", "Delegate to subagent",
        [
          "taskId": "tsk_sample_desks", "goal": "Compare standing desks under $500",
          "capabilities": ["web"],
        ], "Subagent started for tsk_sample_desks."),
      tool(
        "msg_o04", 94.8, "ask_user", "Ask the user",
        [
          "taskId": "tsk_sample_passport",
          "question": "Is this a renewal by mail, or do you need to apply in person?",
        ], "Question posted. The user's reply will arrive as a new event."),
      tool(
        "msg_o05", 94.7, "set_task_status", "Set task status",
        ["taskId": "tsk_sample_hikes", "status": "ignored"], "Status set to ignored."),
      status("msg_o06", 52, "\(notePath) changed: 1 task"),
      tool(
        "msg_o07", 52, "spawn_subagent", "Delegate to subagent",
        [
          "taskId": "tsk_sample_booking",
          "goal": "Book a table for 4 at an Italian place, Friday 7pm",
          "capabilities": ["browser"],
        ], "Subagent started for tsk_sample_booking."),
      status("msg_o08", 40, "“Compare standing desks under $500” finished"),
      text("msg_o09", 6, role: .user, "What are you working on?"),
      status("msg_o10", 6, "You wrote to me"),
      thought("msg_o11", 5.9, seconds: 3),
      text(
        "msg_o12", 5.8, role: .agent,
        "Two things are running: the **booking** agent is waiting for your OK on Trattoria Sole at 7:00 PM, and the coffee order is adding House Blend to the cart. The standing desks are done — the Example Rise Pro at $449 is the pick."
      ),
      text("msg_o13", 3, role: .user, "For the dinner, ask for a table on the patio"),
      status("msg_o14", 3, "You wrote to me"),
      tool(
        "msg_o15", 2.9, "message_subagent", "Message subagent",
        [
          "taskId": "tsk_sample_booking",
          "text": "The user would like a table on the patio if there is one.",
        ], "Message delivered."),
      text(
        "msg_o16", 2.8, role: .agent,
        "Passed that on to the booking agent — it'll ask for the patio before you approve."),
    ]
    return AgentThread(
      id: OrchestratorThread.id, taskId: nil, notePath: nil, title: OrchestratorThread.title,
      status: .idle, createdAt: ago(95), updatedAt: ago(2.8), messages: messages)
  }
}
