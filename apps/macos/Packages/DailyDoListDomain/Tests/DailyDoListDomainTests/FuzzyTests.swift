import DailyDoListDomain
import Testing

extension DomainTests {
  struct FuzzyTests {
    private func ranked(_ query: String, _ candidates: [String]) -> [String] {
      Fuzzy.rank(query: query, candidates: candidates).map(\.element)
    }

    @Test func subsequencesMatchCaseInsensitively() throws {
      let match = try #require(Fuzzy.match("gdn", in: "Garden"))
      #expect(match.matchedOffsets == [0, 3, 5])
      #expect(Fuzzy.match("xyz", in: "Garden Redesign") == nil)
      #expect(Fuzzy.match("gardens", in: "Garden") == nil)
      #expect(Fuzzy.match("gar red", in: "Garden Redesign") != nil)  // whitespace is ignored
      #expect(Fuzzy.match("  ", in: "anything") == FuzzyMatch(score: 0, matchedOffsets: []))
      // Case-insensitive, but accents are letters of their own.
      #expect(Fuzzy.match("CAFÉ", in: "café") != nil)
      #expect(Fuzzy.match("cafe", in: "Café") == nil)
    }

    @Test func highlightsUTF16Offsets() {
      #expect(Fuzzy.match("😀", in: "a😀b")?.matchedOffsets == [1, 2])
      #expect(Fuzzy.match("ist", in: "İstanbul notes")?.matchedOffsets == [0, 1, 2])
      #expect(Fuzzy.match("日本", in: "今日は日本")?.matchedOffsets == [3, 4])
    }

    @Test func prefersWordStarts() {
      #expect(Fuzzy.match("gr", in: "Garden Redesign")?.matchedOffsets == [0, 7])
      #expect(Fuzzy.match("dn", in: "Daily/2026-09-23 notes")?.matchedOffsets == [0, 17])
      #expect(Fuzzy.match("fb", in: "fooBar")?.matchedOffsets == [0, 3])  // camelCase hump
      let commands = [
        "Open today's daily note", "Toggle agent panel", "Toggle light/dark theme", "Open settings",
      ]
      #expect(ranked("tap", commands).first == "Toggle agent panel")
      #expect(ranked("theme", commands).first == "Toggle light/dark theme")
    }

    @Test func contiguousBeatsScattered() throws {
      let prefix = try #require(Fuzzy.match("gro", in: "Grocery list"))
      let scattered = try #require(Fuzzy.match("gro", in: "Garden Redesign Overview"))
      #expect(prefix.score > scattered.score)
      let run = try #require(Fuzzy.match("plan", in: "xx plan yy"))
      let spread = try #require(Fuzzy.match("plan", in: "xpxlxaxn y"))
      #expect(run.score > spread.score)
    }

    @Test func wordPrefixBeatsLettersScatteredOverWordStarts() {
      let commands = ["Toggle Light/Dark Theme", "Open today's daily note", "Toggle agent panel"]
      #expect(ranked("tod", commands).first == "Open today's daily note")
      #expect(ranked("tap", commands).first == "Toggle agent panel")
    }

    @Test func fileNameBeatsFolderNames() {
      let paths = [
        "Plans archive/notes.md", "p/l/a/n.md", "Projects/Plan.md", "Archive/Old plan ideas.md",
      ]
      #expect(ranked("plan", paths).first == "Projects/Plan.md")
      #expect(
        ranked("daily", ["Daily/2026-09-23.md", "Projects/daily standup.md"]).first
          == "Projects/daily standup.md")
      #expect(
        ranked("0923", ["Daily/2026-09-23.md", "Archive/2026/09/23/x.md"]).first
          == "Daily/2026-09-23.md")
    }

    @Test func rankingIsDeterministic() {
      // Equal scores: the shorter candidate first, then input order.
      #expect(
        ranked("note", ["note b.md", "note a.md", "note.md"]) == [
          "note.md", "note b.md", "note a.md",
        ])
      let same = ["Daily/x.md", "Daily/x.md", "Daily/x.md"]
      #expect(Fuzzy.rank(query: "x", candidates: same).map(\.index) == [0, 1, 2])
      #expect(
        Fuzzy.rank(query: "", candidates: ["bb", "a", "b"]).map(\.element) == ["a", "b", "bb"])
      #expect(Fuzzy.rank(query: "o", candidates: ["one", "two", "four"], limit: 2).count == 2)
      #expect(Fuzzy.rank(query: "zzz", candidates: ["one"]).isEmpty)
    }

    @Test func keyedRanking() {
      struct Command { let title: String }
      let commands = [Command(title: "Open settings"), Command(title: "Open today")]
      let results = Fuzzy.rank(query: "ot", in: commands) { $0.title }
      #expect(results.first?.element.title == "Open today")
    }
  }
}
