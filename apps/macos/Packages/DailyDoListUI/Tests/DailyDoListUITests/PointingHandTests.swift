import Testing

@testable import DailyDoListUI

/// The macOS 14 cursor fallback: every push has its pop, whatever happens under the pointer.
@MainActor
@Suite("Pointing hand (macOS 14)")
struct PointingHandTests {
  final class Counts {
    var pushes = 0
    var pops = 0
    var reasserts = 0
    var depth: Int { pushes - pops }
  }

  let counts = Counts()
  let regions: PointingHandRegions

  init() {
    let counts = counts
    regions = PointingHandRegions(
      cursor: .init(
        push: { counts.pushes += 1 }, pop: { counts.pops += 1 }, reassert: { counts.reasserts += 1 }
      ))
  }

  @Test func oneRegion() {
    let button = PointingHandRegions.Region()
    regions.enter(button)
    regions.enter(button)  // moving inside it
    #expect(counts.pushes == 1)
    #expect(counts.reasserts == 1, "moving re-sets the hand (a view underneath may reset it)")
    regions.exit(button)
    #expect(counts.depth == 0)
    #expect(!regions.isShowingHand)
  }

  @Test func overlappingRegionsInEitherOrder() {
    let tab = PointingHandRegions.Region()
    let close = PointingHandRegions.Region()
    regions.enter(tab)
    regions.enter(close)
    regions.exit(tab)  // exits can come out of order
    #expect(regions.isShowingHand)
    regions.exit(close)
    #expect(counts.pushes == 1 && counts.pops == 1)
  }

  @Test func extraExitsDontPop() {
    let row = PointingHandRegions.Region()
    regions.exit(row)
    regions.enter(row)
    regions.exit(row)
    regions.exit(row)  // disappears after the pointer already left
    #expect(counts.depth == 0)
    #expect(counts.pops == 1)
  }

  @Test func disappearingOrDisabledWhileHoveredLetsGo() {
    let first = PointingHandRegions.Region()
    let second = PointingHandRegions.Region()
    regions.enter(first)
    regions.exit(first)  // `onDisappear`, or `isActive` went false
    #expect(counts.depth == 0)
    regions.enter(second)
    #expect(counts.depth == 1)
    regions.exit(second)
    #expect(counts.depth == 0)
  }
}
