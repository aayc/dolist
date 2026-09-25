import CoreGraphics
import Testing

@testable import DailyDoListUI

@Suite("Tooltip placement")
struct TooltipLayoutTests {
  let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
  let size = CGSize(width: 90, height: 26)

  @Test func belowAHeaderControlCenteredWithAGap() {
    let anchor = CGRect(x: 400, y: 850, width: 28, height: 28)
    let result = TooltipLayout.place(size: size, anchor: anchor, bounds: screen, prefersBelow: true)
    #expect(result.isBelow)
    #expect(result.frame.maxY == anchor.minY - 6, "6 pt gap")
    #expect(result.frame.midX == anchor.midX)
  }

  @Test func aboveEverythingElse() {
    let anchor = CGRect(x: 400, y: 20, width: 60, height: 20)
    let result = TooltipLayout.place(
      size: size, anchor: anchor, bounds: screen, prefersBelow: false)
    #expect(!result.isBelow)
    #expect(result.frame.minY == anchor.maxY + 6)
  }

  @Test func flipsWhenThePreferredSideHasNoRoom() {
    let nearTop = CGRect(x: 400, y: 870, width: 28, height: 20)
    #expect(
      TooltipLayout.place(size: size, anchor: nearTop, bounds: screen, prefersBelow: false)
        .isBelow, "no room above: it goes below")
    let nearBottom = CGRect(x: 400, y: 10, width: 28, height: 20)
    #expect(
      !TooltipLayout.place(size: size, anchor: nearBottom, bounds: screen, prefersBelow: true)
        .isBelow, "no room below: it goes above")
  }

  @Test func clampedEightPointsInsideTheBounds() {
    let leftEdge = CGRect(x: 0, y: 400, width: 20, height: 20)
    let left = TooltipLayout.place(
      size: size, anchor: leftEdge, bounds: screen, prefersBelow: false)
    #expect(left.frame.minX == CGFloat(8))
    let rightEdge = CGRect(x: 1430, y: 400, width: 10, height: 10)
    let right = TooltipLayout.place(
      size: size, anchor: rightEdge, bounds: screen, prefersBelow: false)
    #expect(right.frame.maxX == CGFloat(1432))
  }

  @Test func headerControlsPreferBelow() {
    let window = CGRect(x: 0, y: 0, width: 1200, height: 800)
    let header = CGRect(x: 300, y: 766, width: 28, height: 28)
    let body = CGRect(x: 300, y: 400, width: 28, height: 28)
    #expect(TooltipLayout.prefersBelow(.automatic, anchor: header, windowFrame: window))
    #expect(!TooltipLayout.prefersBelow(.automatic, anchor: body, windowFrame: window))
    #expect(TooltipLayout.prefersBelow(.below, anchor: body, windowFrame: window))
    #expect(!TooltipLayout.prefersBelow(.above, anchor: header, windowFrame: window))
    #expect(!TooltipLayout.prefersBelow(.automatic, anchor: header, windowFrame: nil))
  }
}
