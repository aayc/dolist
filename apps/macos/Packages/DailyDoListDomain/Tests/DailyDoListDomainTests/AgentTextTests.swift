import DailyDoListDomain
import DailyDoListModels
import Foundation
import Testing

extension DomainTests {
  /// Mirrors @ddl/core `markdown/agent-text.test.ts` (agent markers and line anchors).
  struct AgentTextTests {
    @Test func marksALineWithTheThreadThatWroteIt() {
      #expect(
        AgentText.markLine("  - Booked Trattoria Sole, Fri 7pm", threadId: "thr_abc")
          == "  - Booked Trattoria Sole, Fri 7pm %%agent:thr_abc%%")
      #expect(AgentText.markLine("- Found 3 options") == "- Found 3 options %%agent%%")
    }

    @Test func replacesAnExistingMarkerAndNeverMarksABlankLine() {
      #expect(
        AgentText.markLine("- x %%agent:thr_old%%", threadId: "thr_new") == "- x %%agent:thr_new%%")
      #expect(AgentText.markLine("   ", threadId: "thr_1") == "")
      #expect(AgentText.markLine("- y", threadId: "not a valid id!") == "- y %%agent%%")
      // Only blanks go before the marker; other whitespace keeps the line unmarked when it's all
      // there is (like `trim()`).
      #expect(AgentText.markLine("\u{00A0}", threadId: "thr_1") == "\u{00A0}")
      #expect(AgentText.markLine("- z\t \t", threadId: "thr_1") == "- z %%agent:thr_1%%")
    }

    @Test func parsesTheTextTheThreadAndWhereTheMarkerStarts() {
      #expect(
        AgentText.parse("- Booked %%agent:thr_1%%")
          == AgentLine(text: "- Booked", threadId: "thr_1", markerFrom: 8))
      #expect(AgentText.parse("- mine") == nil)
      #expect(AgentText.parse("%%agent%% in the middle is not a marker") == nil)
      #expect(AgentText.isAgentLine("- ok %%agent%%  "))
      #expect(AgentText.stripMarker("- ok %%agent:t%%") == "- ok")
    }

    @Test func markerEdgeCases() {
      // Offsets count UTF-16 code units, like JavaScript.
      #expect(AgentText.parse("🎉 party\t %%agent%%")?.markerFrom == 8)
      #expect(AgentText.parse("🎉 party\t %%agent%%")?.text == "🎉 party")
      // The whole line can be a marker; a trailing tab is fine, a newline isn't.
      #expect(AgentText.parse("%%agent:x%%\t") == AgentLine(text: "", threadId: "x", markerFrom: 0))
      #expect(AgentText.parse("- a %%agent%%\n") == nil)
      // Thread ids: 1 to 64 of [A-Za-z0-9_-].
      let longest = String(repeating: "a", count: 64)
      #expect(AgentText.parse("- a %%agent:\(longest)%%")?.threadId == longest)
      #expect(AgentText.parse("- a %%agent:\(longest)b%%") == nil)
      #expect(AgentText.parse("- a %%agent:%%") == nil)
      #expect(AgentText.parse("- a %%agent:thr.1%%") == nil)
      #expect(AgentText.parse("- a %%agent:agent%%")?.threadId == "agent")
      #expect(
        AgentText.parse("- a %%agent:%%agent%%")
          == AgentLine(text: "- a %%agent:", threadId: nil, markerFrom: 12))
      #expect(AgentText.parse("- a %%Agent%%") == nil)
      #expect(AgentText.parse("- a %%agent%% %%") == nil)
      #expect(AgentText.marker(threadId: nil) == "%%agent%%")
      #expect(AgentText.marker(threadId: "") == "%%agent%%")
      #expect(AgentText.marker(threadId: "thr_Ab-9") == "%%agent:thr_Ab-9%%")
    }

    @Test func keepsAgentWrittenTasksIdentityByTheirVisibleTextAndFlagsThem() {
      let tasks = TaskParser.parse(
        "- [ ] Call the restaurant to confirm %%agent:thr_9%%\n- [ ] Mine\n  - note %%agent%%")
      #expect(tasks.map(\.text) == ["Call the restaurant to confirm", "Mine"])
      #expect(tasks.map(\.agent) == [true, false])
      #expect(tasks[1].notes == ["note"])
      // `raw` keeps the marker; the task text excludes it.
      #expect(tasks[0].raw.hasSuffix("%%agent:thr_9%%"))
      let tracked = TaskTracker.track(previous: [], parsed: tasks, now: 1, idFactory: { "t" }).tasks
      #expect(tracked[0].agent)
      #expect(!tracked[1].agent)
    }

    @Test func agentMarkersInTaskTextsAndLinks() {
      let tasks = TaskParser.parse(
        "- [ ] %%agent:thr_1%%\n- [x] Read [[Note]] %%agent%%\n- [ ] a%%agent%%")
      #expect(tasks.map(\.text) == ["", "Read [[Note]]", "a"])
      #expect(tasks.map(\.agent) == [true, true, true])
      #expect(tasks[1].links == ["Note"])
      // A lone marker under a task is an empty note, as in the core.
      #expect(TaskParser.parse("- [ ] a\n  %%agent%%").first?.notes == [""])
    }
  }

  /// Mirrors the "line anchors" suite of `agent-text.test.ts`.
  struct LineAnchorTests {
    let doc = [
      "# Thursday",
      "- [ ] Book a table",
      "What's the tallest building in NYC?",
      "",
      "## Trip to Lisbon %%agent:thr_2%%",
    ].joined(separator: "\n")

    @Test func offersEveryNonBlankNonTaskLineWithoutAgentMarkers() {
      #expect(
        LineAnchors.anchorableLines(doc) == [
          AnchoredLine(line: 0, text: "# Thursday"),
          AnchoredLine(line: 2, text: "What's the tallest building in NYC?"),
          AnchoredLine(line: 4, text: "## Trip to Lisbon"),
        ])
    }

    @Test func followsALineAsTheUserEditsAroundAndInsideIt() {
      let anchors = [
        LineAnchor(anchorId: "anc_q", text: "What's the tallest building in NYC?", line: 2)
      ]
      let moved = "- [ ] New task\n\(doc)"
      #expect(
        LineAnchors.resolve(moved, anchors: anchors)["anc_q"]
          == AnchoredLine(line: 3, text: "What's the tallest building in NYC?"))
      let edited = doc.replacingOccurrences(of: "in NYC?", with: "in New York City?")
      #expect(LineAnchors.resolve(edited, anchors: anchors)["anc_q"]?.line == 2)
      let deleted = doc.replacingOccurrences(of: "What's the tallest building in NYC?\n", with: "")
      #expect(LineAnchors.resolve(deleted, anchors: anchors)["anc_q"] == nil)
    }

    @Test func crlfEmptyIdsAndRecords() {
      #expect(
        LineAnchors.anchorableLines("a\r\n\r\n  b  \r\n- [ ] t\r\n") == [
          AnchoredLine(line: 0, text: "a"), AnchoredLine(line: 2, text: "b"),
        ])
      #expect(LineAnchors.anchorableLines("").isEmpty)
      let anchors = [
        LineAnchor(anchorId: "", text: "a", line: 0),
        LineAnchor(anchorId: "anc_b", text: "b", line: 1),
      ]
      #expect(
        LineAnchors.resolve("a\nb", anchors: anchors) == ["anc_b": AnchoredLine(line: 1, text: "b")]
      )
      let record = TaskAgentRecord(
        taskId: "anc_1", notePath: "n.md", date: nil, text: "Why?", line: 3, status: .done,
        threadId: "thr_1",
        updatedAt: 0, unread: 0, anchor: .line)
      #expect(LineAnchor(record: record) == LineAnchor(anchorId: "anc_1", text: "Why?", line: 3))
    }
  }
}
