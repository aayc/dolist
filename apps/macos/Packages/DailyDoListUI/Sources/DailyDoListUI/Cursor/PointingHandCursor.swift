import AppKit
import SwiftUI

extension View {
  /// The pointing hand over this view while it's enabled (and `isActive`): for everything
  /// clickable that isn't a text field. Apply it inside `.disabled(_:)`, so it knows.
  public func pointingHandCursor(_ isActive: Bool = true) -> some View {
    modifier(PointingHandCursor(isActive: isActive))
  }
}

/// The hand is pushed once when the pointer enters the first hand region and popped once when it
/// leaves the last, so the cursor stack stays balanced whatever order hover events come in, and a
/// region that disappears or gets disabled under the pointer lets go. Not `pointerStyle` (macOS
/// 15) behind `if #available`: that makes the modified view an `AnyView`, and a `List` of such
/// rows builds every row to count them (4 s for 2,000 explorer rows).
private struct PointingHandCursor: ViewModifier {
  let isActive: Bool
  @Environment(\.isEnabled) private var isEnabled
  @State private var region = PointingHandRegions.Region()

  func body(content: Content) -> some View {
    let isActive = isActive && isEnabled
    content
      .onContinuousHover { phase in
        switch phase {
        case .active:
          if isActive { PointingHandRegions.shared.enter(region) }
        case .ended:
          PointingHandRegions.shared.exit(region)
        }
      }
      .onChange(of: isActive) { _, active in
        if !active { PointingHandRegions.shared.exit(region) }
      }
      .onDisappear { PointingHandRegions.shared.exit(region) }
  }
}

/// The views the pointer is over that want the pointing hand.
@MainActor
final class PointingHandRegions {
  /// A region's identity (one per modifier instance).
  final class Region: Hashable, Sendable {
    nonisolated static func == (a: Region, b: Region) -> Bool { a === b }
    nonisolated func hash(into hasher: inout Hasher) { hasher.combine(ObjectIdentifier(self)) }
  }

  /// The cursor stack, behind a seam so tests count pushes and pops.
  struct Cursor {
    var push: @MainActor () -> Void
    var pop: @MainActor () -> Void
    /// Sets the hand again without touching the stack (a view underneath may have reset it).
    var reassert: @MainActor () -> Void

    static let system = Cursor(
      push: { NSCursor.pointingHand.push() }, pop: { NSCursor.pop() },
      reassert: { NSCursor.pointingHand.set() })
  }

  static let shared = PointingHandRegions(cursor: .system)

  private let cursor: Cursor
  private var active: Set<Region> = []

  init(cursor: Cursor) {
    self.cursor = cursor
  }

  var isShowingHand: Bool { !active.isEmpty }

  func enter(_ region: Region) {
    if active.insert(region).inserted, active.count == 1 {
      cursor.push()
    } else {
      cursor.reassert()
    }
  }

  func exit(_ region: Region) {
    guard active.remove(region) != nil, active.isEmpty else { return }
    cursor.pop()
  }
}
