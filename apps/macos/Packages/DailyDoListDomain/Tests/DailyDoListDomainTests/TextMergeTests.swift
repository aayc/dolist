import DailyDoListDomain
import Foundation
import Testing

extension DomainTests {
  /// The properties of @ddl/core's merge tests over a seeded generator (the core's examples are in
  /// merge.json), plus `TextMerge.lines` and a large rewrite.
  struct TextMergeTests {
    @Test func applyingTheHunksToTheOldLinesGivesTheNewOnes() {
      var generator = SeededGenerator(seed: 11)
      for _ in 0..<400 {
        let a = randomLines(from: ["a", "b", "c", "d"], maxCount: 30, using: &generator)
        let b = randomLines(from: ["a", "b", "c", "d"], maxCount: 30, using: &generator)
        var out: [String] = []
        var at = 0
        for hunk in TextMerge.diffLines(a, b) {
          #expect(hunk.start >= at)
          out += a[at..<hunk.start] + hunk.lines
          at = hunk.end
        }
        out += a[at...]
        #expect(out == b, "\(a) → \(b)")
      }
    }

    @Test func aCarriageReturnStaysPartOfItsLine() {
      #expect(TextMerge.lines("a\r\nb\n") == ["a\r", "b", ""])
    }

    static let lineChoices = ["- [ ] a", "- [ ] b", "text", "", "## h", "  - note"]

