import DailyDoListDomain
import DailyDoListModels
import Foundation
import Testing

extension DomainTests {
  /// What agent-text.json can't reach: `TrackedTask.agent` and `LineAnchor(record:)`.
  struct AgentTextTests {
    @Test func trackedTasksKeepTheAgentFlag() {
      let tasks = TaskParser.parse(
        "- [ ] Call the restaurant to confirm %%agent:thr_9%%\n- [ ] Mine")
      let tracked = TaskTracker.track(previous: [], parsed: tasks, now: 1, idFactory: { "t" }).tasks
      #expect(tracked.map(\.agent) == [true, false])
    }

    @Test func lineAnchorsFromRecords() {
      let record = TaskAgentRecord(
        taskId: "anc_1", notePath: "n.md", date: nil, text: "Why?", line: 3, status: .done,
        threadId: "thr_1",
        updatedAt: 0, unread: 0, anchor: .line)
      #expect(LineAnchor(record: record) == LineAnchor(anchorId: "anc_1", text: "Why?", line: 3))
    }
  }
}
