import DailyDoListModels
import Testing

@testable import DailyDoListAgent

@Suite("Reducer: task records")
struct ReducerRecordTests {
  @Test func upsertsAndIgnoresStaleUpdates() {
    var state = AgentState()
    #expect(state.apply(.taskRecord(Fixture.record()), now: 0) == .records)
    _ = state.apply(.taskRecord(Fixture.record(status: .working, threadId: "thr_1", updatedAt: 20)), now: 0)
    #expect(state.recordsByNote[Fixture.note]?.first?.status == .working)

    let before = state
    #expect(state.apply(.taskRecord(Fixture.record(updatedAt: 5)), now: 0).isEmpty)
    #expect(state == before)
  }

  @Test func duplicateRecordIsANoOp() {
    var state = AgentState()
    _ = state.upsertRecord(Fixture.record(updatedAt: 20))
    let before = state
    #expect(state.upsertRecord(Fixture.record(updatedAt: 20)).isEmpty)
    #expect(state == before)
  }

  @Test func equalTimestampsApplyTheLaterCopy() {
    var state = AgentState()
    _ = state.upsertRecord(Fixture.record(status: .working, updatedAt: 20))
    _ = state.upsertRecord(Fixture.record(status: .done, updatedAt: 20))
    #expect(state.record(forTaskId: "tsk_1")?.status == .done)
  }

  @Test func movesARecordBetweenNotesWhenItsNotePathChanges() {
    var state = AgentState()
    _ = state.upsertRecord(Fixture.record())
    _ = state.upsertRecord(Fixture.record(notePath: Fixture.otherNote, updatedAt: 30))
    #expect(state.recordsByNote[Fixture.note]?.contains { $0.taskId == "tsk_1" } == false)
    #expect(state.record(forTaskId: "tsk_1")?.notePath == Fixture.otherNote)
  }

  @Test func ignoresAStaleRecordForATaskThatMovedToAnotherNote() {
    var state = AgentState()
    _ = state.upsertRecord(Fixture.record(notePath: Fixture.otherNote, status: .done, updatedAt: 50))
    _ = state.upsertRecord(Fixture.record(updatedAt: 40))
    #expect(state.record(forTaskId: "tsk_1")?.notePath == Fixture.otherNote)
    #expect(state.recordsByNote[Fixture.note] == nil)
  }

  @Test func snapshotReplacesTheNoteButKeepsNewerKnownRecords() {
    var state = AgentState()
    _ = state.upsertRecord(Fixture.record(status: .done, updatedAt: 50))
    _ = state.upsertRecord(Fixture.record("tsk_gone", updatedAt: 1))
    _ = state.applyRecordsSnapshot(notePath: Fixture.note, records: [Fixture.record(status: .working, updatedAt: 40)])
    let bucket = state.recordsByNote[Fixture.note] ?? []
    #expect(bucket.map(\.taskId) == ["tsk_1"])
    #expect(bucket.first?.status == .done)
  }

  @Test func taskRecordsEventReplacesTheBucketInOrder() {
    var state = AgentState()
    _ = state.upsertRecord(Fixture.record("tsk_old"))
    _ = state.apply(
      .taskRecords(TaskRecordsEvent(notePath: Fixture.note, records: [Fixture.record("a"), Fixture.record("b")])),
      now: 0)
    #expect(state.recordsByNote[Fixture.note]?.map(\.taskId) == ["a", "b"])
  }

  @Test func keepsATaskInOneNoteWhenAnotherNotesSnapshotContainsIt() {
    // A rename: the new path's snapshot arrives while the old path still lists the task.
    var state = AgentState()
    _ = state.upsertRecord(Fixture.record())
    _ = state.applyRecordsSnapshot(
      notePath: Fixture.otherNote, records: [Fixture.record(notePath: Fixture.otherNote, updatedAt: 10)])
    #expect(state.recordsByNote[Fixture.note]?.isEmpty == true)
    #expect(state.recordsByNote[Fixture.otherNote]?.count == 1)
    // A stale snapshot of the old path doesn't pull the task back.
    _ = state.applyRecordsSnapshot(notePath: Fixture.note, records: [Fixture.record(updatedAt: 5)])
    #expect(state.recordsByNote[Fixture.note]?.isEmpty == true)
    #expect(state.record(forTaskId: "tsk_1")?.notePath == Fixture.otherNote)
  }

  @Test func snapshotNormalizesNotePathsAndDropsDuplicateTasks() {
    var state = AgentState()
    _ = state.applyRecordsSnapshot(
      notePath: Fixture.note,
      records: [Fixture.record(notePath: "Elsewhere.md"), Fixture.record(status: .done)])
    #expect(state.recordsByNote[Fixture.note]?.count == 1)
    #expect(state.recordsByNote[Fixture.note]?.first?.notePath == Fixture.note)
    #expect(state.recordsByNote["Elsewhere.md"] == nil)
  }

  @Test func restSnapshotPreservesRecordsTouchedWhileItWasInFlight() {
    var state = AgentState()
    _ = state.upsertRecord(Fixture.record("tsk_new", updatedAt: 90))
    _ = state.upsertRecord(Fixture.record("tsk_stale", updatedAt: 5))
    _ = state.applyRecordsSnapshot(
      notePath: Fixture.note, records: [Fixture.record("tsk_1")], preserving: ["tsk_new"])
    #expect(state.recordsByNote[Fixture.note]?.map(\.taskId).sorted() == ["tsk_1", "tsk_new"])
  }

  @Test func markReadClearsTheUnreadCountOfTheThreadsTask() {
    var state = AgentState()
    _ = state.upsertRecord(Fixture.record(threadId: "thr_1", unread: 3))
    #expect(state.markRead(threadId: "thr_1") == .records)
    #expect(state.record(forTaskId: "tsk_1")?.unread == 0)
    #expect(state.markRead(threadId: "thr_1").isEmpty)
    #expect(state.markRead(threadId: "thr_unknown").isEmpty)
  }

  @Test func recordForThreadUsesTheThreadsTaskIdFirst() {
    var state = Fixture.loaded(Fixture.thread(taskId: "tsk_2"))
    _ = state.upsertRecord(Fixture.record("tsk_1", threadId: "thr_1"))
    _ = state.upsertRecord(Fixture.record("tsk_2", threadId: nil))
    #expect(state.record(forThread: "thr_1")?.taskId == "tsk_2")
  }
}
