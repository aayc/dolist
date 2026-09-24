import DailyDoListDomain
import Foundation
import Testing

extension DomainTests {
  /// UTF-16 offsets, fences and nesting (the vectors cover the same ground exhaustively; these
  /// document the decided behavior).
  struct TaskParserTests {
    private func lines(_ doc: String) -> [Int] { TaskParser.parse(doc).map(\.line) }

    /// The text of a UTF-16 range, the way NSString, CodeMirror and JavaScript slice it.
    private func slice(_ doc: String, _ range: Range<Int>) -> String {
      (doc as NSString).substring(with: NSRange(location: range.lowerBound, length: range.count))
    }

    @Test func surrogatePairOffsets() throws {
      let doc = "😀😀 intro\n- [ ] 🎉 party 👩‍💻\n  - [x] 日本語 e\u{301}cole 🇫🇷"
      let tasks = TaskParser.parse(doc)
      #expect(tasks.count == 2)
      let party = try #require(tasks.first)
      #expect(party.from == 11)  // "😀😀 intro\n": 2 × 2 + 6 + 1 code units
      #expect(party.textFrom == party.from + 6)
      #expect(party.to == party.from + party.raw.utf16.count)
      #expect(slice(doc, party.from..<party.to) == party.raw)
      #expect(slice(doc, party.textFrom..<party.to) == party.text)
      let child = tasks[1]
      #expect(child.parentLine == party.line)
      #expect(slice(doc, child.textFrom..<child.to) == "日本語 e\u{301}cole 🇫🇷")
      #expect(child.text.unicodeScalars.elementsEqual("日本語 e\u{301}cole 🇫🇷".unicodeScalars))
    }

    @Test func astralStatusIsNotATask() {
      // `[^\n]` is one UTF-16 code unit; an astral character is two.
      #expect(TaskParser.parse("- [🎉] party").isEmpty)
      #expect(TaskParser.parse("- [é] accent").first?.status == .other)
    }

