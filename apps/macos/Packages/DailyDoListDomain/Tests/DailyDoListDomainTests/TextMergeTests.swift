import DailyDoListDomain
import Foundation
import Testing

extension DomainTests {
  /// Mirrors @ddl/core `merge.test.ts`; the property tests draw from a seeded generator.
  struct TextMergeTests {
    private func note(_ lines: String...) -> String { lines.joined(separator: "\n") }

    @Test func describesInsertionsDeletionsAndReplacementsAsHunksOverTheOldLines() {
      #expect(TextMerge.diffLines(["a", "b", "c"], ["a", "b", "c"]).isEmpty)
      #expect(
        TextMerge.diffLines(["a", "c"], ["a", "b", "c"]) == [
          LineHunk(start: 1, end: 1, lines: ["b"])
        ])
      #expect(
        TextMerge.diffLines(["a", "b", "c"], ["a", "c"]) == [LineHunk(start: 1, end: 2, lines: [])])
      #expect(
        TextMerge.diffLines(["a", "b", "c"], ["a", "B", "c"]) == [
          LineHunk(start: 1, end: 2, lines: ["B"])
        ])
      #expect(TextMerge.diffLines([], ["x"]) == [LineHunk(start: 0, end: 0, lines: ["x"])])
    }

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

    @Test func linesCompareByCodeUnits() {
      // NFC and NFD spellings are different lines, like in JavaScript.
      #expect(
        TextMerge.diffLines(["caf\u{E9}"], ["cafe\u{301}"]) == [
          LineHunk(start: 0, end: 1, lines: ["cafe\u{301}"])
        ])
      let merged = TextMerge.merge(
        base: "caf\u{E9}\nx", local: "caf\u{E9}\ny", remote: "cafe\u{301}\nx")
      #expect(merged == MergeResult(text: "cafe\u{301}\ny", conflict: false))
      #expect(merged.text.unicodeScalars.count == 7)
      // `\r` stays part of its line.
      #expect(TextMerge.lines("a\r\nb\n") == ["a\r", "b", ""])
    }

    let base = "# Thursday\n- [ ] Book a table\n- [ ] Renew passport\nNotes"

    @Test func keepsTheAgentsLinesAndTheUsersTypingWhenTheyTouchDifferentLines() {
      let local = note("# Thursday", "- [ ] Book a table for two", "- [ ] Renew passport", "Notes")
      let remote = note(
        "# Thursday", "- [ ] Book a table", "  - Trattoria Sole has a table at 7pm %%agent:thr_1%%",
        "- [ ] Renew passport", "Notes")
      #expect(
        TextMerge.merge(base: base, local: local, remote: remote)
          == MergeResult(
            text: note(
              "# Thursday", "- [ ] Book a table for two",
              "  - Trattoria Sole has a table at 7pm %%agent:thr_1%%",
              "- [ ] Renew passport", "Notes"),
            conflict: false))
    }

    @Test func keepsBothWhenBothSidesAddLinesAtTheSamePlaceTheUsersFirst() {
      let local = "\(base)\n- [ ] Call mom"
      let remote = "\(base)\n- Found 3 flights %%agent%%"
      #expect(
        TextMerge.merge(base: base, local: local, remote: remote)
          == MergeResult(
            text: "\(base)\n- [ ] Call mom\n- Found 3 flights %%agent%%", conflict: false))
    }

    @Test func takesIdenticalChangesOnce() {
      let both = note("# Thursday", "- [x] Book a table", "- [ ] Renew passport", "Notes")
      #expect(
        TextMerge.merge(base: base, local: both, remote: both)
          == MergeResult(text: both, conflict: false))
    }

    @Test func reportsAConflictWhenBothSidesRewriteTheSameLineKeepingTheUsers() {
      let local = note("# Thursday", "- [ ] Book a table for 4", "- [ ] Renew passport", "Notes")
      let remote = note("# Thursday", "- [x] Book a table", "- [ ] Renew passport", "Notes")
      #expect(
        TextMerge.merge(base: base, local: local, remote: remote)
          == MergeResult(text: local, conflict: true))
    }

    @Test func keepsLinesDeletedElsewhereDeletedWhenTheUserAddedALineBetweenThem() {
      let day = note("# Thursday", "- [ ] Rehearsal", "\t- Done: 11 bots %%agent:thr_1%%", "Notes")
      let local = note(
        "# Thursday", "- [ ] Rehearsal", "\t- ask about the 3 missing ones",
        "\t- Done: 11 bots %%agent:thr_1%%", "Notes")
      let remote = note("# Thursday", "Notes")
      #expect(
        TextMerge.merge(base: day, local: local, remote: remote)
          == MergeResult(
            text: note("# Thursday", "\t- ask about the 3 missing ones", "Notes"), conflict: false))
    }

    var withAgentLine: String {
      note(
        "# Thursday", "- [ ] Book a table", "  - Sole at 7 %%agent:thr_1%%", "- [ ] Renew passport",
        "Notes")
    }

    @Test func keepsTheOtherSidesLineWhereItAddedItBetweenLinesTheUserEdited() {
      let local = note("# Thursday", "- [x] Book a table", "- [x] Renew passport", "Notes")
      #expect(
        TextMerge.merge(base: base, local: local, remote: withAgentLine)
          == MergeResult(
            text: note(
              "# Thursday", "- [x] Book a table", "  - Sole at 7 %%agent:thr_1%%",
              "- [x] Renew passport", "Notes"),
            conflict: false))
    }

    @Test func keepsTheOtherSidesLinesAddedInsideABlockTheUserRewroteAfterIt() {
      let local = note("# Thursday", "- [ ] Call the dentist", "- [ ] Water the plants", "Notes")
      #expect(
        TextMerge.merge(base: base, local: local, remote: withAgentLine)
          == MergeResult(
            text: note(
              "# Thursday", "- [ ] Call the dentist", "- [ ] Water the plants",
              "  - Sole at 7 %%agent:thr_1%%", "Notes"),
            conflict: false))
    }

    // A diff reports "line edited, line added under it" as one replaced block; the web fuzz
    // test's shrunk counterexamples (two tabs, the agent adding a line) are these two merges.
    @Test func takesTheSameEditOnceAndKeepsTheLineTheOtherSideAddedUnderIt() {
      #expect(
        TextMerge.merge(base: "- [ ] start", local: "- [ ]", remote: "- [ ]\n- a3 %%agent%%")
          == MergeResult(text: "- [ ]\n- a3 %%agent%%", conflict: false))
    }

    @Test func keepsTheLineTheOtherSideAddedUnderALineBothEdited() {
      #expect(
        TextMerge.merge(
          base: "- [ ] start", local: "- [ ] start c1e1",
          remote: "- [ ] start c0e0\n- a3 %%agent%%")
          == MergeResult(text: "- [ ] start c1e1\n- a3 %%agent%%", conflict: true))
    }

    @Test func keepsTheOtherSidesNewLinesInsideABlockBothChangedAfterTheUsersLines() {
      let local = note("# Thursday", "- [ ] Book a table for 4", "- [ ] Renew it", "Notes")
      let remote = note(
        "# Thursday", "- [x] Book a table", "  - Sole at 7 %%agent:thr_1%%", "- [ ] Renew passport",
        "Notes")
      #expect(
        TextMerge.merge(base: base, local: local, remote: remote)
          == MergeResult(
            text: note(
              "# Thursday", "- [ ] Book a table for 4", "  - Sole at 7 %%agent:thr_1%%",
              "- [ ] Renew it", "Notes"),
            conflict: true))
    }

    @Test func doesntBringBackLinesDeletedElsewhereWhenTheSameLineConflicts() {
      let local = note("# Thursday", "- [ ] Book a table for 4", "- [ ] Renew passport", "Notes")
      let remote = note("# Thursday", "- [x] Book a table", "Notes")
      #expect(
        TextMerge.merge(base: base, local: local, remote: remote)
          == MergeResult(
            text: note("# Thursday", "- [ ] Book a table for 4", "Notes"), conflict: true)
      )
    }

    @Test func keepsOnlyTheUsersOwnLinesOfABlockBothSidesChanged() {
      let local = note("# Thursday", "- [ ] Book a table", "- [ ] Renew passport by May", "Notes")
      let remote = note("# Thursday", "Notes")
      #expect(
        TextMerge.merge(base: base, local: local, remote: remote)
          == MergeResult(
            text: note("# Thursday", "- [ ] Renew passport by May", "Notes"), conflict: true))
    }

    @Test func appliesADeletionNextToAnEdit() {
      let local = note("# Thursday", "- [ ] Book a table", "- [ ] Renew passport", "Notes!")
      let remote = note("# Thursday", "- [ ] Renew passport", "Notes")
      #expect(
        TextMerge.merge(base: base, local: local, remote: remote)
          == MergeResult(
            text: note("# Thursday", "- [ ] Renew passport", "Notes!"), conflict: false))
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

    /// Base lines are unique here: with repeated lines a deletion can align with another copy (see
    /// `aDeletionAmongIdenticalLinesCanAlignWithTheOtherSidesEdit`).
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

    /// Same answer as @ddl/core: the local side deleted one of four identical lines and the diff
    /// takes it to be the last, which the remote side turned into three lines: one edit of it (the
    /// deletion wins, a conflict) and two added lines, which stay.
    @Test func aDeletionAmongIdenticalLinesCanAlignWithTheOtherSidesEdit() {
      let base = note(
        "  - note", "- [ ] b", "- [ ] b", "- [ ] b", "- [ ] b", "", "## h", "- [ ] b", "- [ ] a")
      let local = note(
        "  - note", "- [ ] b", "- [ ] b", "- [ ] b", "", "## h", "- [ ] b", "- [ ] a")
      let remote = note(
        "  - note", "- [ ] b", "- [ ] b", "- [ ] b", "- [ ] a", "text", "- [ ] a", "", "## h",
        "- [ ] b", "- [ ] a")
      #expect(
        TextMerge.merge(base: base, local: local, remote: remote)
          == MergeResult(
            text: note(
              "  - note", "- [ ] b", "- [ ] b", "- [ ] b", "- [ ] a", "text", "", "## h", "- [ ] b",
              "- [ ] a"),
            conflict: true))
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
