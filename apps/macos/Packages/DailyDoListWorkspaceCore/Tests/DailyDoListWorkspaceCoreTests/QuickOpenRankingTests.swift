import Testing

@testable import DailyDoListWorkspaceCore

struct QuickOpenRankingTests {
  @Test func nameBonusRecentOrderingAndSelectionAreSharedAcrossClients() {
    let files = ["Planning/Other.md", "Projects/Plan.md", "Daily/2026-01-02.md"]
    #expect(QuickOpenRanking.notes("p l a n", files: files).first?.id == "Projects/Plan.md")
    #expect(
      QuickOpenRanking.defaultNotes(
        files: files, recent: ["Missing.md", "Planning/Other.md"], openTabs: ["Projects/Plan.md"]
      ).map(\.id)
        == ["Planning/Other.md", "Projects/Plan.md", "Daily/2026-01-02.md"])
    #expect(QuickOpenRanking.movingSelection(0, by: -1, count: 3) == 2)
    #expect(QuickOpenRanking.movingSelection(2, by: 1, count: 3) == 0)
    #expect(QuickOpenRanking.movingSelection(0, by: 1, count: 0) == 0)
    #expect(QuickOpenRanking.notes("plan", files: files, limit: 0).isEmpty)
  }
}
