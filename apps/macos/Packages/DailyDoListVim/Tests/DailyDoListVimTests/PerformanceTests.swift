import Foundation
import Testing

import DailyDoListVim

/// Keystroke latency on a 10,000-line note: every command below runs in one `handleKey` call
/// (the host's keystroke path). Budgets hold in the unoptimized test build;
/// `PERF_BUDGET_MULTIPLIER` scales them for slow CI runners. Release numbers are in README.md.
@MainActor
@Suite(.serialized)
struct PerformanceTests {
  static let multiplier = Double(ProcessInfo.processInfo.environment["PERF_BUDGET_MULTIPLIER"] ?? "") ?? 1
  static let budgetMilliseconds = 1.0

  static let note: String = (0..<10_000).map { i in
    i % 7 == 0 ? "## Section \(i / 7)" : "- [ ] Task \(i): follow up with the vendor about item \(i % 97) today"
  }.joined(separator: "\n")

  /// The 99th percentile of `samples` key presses, in milliseconds, after a warm-up.
  private func p99(_ samples: Int, setUp: (VimSession, VimTextBuffer) -> Void = { _, _ in }, _ keys: [String]) -> Double {
    let vim = Vim(scheduler: ManualVimScheduler(), isMac: false)
    let buffer = VimTextBuffer(Self.note)
    let session = buffer.attach(to: vim)
    buffer.setCursor(line: 5_000, ch: 4)
    setUp(session, buffer)
    let clock = ContinuousClock()
    var durations: [Duration] = []
    durations.reserveCapacity(samples)
    for i in 0..<(samples + 20) {
      let elapsed = clock.measure {
        for key in keys { session.handleKey(key) }
        buffer.measure()
      }
      if i >= 20 { durations.append(elapsed) }
    }
    durations.sort()
    let d = durations[Int(Double(durations.count - 1) * 0.99)].components
    return Double(d.seconds) * 1000 + Double(d.attoseconds) / 1e15
  }

  private func check(_ name: String, _ milliseconds: Double) {
    let limit = Self.budgetMilliseconds * Self.multiplier
    print(String(format: "perf handleKey %@ on 10k lines: p99 %.3f ms (budget %.1f ms)", name, milliseconds, limit))
    #expect(milliseconds < limit, "\(name) p99 \(milliseconds) ms")
  }

  @Test func j() {
    check("j", p99(500, ["j"]))
  }

  @Test func w() {
    check("w", p99(500, ["w"]))
  }

  @Test func x() {
    check("x", p99(500, ["x"]))
  }

  @Test func dd() {
    check("dd", p99(500, ["d", "d"]))
  }

  @Test func p() {
    check("p", p99(500, setUp: { session, _ in session.handleKey("y"); session.handleKey("y") }, ["p"]))
  }
}
