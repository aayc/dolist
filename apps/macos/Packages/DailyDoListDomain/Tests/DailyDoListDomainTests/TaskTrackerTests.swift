import DailyDoListDomain
import Foundation
import Testing

extension DomainTests {
  /// What tasks.json and tracker.json can't reach: the default id factory, thousands of similar
  /// tasks, and parsed tasks built by hand.
  struct TaskTrackerTests {
    @Test func defaultIdsLookLikeTheCores() {
      #expect(TaskTracker.makeID().hasPrefix("tsk_"))
    }

    @Test func reorderingThousandsOfSimilarTasksKeepsEveryId() {
      // Same length, one character apart: hash buckets collide, texts must still stay apart.
      let texts = (0..<6000).map { String(format: "task %04d", $0) }
      var n = 0
      let ids = { () -> String in
        n += 1
        return "t\(n)"
      }
      let first = TaskTracker.track(
        previous: [], markdown: texts.map { "- [ ] \($0)" }.joined(separator: "\n"), now: 1,
        idFactory: ids)
      var generator = SeededGenerator(seed: 7)
      let shuffled = texts.shuffled(using: &generator)
      let second = TaskTracker.track(
        previous: first.tasks, markdown: shuffled.map { "- [ ] \($0)" }.joined(separator: "\n"),
        now: 2, idFactory: ids)
      #expect(second.diff.isEmpty)
      let before = Dictionary(uniqueKeysWithValues: first.tasks.map { ($0.text, $0.id) })
      #expect(second.tasks.allSatisfy { before[$0.text] == $0.id })
    }

    @Test func parentLinesWithoutATaskHaveNoParentId() {
      let parsed = TaskParser.parse("- [ ] a\n\n  - [ ] b\n\n    - [ ] c")
      #expect(parsed.map(\.line) == [0, 2, 4])
      var edited = parsed
      edited[1].parentLine = 1  // a blank line
      edited[2].parentLine = 7  // past the end
      let result = TaskTracker.track(
        previous: [], parsed: edited, now: 0, idFactory: { "id\(UUID().uuidString)" })
      #expect(result.tasks[1].parentId == nil)
      #expect(result.tasks[2].parentId == nil)
      #expect(
        TaskTracker.track(previous: [], parsed: parsed, now: 0).tasks.map(\.parentId).compactMap {
          $0
        }.count == 2)
    }
  }
}