    @Test func anUnchangedSideTakesTheOtherSidesText() {
      var generator = SeededGenerator(seed: 12)
      for _ in 0..<300 {
        let base = randomLines(from: Self.lineChoices, maxCount: 12, using: &generator).joined(
          separator: "\n")
        let other = randomLines(from: Self.lineChoices, maxCount: 12, using: &generator).joined(
          separator: "\n")
        #expect(
          TextMerge.merge(base: base, local: base, remote: other)
            == MergeResult(text: other, conflict: false))
        #expect(
          TextMerge.merge(base: base, local: other, remote: base)
            == MergeResult(text: other, conflict: false))
        #expect(
          TextMerge.merge(base: base, local: other, remote: other)
            == MergeResult(text: other, conflict: false))
      }
    }

    /// Base lines are unique here: with repeated lines a deletion can align with another copy (a
    /// case in merge.json).
    @Test func editsToSeparateHalvesOfANoteMergeIntoBothEdits() {
      var generator = SeededGenerator(seed: 13)
      var checked = 0
      while checked < 300 {
        let lines = randomLines(
          from: Self.lineChoices, minCount: 2, maxCount: 12, using: &generator
        )
        .enumerated().map { "\($1) #\($0)" }
        let half = lines.count / 2
        let i = Int.random(in: 0..<half, using: &generator)
        let j = half + Int.random(in: 0..<(lines.count - half), using: &generator)
        guard j > i + 1 else { continue }
        checked += 1
        let localNew = randomLines(from: Self.lineChoices, maxCount: 3, using: &generator)
        let remoteNew = randomLines(from: Self.lineChoices, maxCount: 3, using: &generator)
        // The local side rewrites one line in the first half, the remote side one in the second.
        let local = Array(lines[..<i]) + localNew + Array(lines[(i + 1)...])
        let remote = Array(lines[..<j]) + remoteNew + Array(lines[(j + 1)...])
        let expected =
          Array(lines[..<i]) + localNew + Array(lines[(i + 1)..<j]) + remoteNew
          + Array(lines[(j + 1)...])
        let merged = TextMerge.merge(
          base: lines.joined(separator: "\n"), local: local.joined(separator: "\n"),
          remote: remote.joined(separator: "\n"))
        #expect(!merged.conflict, "\(lines) / \(local) / \(remote)")
        #expect(merged.text == expected.joined(separator: "\n"))
      }
    }

    @Test func largeRewritesStayLinearPastTheEditDistanceCap() {
      let a = (0..<3_000).map { "line \($0)" }
      let b = (0..<3_000).map { "other \($0)" }
      #expect(TextMerge.diffLines(a, b) == [LineHunk(start: 0, end: 3_000, lines: b)])
      let base = a.joined(separator: "\n")
      let local = (["top"] + a).joined(separator: "\n")
      let remote = (a + ["bottom"]).joined(separator: "\n")
      #expect(
        TextMerge.merge(base: base, local: local, remote: remote).text
          == (["top"] + a + ["bottom"]).joined(separator: "\n"))
    }

    // MARK: Properties (mirrors @ddl/core `merge.property.test.ts`)

    /// A note whose lines are unique (blank lines aside), edited on both sides with new lines that
    /// are unique too, so where each merged line came from is unambiguous.
    private struct Triple {
      var base: [String]
      var local: [String]
      var remote: [String]
      var merged: MergeResult {
        TextMerge.merge(
          base: base.joined(separator: "\n"), local: local.joined(separator: "\n"),
          remote: remote.joined(separator: "\n"))
      }
      var typed: Set<String> { Self.content(local.filter { !base.contains($0) }) }
      static func content(_ lines: [String]) -> Set<String> { Set(lines.filter { !$0.isEmpty }) }
    }

    /// `adding`: the other side (the agent, say) only adds lines and types on existing ones.
    private func randomTriples(seed: UInt64, count: Int = 500, adding: Bool = false) -> [Triple] {
      var generator = SeededGenerator(seed: seed)
      return (0..<count).map { _ in
        let base = (0..<Int.random(in: 0...14, using: &generator)).map { i in
          Bool.random(using: &generator) ? "" : "- [ ] base \(i)"
        }
        return Triple(
          base: base, local: randomlyEdited(base, side: "mine", using: &generator),
          remote: randomlyEdited(base, side: "theirs", onlyAdding: adding, using: &generator))
      }
    }

    /// Inserts, deletes, replaces (new lines in place of old ones) or edits (a word appended to
    /// lines, still similar to what they were).
    private func randomlyEdited(
      _ base: [String], side: String, onlyAdding: Bool = false,
      using generator: inout SeededGenerator
    ) -> [String] {
      var lines = base
      var n = 0
      for _ in 0..<Int.random(in: 0...4, using: &generator) {
        let at = Int.random(in: 0...lines.count, using: &generator)
        let count = Int.random(in: 1...3, using: &generator)
        let added = (0..<count).map { _ in
          defer { n += 1 }
          return "\(side) \(n)"
        }
        let removed = at..<min(lines.count, at + count)
        let kind =
          onlyAdding
          ? [0, 3][Int.random(in: 0..<2, using: &generator)]
          : Int.random(
            in: 0..<4, using: &generator)
        switch kind {
        case 0: lines.insert(contentsOf: added, at: at)
        case 1: lines.removeSubrange(removed)
        case 2: lines.replaceSubrange(removed, with: added)
        default:
          for k in removed where !lines[k].isEmpty {
            lines[k] += " \(side) \(n)"
            n += 1
          }
        }
      }
      return lines
    }

    @Test func neverBringsBackALineTheOtherSideDeletedUnlessTheUserTypedIt() {
      for triple in randomTriples(seed: 21) {
        let theirs = Triple.content(triple.remote)
        for line in Triple.content(TextMerge.lines(triple.merged.text)) {
          #expect(
            theirs.contains(line) || triple.typed.contains(line),
            "resurrected \(line): \(triple.base) / \(triple.local) / \(triple.remote)")
        }
      }
    }

    @Test func neverLosesWhatTheUserTyped() {
      for triple in randomTriples(seed: 22) {
        let out = Triple.content(TextMerge.lines(triple.merged.text))
        for line in triple.typed {
          #expect(out.contains(line), "lost \(line): \(triple.base) / \(triple.local)")
        }
      }
    }

    @Test func keepsALineTheUserDeletedDeletedAndWithoutAConflictEverythingTheOtherSideAdded() {
      for triple in randomTriples(seed: 23) {
        let merged = triple.merged
        let out = Triple.content(TextMerge.lines(merged.text))
        for line in Triple.content(triple.base)
        where !triple.local.contains(line) && triple.remote.contains(line) {
          #expect(!out.contains(line), "undeleted \(line)")
        }
        guard !merged.conflict else { continue }
        for line in Triple.content(triple.remote.filter { !triple.base.contains($0) }) {
          #expect(out.contains(line), "dropped \(line)")
        }
      }
    }

    @Test func keepsEveryLineTheOtherSideAddedNextToLinesItTypedOnWhateverTheUserDid() {
      for triple in randomTriples(seed: 24, adding: true) {
        let out = Triple.content(TextMerge.lines(triple.merged.text))
        for line in triple.remote where line.hasPrefix("theirs") {
          #expect(out.contains(line), "dropped \(line): \(triple.base) / \(triple.local)")
        }
      }
    }

    private func randomLines(
      from choices: [String], minCount: Int = 0, maxCount: Int,
      using generator: inout SeededGenerator
    ) -> [String] {
      (0..<Int.random(in: minCount...maxCount, using: &generator)).map { _ in
        choices[Int.random(in: 0..<choices.count, using: &generator)]
      }
    }
  }
}
