import Testing

@testable import DailyDoListApp

@MainActor
@Suite("TabsStore")
struct TabsStoreTests {
  @Test func navigatingReplacesTheActiveTabLikeObsidian() {
    let tabs = TabsStore()
    tabs.place("a.md")
    tabs.place("b.md")
    #expect(tabs.tabs == ["b.md"])
    tabs.place("c.md", newTab: true)
    #expect(tabs.tabs == ["b.md", "c.md"])
    #expect(tabs.active == "c.md")
  }

  @Test func openNoteActivatesItsExistingTab() {
    let tabs = TabsStore()
    tabs.place("a.md")
    tabs.place("b.md", newTab: true)
    tabs.place("a.md")
    #expect(tabs.tabs == ["a.md", "b.md"])
    #expect(tabs.active == "a.md")
  }

  @Test func newTabOpensRightOfTheActiveOne() {
    let tabs = TabsStore()
    tabs.restore(tabs: ["a.md", "b.md", "c.md"], active: "a.md")
    tabs.place("d.md", newTab: true)
    #expect(tabs.tabs == ["a.md", "d.md", "b.md", "c.md"])
  }

  @Test func closingActivatesTheRightNeighbourThenTheLeft() {
    let tabs = TabsStore()
    tabs.restore(tabs: ["a.md", "b.md", "c.md"], active: "b.md")
    #expect(tabs.close("b.md") == "c.md")
    #expect(tabs.close("c.md") == "a.md")
    #expect(tabs.close("a.md") == nil)
    #expect(tabs.tabs.isEmpty)
  }

  @Test func reopenRestoresTheMostRecentlyClosedTabAtItsPosition() throws {
    let tabs = TabsStore()
    tabs.restore(tabs: ["a.md", "b.md", "c.md"], active: "c.md")
    tabs.close("b.md")
    tabs.close("c.md")
    let closed = try #require(tabs.popClosedTab())
    #expect(closed.path == "c.md")
    tabs.reinsert(closed)
    let next = try #require(tabs.popClosedTab())
    tabs.reinsert(next)
    #expect(tabs.tabs == ["a.md", "b.md", "c.md"])
    #expect(tabs.active == "b.md")
    #expect(tabs.canReopenClosedTab == false)
  }

  @Test func reopenSkipsTabsThatAreOpenOrGone() {
    let tabs = TabsStore()
    tabs.restore(tabs: ["a.md", "b.md", "c.md"], active: "a.md")
    tabs.close("b.md")
    tabs.close("c.md")
    tabs.place("c.md", newTab: true)
    #expect(tabs.popClosedTab(isValid: { $0 != "b.md" }) == nil)
  }

  @Test func backAndForwardWalkTheHistory() {
    let tabs = TabsStore()
    tabs.place("a.md")
    tabs.place("b.md")
    tabs.place("c.md", newTab: true)
    #expect(tabs.canGoBack)
    let back = tabs.popBack()
    #expect(back == "b.md")
    tabs.place("b.md", recordHistory: false)
    #expect(tabs.popBack() == "a.md")
    tabs.place("a.md", recordHistory: false)
    #expect(tabs.canGoBack == false)
    #expect(tabs.popForward() == "b.md")
    tabs.place("b.md", recordHistory: false)
    #expect(tabs.popForward() == "c.md")
  }

  @Test func newNavigationClearsForwardHistory() {
    let tabs = TabsStore()
    tabs.place("a.md")
    tabs.place("b.md")
    _ = tabs.popBack()
    tabs.place("a.md", recordHistory: false)
    #expect(tabs.canGoForward)
    tabs.place("z.md")
    #expect(tabs.canGoForward == false)
  }

  @Test func tabShortcutsSelectByPositionAndNineIsLast() {
    let tabs = TabsStore()
    tabs.restore(tabs: ["a.md", "b.md", "c.md"], active: "a.md")
    #expect(tabs.tab(forShortcut: 2) == "b.md")
    #expect(tabs.tab(forShortcut: 9) == "c.md")
    #expect(tabs.tab(forShortcut: 5) == nil)
    #expect(tabs.adjacentTab(-1) == "c.md")
    #expect(tabs.adjacentTab(1) == "b.md")
  }

  @Test func renameRewritesTabsHistoryAndClosedTabs() {
    let tabs = TabsStore()
    tabs.place("Projects/a.md")
    tabs.place("b.md", newTab: true)
    tabs.close("b.md")
    tabs.rename(from: "Projects", to: "Archive")
    #expect(tabs.tabs == ["Archive/a.md"])
    #expect(tabs.active == "Archive/a.md")
    #expect(tabs.backStack.allSatisfy { !$0.hasPrefix("Projects/") })
  }

  @Test func purgeForgetsADeletedNoteEverywhere() {
    let tabs = TabsStore()
    tabs.place("a.md")
    tabs.place("b.md")
    tabs.place("a.md")
    tabs.purge("b.md")
    #expect(!tabs.backStack.contains("b.md"))
  }
}
