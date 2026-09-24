import DailyDoListDomain
import Foundation
import Testing

extension DomainTests {
  /// agent-text.json and merge.json.
  struct AgentTextVectorTests {
    struct LineCase: Decodable {
      let line: String
      /// `[text, threadId, markerFrom]`.
      let parsed: Parsed?
      let stripped: String
      /// `[threadId, markAgentLine(line, threadId)]`.
      let marked: [Marked]

      struct Parsed: Decodable {
        let text: String
        let threadId: String?
        let markerFrom: Int
        init(from decoder: Decoder) throws {
          var t = try Tuple(decoder)
          text = try t.next()
          threadId = try t.optional()
          markerFrom = try t.next()
        }
      }

      struct Marked: Decodable {
        let threadId: String?
        let result: String
        init(from decoder: Decoder) throws {
          var t = try Tuple(decoder)
          threadId = try t.optional()
          result = try t.next()
        }
      }
    }

    struct Task: Decodable {
      let line: Int
      let text: String
      let raw: String
      let textFrom: Int
      let notes: [String]
      let links: [String]
      let agent: Bool

      func matches(_ t: ParsedTask) -> Bool {
        t.line == line && same(t.text, text) && same(t.raw, raw) && t.textFrom == textFrom && same(t.notes, notes)
          && same(t.links, links) && t.agent == agent
      }
    }

    struct Line: Decodable {
      let line: Int
      let text: String
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        line = try t.next()
        text = try t.next()
      }
    }

    struct Document: Decodable {
      let doc: String
      let tasks: [Task]
      let anchorable: [Line]
    }

    struct AnchorCase: Decodable {
      let doc: String
      let anchors: [Anchor]
      let resolved: [String: Line]

      struct Anchor: Decodable {
        let anchorId: String
        let text: String
        let line: Int
        init(from decoder: Decoder) throws {
          var t = try Tuple(decoder)
          anchorId = try t.next()
          text = try t.next()
          line = try t.next()
        }
      }
    }

    struct File: Decodable {
      let lines: [LineCase]
      let markers: [LineCase.Marked]
      let documents: [Document]
      let anchors: [AnchorCase]
    }

    @Test func agentMarkers() throws {
      let file = try Vectors.load("agent-text.json", as: File.self)
      var check = VectorCheck("agent-text.json lines")
      var agentLines = 0
      for c in file.lines {
        let parsed = AgentText.parse(c.line)
        if parsed != nil { agentLines += 1 }
        let parsedMatches =
          switch (parsed, c.parsed) {
          case (nil, nil): true
          case (let a?, let b?): same(a.text, b.text) && same(a.threadId, b.threadId) && a.markerFrom == b.markerFrom
          default: false
          }
        check.expect(parsedMatches, "parse(\(c.line.debug)) = \(String(describing: parsed))")
        check.expect(AgentText.isAgentLine(c.line) == (c.parsed != nil), "isAgentLine(\(c.line.debug))")
        check.expect(same(AgentText.stripMarker(c.line), c.stripped), "stripMarker(\(c.line.debug))")
        for marked in c.marked {
          let actual = AgentText.markLine(c.line, threadId: marked.threadId)
          check.expect(same(actual, marked.result), "markLine(\(c.line.debug), \(String(describing: marked.threadId))) = \(actual.debug)")
        }
      }
      for marker in file.markers {
        check.expect(same(AgentText.marker(threadId: marker.threadId), marker.result), "marker(\(String(describing: marker.threadId)))")
      }
      check.verify(atLeast: 1_000)
      #expect(agentLines >= 60)
    }

    @Test func agentTasksAndAnchorableLines() throws {
      let file = try Vectors.load("agent-text.json", as: File.self)
      var check = VectorCheck("agent-text.json documents")
      for document in file.documents {
        let tasks = TaskParser.parse(document.doc)
        let first = zip(document.tasks, tasks).first { !$0.matches($1) }.map { "expected \($0) got \($1)" }
        check.expect(
          tasks.count == document.tasks.count && zip(document.tasks, tasks).allSatisfy { $0.matches($1) },
          "\(document.doc.debug): \(first ?? "\(tasks.count) vs \(document.tasks.count) tasks")")
        let lines = LineAnchors.anchorableLines(document.doc)
        check.expect(
          lines.count == document.anchorable.count
            && zip(lines, document.anchorable).allSatisfy { $0.line == $1.line && same($0.text, $1.text) },
          "anchorableLines(\(document.doc.debug)) = \(lines)")
      }
      check.verify(atLeast: 150)
    }

    @Test func resolveLineAnchors() throws {
      let file = try Vectors.load("agent-text.json", as: File.self)
      var check = VectorCheck("agent-text.json anchors")
      for c in file.anchors {
        let anchors = c.anchors.map { LineAnchor(anchorId: $0.anchorId, text: $0.text, line: $0.line) }
        let actual = LineAnchors.resolve(c.doc, anchors: anchors)
        let matches =
          actual.count == c.resolved.count
          && actual.allSatisfy { id, where_ in
            c.resolved[id].map { $0.line == where_.line && same($0.text, where_.text) } ?? false
          }
        check.expect(matches, "resolve(\(c.doc.debug)) = \(actual)")
      }
      check.verify(atLeast: 200)
    }

    struct MergeFile: Decodable {
      let diffs: [Diff]
      let merges: [Merge]

      struct Diff: Decodable {
        let a: [String]
        let b: [String]
        let hunks: [Hunk]
      }

      struct Hunk: Decodable {
        let start: Int
        let end: Int
        let lines: [String]
        init(from decoder: Decoder) throws {
          var t = try Tuple(decoder)
          start = try t.next()
          end = try t.next()
          lines = try t.next()
        }
      }

      struct Merge: Decodable {
        let base: String
        let local: String
        let remote: String
        let text: String
        let conflict: Bool
      }
    }

    @Test func diffsAndMerges() throws {
      let file = try Vectors.load("merge.json", as: MergeFile.self)
      var check = VectorCheck("merge.json")
      for c in file.diffs {
        let hunks = TextMerge.diffLines(c.a, c.b)
        check.expect(
          hunks.count == c.hunks.count
            && zip(hunks, c.hunks).allSatisfy { $0.start == $1.start && $0.end == $1.end && same($0.lines, $1.lines) },
          "diffLines(\(c.a), \(c.b)) = \(hunks)")
      }
      var conflicts = 0
      for c in file.merges {
        let merged = TextMerge.merge(base: c.base, local: c.local, remote: c.remote)
        if c.conflict { conflicts += 1 }
        check.expect(
          same(merged.text, c.text) && merged.conflict == c.conflict,
          "merge(\(c.base.debug), \(c.local.debug), \(c.remote.debug)) = \(merged)")
      }
      check.verify(atLeast: 600)
      #expect(conflicts >= 20)
    }
  }
}
