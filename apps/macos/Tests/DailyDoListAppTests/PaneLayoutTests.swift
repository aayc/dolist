import CoreGraphics
import Testing

@testable import DailyDoListApp

@Suite("Pane layout")
struct PaneLayoutTests {
  @Test func roomyWindowsKeepTheChosenWidths() {
    let widths = PaneLayout.fit(total: 1400, sidebar: 260, inspector: 380)
    #expect(widths == PaneLayout.Widths(sidebar: 260, inspector: 380))
  }

  @Test func hiddenPanesStayHidden() {
    #expect(PaneLayout.fit(total: 900, sidebar: nil, inspector: 340) == PaneLayout.Widths(sidebar: nil, inspector: 340))
    #expect(PaneLayout.fit(total: 900, sidebar: 240, inspector: nil) == PaneLayout.Widths(sidebar: 240, inspector: nil))
  }

  @Test func storedWidthsAreClampedToEachPanesRange() {
    let widths = PaneLayout.fit(total: 3000, sidebar: 20, inspector: 5000)
    #expect(widths.sidebar == PaneLayout.sidebarRange.lowerBound)
    #expect(widths.inspector == PaneLayout.inspectorRange.upperBound)
  }

  @Test func aNarrowWindowShrinksTheAgentPanelFirstThenTheSidebar() {
    // 240 + 340 + 400 = 980: 40 short, all taken from the agent panel.
    #expect(PaneLayout.fit(total: 940, sidebar: 240, inspector: 340) == PaneLayout.Widths(sidebar: 240, inspector: 300))
    // Past the agent panel's minimum, the sidebar gives the rest.
    #expect(PaneLayout.fit(total: 900, sidebar: 240, inspector: 340) == PaneLayout.Widths(sidebar: 200, inspector: 300))
    // Never below the minimums, even when the note can't get its full width.
    #expect(PaneLayout.fit(total: 700, sidebar: 240, inspector: 340) == PaneLayout.Widths(sidebar: 180, inspector: 300))
  }

  @Test func draggingStopsAtTheRangeAndAtTheNotesMinimum() {
    let range = PaneLayout.sidebarRange
    #expect(PaneLayout.dragged(300, range: range, total: 1400, otherPane: 340) == 300)
    #expect(PaneLayout.dragged(100, range: range, total: 1400, otherPane: 340) == range.lowerBound)
    #expect(PaneLayout.dragged(900, range: range, total: 1400, otherPane: nil) == range.upperBound)
    // 1000 - 340 - 400 leaves 260 for the sidebar.
    #expect(PaneLayout.dragged(400, range: range, total: 1000, otherPane: 340) == 260)
  }

  @Test func theWindowMinimumFitsTheVisiblePanes() {
    #expect(PaneLayout.minimumWindowWidth(sidebar: false, inspector: false) == PaneLayout.noteMinWidth)
    #expect(PaneLayout.minimumWindowWidth(sidebar: true, inspector: true) == CGFloat(180 + 300 + 400))
  }
}