    @Test func bomAndLineEndings() throws {
      let bom = try #require(TaskParser.parse("\u{FEFF}- [ ] first").first)
      #expect(bom.line == 0 && bom.from == 1 && bom.raw == "- [ ] first")
      let doc = "- [ ] one\r\n  - [x] two\r\n- [ ] lone\rCR"
      let tasks = TaskParser.parse(doc)
      #expect(tasks.map(\.text) == ["one", "two", "lone\rCR"])
      for task in tasks { #expect(slice(doc, task.from..<task.to) == task.raw) }
      #expect(tasks.map(\.parentLine) == [nil, 0, nil])
    }

    @Test func fences() {
      #expect(lines("```\n- [ ] in code\n```\n- [ ] after") == [3])
      // A shorter or different fence doesn't close; an unterminated fence runs to the end.
      #expect(lines("~~~~\n- [ ] a\n~~~\n- [ ] b\n~~~~\n- [ ] c") == [5])
      #expect(lines("```\n- [ ] a\n~~~\n- [ ] b") == [])
      #expect(lines("- [ ] before\n  ```\n  - [ ] indented fence body") == [0])
      #expect(lines("````\n```\n- [ ] still code\n````\n- [ ] out") == [4])
      // A closing fence has no info string; blanks after it are fine.
      #expect(lines("```js\n- [ ] a\n``` not a closer\n- [ ] b\n```\n- [ ] c") == [5])
      #expect(lines("```\n- [ ] a\n```  \t\n- [ ] b") == [3])
      // Backticks in a backtick info string make it inline code, not a fence (tildes don't care).
      #expect(lines("```npm install``` fixed the build\n- [ ] ship it") == [1])
      #expect(lines("~~~ info with ` backtick\n- [ ] in code\n~~~\n- [ ] out") == [3])
      #expect(lines("``\n- [ ] two backticks are text\n``") == [1])
    }

    @Test func frontmatter() {
      #expect(lines("---\ntags: [a]\n- [ ] yaml\n---\n- [ ] body") == [4])
      #expect(lines("---\n- [ ] yaml\n...\n- [ ] body") == [3])
      #expect(lines("\n---\n- [ ] not frontmatter\n---") == [2])
      #expect(lines("---\n- [ ] one\n- [ ] two") == [1, 2])  // unclosed: a thematic break
    }

    @Test func nestingAndNotes() throws {
      let doc = [
        "- [ ] parent",
        "  - plain bullet",
        "    - [ ] grandchild under a plain bullet",
        "      deep note",
        "  1) numbered note",
        "- [ ] sibling [[Daily/2026-09-24]] ![[img.png|x]]",
        "lazy continuation at column 0",
      ].joined(separator: "\n")
      let tasks = TaskParser.parse(doc)
      #expect(tasks.count == 3)
      #expect(tasks[0].depth == 0 && tasks[0].notes == ["plain bullet", "numbered note"])
      #expect(tasks[1].depth == 2 && tasks[1].parentLine == 0 && tasks[1].notes == ["deep note"])
      #expect(tasks[2].parentLine == nil && tasks[2].notes.isEmpty)
      #expect(tasks[2].links == ["Daily/2026-09-24", "img.png"])
      #expect(TaskParser.parse("\t- [ ] tab").first?.indent == 4)
    }

    @Test func lineEdits() {
      #expect(TaskParser.toggleLine("- [ ] a") == "- [x] a")
      #expect(TaskParser.toggleLine("  - [X] a") == "  - [ ] a")
      #expect(TaskParser.toggleLine("- [/] started") == "- [x] started")
      #expect(TaskParser.toggleLine("plain") == "plain")
      #expect(TaskParser.setStatusChar("/", onLine: "1. [ ] a") == "1. [/] a")
      #expect(TaskParser.setStatusChar("$&", onLine: "- [ ] pay") == "- [$&] pay")
      #expect(TaskParser.isTaskLine("- [ ]") && !TaskParser.isTaskLine("- [ ]glued"))
      #expect(!TaskParser.isTaskLine("- [ ] a\nb"))
      #expect(TaskParser.isBlankTaskText(" … ") && !TaskParser.isBlankTaskText("🎉"))
      #expect(TaskStatus(statusChar: ">") == .deferred && TaskStatus.deferred.isClosed)
      #expect(TaskStatus.inProgress.statusChar == "/" && TaskStatus.other.statusChar == " ")
    }

    @Test func trackingAndAnchors() {
      var n = 0
      let ids = { () -> String in
        n += 1
        return "t\(n)"
      }
      let first = TaskTracker.track(previous: [], markdown: "- [ ] Book den\n- [ ] pay rent", now: 1000, idFactory: ids)
      let second = TaskTracker.track(
        previous: first.tasks, markdown: "- [x] pay rent\n- [ ] Book dentist for Tuesday", now: 2000, idFactory: ids)
      #expect(second.tasks.map(\.id) == ["t2", "t1"])
      #expect(second.diff.updated.map(\.task.id) == ["t1"] && second.diff.statusChanged.map(\.task.id) == ["t2"])
      #expect(second.tasks[1].firstSeenAt == 1000 && second.tasks[1].updatedAt == 2000)
      #expect(!second.diff.isEmpty && TaskTracker.makeID().hasPrefix("tsk_"))

      let anchors = [
        TaskAnchor(taskId: "a", text: "Book dentist", line: 0),
        TaskAnchor(taskId: "b", text: "Renew passport", line: 1),
      ]
      let doc = "- [ ] New task on top\n- [ ] Book dentist for Tuesday\n\n- [ ] Renew passport"
      #expect(TaskAnchors.resolve(doc, anchors: anchors) == ["a": 1, "b": 3])
      #expect(TaskAnchors.resolve("- [ ] something else entirely", anchors: anchors) == [:])
    }

    @Test func reorderingThousandsOfSimilarTasksKeepsEveryId() {
      // Same length, one character apart: hash buckets collide, texts must still stay apart.
      let texts = (0..<6000).map { String(format: "task %04d", $0) }
      var n = 0
      let ids = { () -> String in
        n += 1
        return "t\(n)"
      }
      let first = TaskTracker.track(previous: [], markdown: texts.map { "- [ ] \($0)" }.joined(separator: "\n"), now: 1, idFactory: ids)
      var generator = SeededGenerator(seed: 7)
      let shuffled = texts.shuffled(using: &generator)
      let second = TaskTracker.track(
        previous: first.tasks, markdown: shuffled.map { "- [ ] \($0)" }.joined(separator: "\n"), now: 2, idFactory: ids)
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
      let result = TaskTracker.track(previous: [], parsed: edited, now: 0, idFactory: { "id\(UUID().uuidString)" })
      #expect(result.tasks[1].parentId == nil)
      #expect(result.tasks[2].parentId == nil)
      #expect(TaskTracker.track(previous: [], parsed: parsed, now: 0).tasks.map(\.parentId).compactMap { $0 }.count == 2)
    }
  }
}
