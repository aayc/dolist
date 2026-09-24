import DailyDoListDomain
import Foundation
import Testing

extension DomainTests {
  /// tasks.json, tracker.json and anchors.json.
  struct TasksVectorTests {
    struct ExpectedTask: Decodable {
      let line: Int
      let indent: Int
      let depth: Int
      let marker: String
      let statusChar: String
      let status: String
      let text: String
      let raw: String
      let from: Int
      let to: Int
      let textFrom: Int
      let parentLine: Int?
      let notes: [String]
      let links: [String]

      func matches(_ t: ParsedTask) -> Bool {
        t.line == line && t.indent == indent && t.depth == depth && same(t.marker, marker)
          && same(t.statusChar, statusChar) && t.status.rawValue == status && same(t.text, text)
          && same(t.raw, raw) && t.from == from && t.to == to && t.textFrom == textFrom
          && t.parentLine == parentLine && same(t.notes, notes) && same(t.links, links)
      }
    }

    struct Document: Decodable {
      let name: String
      let doc: String
      let tasks: [ExpectedTask]
    }

    struct LineCase: Decodable {
      let line: String
      let isTask: Bool
      let toggled: String
      let setStatus: [[String]]
    }

    struct TextBool: Decodable {
      let text: String
      let value: Bool
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        text = try t.next()
        value = try t.next()
      }
    }

