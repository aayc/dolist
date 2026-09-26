import AppKit
import DailyDoListModels
import DailyDoListUITestSupport
import SwiftUI
import Testing

@testable import DailyDoListAgent

/// The agent panel with 400 of today's threads (their records, 60 pending approvals) and a thread
/// of 1,000 messages, in an offscreen window: each sample includes SwiftUI's layout and drawing.
/// Numbers: docs/PERFORMANCE.md.
@MainActor
@Suite("Performance", .serialized)
struct PerformanceTests {
  static let now = FormattingTests.now
  static let at = now.epochMillis
  static let long = "thr_long"

  static func store() -> AgentStore {
    let threads = (0..<400).map { i in
      Fixture.summary(
        "thr_\(i)", taskId: "tsk_\(i)", notePath: "Note \(i % 25).md", title: "Compare offers \(i)",
        status: i.isMultiple(of: 3) ? .done : .working, createdAt: at,
        updatedAt: at - EpochMillis(i) * 60_000, preview: "Found **three** vendors")
    }
    let messages = (0..<1_000).map { i in
      i % 4 == 3
        ? Fixture.toolCall("m\(i)", status: .ok, createdAt: at, endedAt: at)
        : Fixture.text(
          "m\(i)", "Step \(i): the [first](https://a.example) one ships in **two days**.",
          streaming: i == 998, author: "subagent:research", createdAt: at)
    }
    let snapshot = SampleData.Snapshot(
      now: now, dailyNotePath: "Note 0.md", status: Fixture.status(),
      records: threads.map {
        Fixture.record(
          $0.taskId!, notePath: $0.notePath!, status: $0.status, threadId: $0.id,
          updatedAt: $0.updatedAt, unread: 1)
      },
      threads: threads + [Fixture.summary(long, taskId: nil, updatedAt: at, messageCount: 1_000)],
      loadedThreads: [Fixture.thread(long, taskId: nil, updatedAt: at, messages: messages)],
      approvals: (0..<60).map { Fixture.approval("apr_\($0)", threadId: "thr_\($0 * 5)") },
      artifacts: [:], frames: [])
    let now = now
    let store = AgentStore(client: SampleDaemonClient(snapshot: snapshot), now: { now })
    store.load(snapshot)
    return store
  }

  func panel(_ store: AgentStore, thread: String? = nil) -> NSWindow {
    Perf.window(
      AgentPanel(store: store, selectedThreadId: .constant(thread)).agentReferenceDate(Self.now),
      size: CGSize(width: 380, height: 820))
  }

  @Test func longThreadOpens() async {
    let store = Self.store()
    let ms = await Perf.median("a thread of 1,000 messages opens", runs: 5) { _ in
      let window = panel(store, thread: Self.long)
      window.render()
      window.close()
    }
    #expect(ms < 150 * Perf.multiplier)
  }

  @Test func streamingIntoALongThread() async {
    let store = Self.store()
    let window = panel(store, thread: Self.long)
    window.render()
    let ms = await Perf.median("streamed text in a thread of 1,000 messages", runs: 61) { _ in
      store.apply(
        .threadDelta(ThreadDeltaEvent(threadId: Self.long, messageId: "m998", delta: "more ")))
      window.render()
    }
    #expect(ms < 12 * Perf.multiplier)
    window.close()
  }

  @Test func inboxEvents() async {
    let store = Self.store()
    let window = panel(store)
    window.render()
    let ms = await Perf.median("inbox of 400 threads: an upsert, record or approval", runs: 61) {
      i in
      let id = "thr_\(i * 7 % 400)"
      let stamp = Self.at + EpochMillis(i + 1)
      switch i % 3 {
      case 0:
        store.apply(
          .threadUpsert(Fixture.summary(id, status: .done, createdAt: stamp, updatedAt: stamp)))
      case 1:
        store.apply(
          .taskRecord(Fixture.record("tsk_\(i * 7 % 400)", threadId: id, updatedAt: stamp)))
      default:
        store.apply(
          .approvalUpsert(Fixture.approval("apr_new_\(i)", threadId: id, createdAt: stamp)))
      }
      window.render()
    }
    #expect(ms < 12 * Perf.multiplier)
    window.close()
  }
}
