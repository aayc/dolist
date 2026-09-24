import DailyDoListDomain
import Foundation
import Testing

extension DomainTests {
  /// Hot paths that run on every save (parse + track) or keystroke (anchor resolution), with the
  /// same note shape as the core's `tasks.bench.ts`. Budgets hold in the unoptimized test build;
  /// `PERF_BUDGET_MULTIPLIER` scales them for slow CI runners. Release numbers are in README.md.
  @Suite(.serialized)
  struct PerformanceTests {
    static let multiplier =
      Double(ProcessInfo.processInfo.environment["PERF_BUDGET_MULTIPLIER"] ?? "") ?? 1

    /// 2,000 lines: headings, notes under tasks, and tasks (a quarter of them done).
    static func makeNote(lines: Int) -> String {
      (0..<lines).map { i in
        if i % 10 == 0 { return "## Section \(i / 10)" }
        if i % 3 == 0 { return "  - note line \(i) with some context about the task above" }
        return "- [\(i % 4 == 0 ? "x" : " ")] Task number \(i): follow up with vendor \(i % 17)"
      }.joined(separator: "\n")
    }

    static let note = makeNote(lines: 2000)
    static let parsed = TaskParser.parse(note)
    static let tracked = TaskTracker.track(previous: [], parsed: parsed, now: 0).tasks
    static let edited = TaskParser.parse(
      note.replacingOccurrences(of: "Task number 502:", with: "Task number 502 (edited):"))
    static let anchors = tracked.prefix(50).map {
      TaskAnchor(taskId: $0.id, text: $0.text, line: $0.line)
    }

    /// Median wall time of `runs` calls after a warm-up call, in milliseconds.
    static func median(runs: Int = 11, _ body: () -> Void) -> Double {
      body()
      let clock = ContinuousClock()
      let samples = (0..<runs).map { _ in clock.measure(body) }.sorted()
      let d = samples[runs / 2].components
      return Double(d.seconds) * 1000 + Double(d.attoseconds) / 1e15
    }

    /// The best of up to three medians: the other suites run concurrently (decoding megabytes of
    /// vectors), so a slow first median gets a second chance once the machine is quieter.
    static func check(_ name: String, budget: Double, _ body: () -> Void) async {
      let limit = budget * multiplier
      var best = Double.infinity
      for attempt in 0..<3 {
        best = min(best, median(body))
        if best < limit { break }
        if attempt < 2 { try? await Task.sleep(for: .milliseconds(500)) }
      }
      print(String(format: "perf %@: %.3f ms (budget %.1f ms)", name, best, limit))
      #expect(best < limit, "\(name) took \(best) ms")
    }

    @Test func parseTwoThousandLines() async {
      #expect(Self.parsed.count > 1000)
      await Self.check("parseTasks 2k lines", budget: 5) { _ = TaskParser.parse(Self.note) }
    }

    @Test func trackOneEdit() async {
      let result = TaskTracker.track(previous: Self.tracked, parsed: Self.edited, now: 1)
      #expect(
        result.diff.updated.count == 1 && result.diff.added.isEmpty && result.diff.removed.isEmpty)
      await Self.check("trackTasks 2k lines, one edit", budget: 15) {
        _ = TaskTracker.track(previous: Self.tracked, parsed: Self.edited, now: 1)
      }
    }

    @Test func resolveFiftyAnchors() async {
      let doc = Self.note.replacingOccurrences(
        of: "Task number 5:", with: "Task number 5 (edited):")
      #expect(TaskAnchors.resolve(doc, anchors: Self.anchors).count == 50)
      await Self.check("resolveTaskAnchors 50 anchors, 2k lines", budget: 15) {
        _ = TaskAnchors.resolve(doc, anchors: Self.anchors)
      }
    }
  }
}