    struct StatusCase: Decodable {
      let status: String
      let char: String
      let closed: Bool
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        status = try t.next()
        char = try t.next()
        closed = try t.next()
      }
    }

    struct File: Decodable {
      let documents: [Document]
      let lines: [LineCase]
      let blank: [TextBool]
      let statusFromChar: [[String]]
      let statuses: [StatusCase]
    }

    @Test func parseTasks() throws {
      let file = try Vectors.load("tasks.json", as: File.self)
      var check = VectorCheck("tasks.json documents")
      var generated = 0
      var nonASCII = 0
      for document in file.documents {
        if document.name.hasPrefix("generated") { generated += 1 }
        if !document.doc.unicodeScalars.allSatisfy(\.isASCII) { nonASCII += 1 }
        let actual = TaskParser.parse(document.doc)
        let ok = actual.count == document.tasks.count && zip(document.tasks, actual).allSatisfy { $0.matches($1) }
        let firstDifference = zip(document.tasks, actual).first { !$0.matches($1) }.map { "expected \($0) got \($1)" }
        check.expect(ok, "\(document.name) \(document.doc.debug): \(actual.count) vs \(document.tasks.count) tasks; \(firstDifference ?? "")")
      }
      check.verify(atLeast: 250)
      #expect(generated >= 200)
      #expect(nonASCII >= 50)
    }

    @Test func lineHelpers() throws {
      let file = try Vectors.load("tasks.json", as: File.self)
      var check = VectorCheck("tasks.json lines")
      for c in file.lines {
        check.expect(TaskParser.isTaskLine(c.line) == c.isTask, "isTaskLine(\(c.line.debug))")
        let toggled = TaskParser.toggleLine(c.line)
        check.expect(same(toggled, c.toggled), "toggleLine(\(c.line.debug)) = \(toggled.debug)")
        for pair in c.setStatus {
          let actual = TaskParser.setStatusChar(pair[0], onLine: c.line)
          check.expect(same(actual, pair[1]), "setStatusChar(\(pair[0].debug), \(c.line.debug)) = \(actual.debug)")
        }
      }
      for c in file.blank {
        check.expect(TaskParser.isBlankTaskText(c.text) == c.value, "isBlankTaskText(\(c.text.debug))")
      }
      for pair in file.statusFromChar {
        let status = TaskStatus(statusChar: pair[0])
        check.expect(status.rawValue == pair[1], "TaskStatus(statusChar: \(pair[0].debug)) = \(status)")
      }
      for c in file.statuses {
        let status = try #require(TaskStatus(rawValue: c.status))
        check.expect(status.statusChar == c.char, "\(status).statusChar")
        check.expect(status.isClosed == c.closed, "\(status).isClosed")
      }
      check.verify(atLeast: 100)
    }

    struct Row: Decodable {
      let id: String
      let text: String
      let status: String
      let line: Int
      let depth: Int
      let parentId: String?
      let notes: [String]
      let firstSeenAt: Double
      let updatedAt: Double

      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        id = try t.next()
        text = try t.next()
        status = try t.next()
        line = try t.next()
        depth = try t.next()
        parentId = try t.optional()
        notes = try t.next()
        firstSeenAt = try t.next()
        updatedAt = try t.next()
      }

      func matches(_ t: TrackedTask) -> Bool {
        same(t.id, id) && same(t.text, text) && t.status.rawValue == status && t.line == line && t.depth == depth
          && same(t.parentId, parentId) && same(t.notes, notes) && t.firstSeenAt == firstSeenAt
          && t.updatedAt == updatedAt
      }
    }

    struct Diff: Decodable {
      let added: [String]
      let updated: [Update]
      let statusChanged: [String]
      let removed: [String]

      struct Update: Decodable {
        let id: String
        let changes: [String]
        init(from decoder: Decoder) throws {
          var t = try Tuple(decoder)
          id = try t.next()
          changes = try t.next()
        }
      }
    }

    struct Step: Decodable {
      let doc: String
      let now: Double
      /// Full rows, or only `ids` for large documents.
      let tasks: [Row]?
      let ids: [String]?
      let diff: Diff
    }

    struct Sequence: Decodable {
      let name: String
      let similarityThreshold: Double?
      let steps: [Step]
    }

    struct TrackerFile: Decodable {
      let sequences: [Sequence]
    }

    @Test func trackTasks() throws {
      let file = try Vectors.load("tracker.json", as: TrackerFile.self)
      var check = VectorCheck("tracker.json")
      for sequence in file.sequences {
        var counter = 0
        var state: [TrackedTask] = []
        for (index, step) in sequence.steps.enumerated() {
          let result = TaskTracker.track(
            previous: state, parsed: TaskParser.parse(step.doc), now: step.now,
            similarityThreshold: sequence.similarityThreshold ?? TaskTracker.defaultSimilarityThreshold,
            idFactory: {
              counter += 1
              return "t\(counter)"
            })
          let label = "\(sequence.name) step \(index)"
          if let rows = step.tasks {
            let tasksMatch = result.tasks.count == rows.count && zip(rows, result.tasks).allSatisfy { $0.matches($1) }
            check.expect(tasksMatch, "\(label): tasks \(result.tasks.map(\.id)) ≠ \(rows.map(\.id))")
          } else {
            let ids = result.tasks.map(\.id)
            let firstDifference = zip(ids, step.ids ?? []).enumerated().first { $1.0 != $1.1 }
            check.expect(ids == step.ids, "\(label): ids differ at \(String(describing: firstDifference))")
          }

          // The diff reports the same task values as the result and the previous state.
          let byId = Dictionary(result.tasks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
          let previousById = Dictionary(state.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
          let diff = result.diff
          check.expect(diff.added.map(\.id) == step.diff.added, "\(label): added \(diff.added.map(\.id))")
          check.expect(diff.added.allSatisfy { byId[$0.id] == $0 }, "\(label): added values")
          check.expect(
            diff.updated.map(\.task.id) == step.diff.updated.map(\.id)
              && zip(diff.updated, step.diff.updated).allSatisfy { $0.changes.map(\.rawValue) == $1.changes },
            "\(label): updated \(diff.updated.map { ($0.task.id, $0.changes) })")
          check.expect(
            diff.updated.allSatisfy { byId[$0.task.id] == $0.task && previousById[$0.task.id] == $0.previous },
            "\(label): updated values")
          check.expect(
            diff.statusChanged.map(\.task.id) == step.diff.statusChanged, "\(label): statusChanged")
          check.expect(
            diff.statusChanged.allSatisfy { byId[$0.task.id] == $0.task && previousById[$0.task.id] == $0.previous },
            "\(label): statusChanged values")
          check.expect(diff.removed.map(\.id) == step.diff.removed, "\(label): removed \(diff.removed.map(\.id))")
          check.expect(diff.removed.allSatisfy { previousById[$0.id] == $0 }, "\(label): removed values")
          state = result.tasks
        }
      }
      check.verify(atLeast: 500)
    }

    struct AnchorCase: Decodable {
      let name: String
      let doc: String
      let anchors: [Anchor]
      let resolved: [String: Int]

      struct Anchor: Decodable {
        let taskId: String
        let text: String
        let line: Int
        init(from decoder: Decoder) throws {
          var t = try Tuple(decoder)
          taskId = try t.next()
          text = try t.next()
          line = try t.next()
        }
      }
    }

    struct AnchorFile: Decodable {
      let cases: [AnchorCase]
    }

    @Test func resolveAnchors() throws {
      let file = try Vectors.load("anchors.json", as: AnchorFile.self)
      var check = VectorCheck("anchors.json")
      for c in file.cases {
        let anchors = c.anchors.map { TaskAnchor(taskId: $0.taskId, text: $0.text, line: $0.line) }
        let actual = TaskAnchors.resolve(c.doc, anchors: anchors)
        check.expect(actual == c.resolved, "\(c.name): \(actual) ≠ \(c.resolved)")
        let fromTasks = TaskAnchors.resolve(tasks: TaskParser.parse(c.doc), anchors: anchors)
        check.expect(fromTasks == actual, "\(c.name): resolve(tasks:) differs")
      }
      check.verify(atLeast: 80)
    }
  }
}
