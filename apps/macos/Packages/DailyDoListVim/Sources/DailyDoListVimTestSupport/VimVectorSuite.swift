import DailyDoListVim
import Foundation

/// The result of replaying a vectors file: pass counts per category and every mismatch.
public struct VimVectorReport: Sendable {
  public struct Failure: Sendable {
    public let vector: VimVectorCase
    public let mismatch: VimVectorMismatch
  }

  public internal(set) var passed: [String: Int] = [:]
  public internal(set) var total: [String: Int] = [:]
  public internal(set) var excluded: [String: Int] = [:]
  public internal(set) var failures: [String: [Failure]] = [:]

  public var passedCount: Int { passed.values.reduce(0, +) }
  public var totalCount: Int { total.values.reduce(0, +) }
  public var excludedCount: Int { excluded.values.reduce(0, +) }

  /// One line per category ("motion       4640/4640") and a total.
  public func summary(title: String) -> String {
    var lines = [title]
    for category in total.keys.sorted() {
      let pass = passed[category] ?? 0, count = total[category] ?? 0
      let skipped = excluded[category].map { ", \($0) excluded" } ?? ""
      lines.append("  \(category.padding(toLength: 12, withPad: " ", startingAt: 0)) \(pass)/\(count)\(skipped)")
    }
    lines.append("  total        \(passedCount)/\(totalCount)" + (excludedCount == 0 ? "" : ", \(excludedCount) excluded"))
    return lines.joined(separator: "\n")
  }

  /// What a test records for the failures: every failure when `verbose`, otherwise the first
  /// `detailsPerCategory` of each category in detail and the names of the rest.
  public func issueMessages(verbose: Bool, detailsPerCategory: Int = 5) -> [String] {
    var messages: [String] = []
    for category in failures.keys.sorted() {
      let list = failures[category] ?? []
      for failure in verbose ? list[...] : list.prefix(detailsPerCategory) {
        messages.append(Self.describe(failure))
      }
      if !verbose && list.count > detailsPerCategory {
        let rest = list.dropFirst(detailsPerCategory)
        messages.append(
          "\(category): \(rest.count) more failing cases: \(rest.prefix(40).map(\.vector.name).joined(separator: ", "))")
      }
    }
    return messages
  }

  /// A failure in the form tests print it: the case, its steps and the differences.
  public static func describe(_ failure: Failure) -> String {
    let steps = failure.mismatch.history.enumerated().map { "    \($0.offset): \($0.element)" }.joined(separator: "\n")
    return """
      \(failure.vector.name) (step \(failure.mismatch.step))
      \(steps)
        \(failure.mismatch.differences.joined(separator: "\n  "))
      """
  }
}

extension VimVectorReplayer {
  /// Replays every case of `file` whose name contains `filter` (all when nil), skipping
  /// `exclusions` (case names).
  public func runAll(
    _ file: VimVectorFile, filter: String? = nil, exclusions: Set<String> = [],
    makeHost: (VimVectorEditorSpec) -> any VimVectorHost
  ) -> VimVectorReport {
    var report = VimVectorReport()
    for vector in file.cases {
      if let filter, !vector.name.contains(filter) { continue }
      let category = vector.category
      if exclusions.contains(vector.name) {
        report.excluded[category, default: 0] += 1
        continue
      }
      report.total[category, default: 0] += 1
      if let mismatch = run(vector, makeHost: makeHost) {
        report.failures[category, default: []].append(.init(vector: vector, mismatch: mismatch))
      } else {
        report.passed[category, default: 0] += 1
      }
    }
    return report
  }
}
