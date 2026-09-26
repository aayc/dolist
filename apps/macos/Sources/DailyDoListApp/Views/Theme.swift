import DailyDoListUI
import SwiftUI

/// Metrics of the shell (its colors are `DailyDoListUI`'s palette).
extension Theme {
  /// Every pane's top row (sidebar, tabs, agent panel), so their bottom lines meet.
  static let headerHeight: CGFloat = 40
  static let statusBarHeight: CGFloat = 26
  static let readableWidth: CGFloat = 700
  /// Room the window's close/minimize/zoom buttons need at the top-left (outside full screen).
  static let trafficLightsWidth: CGFloat = 76
}

/// Small rounded capsule for counts and states.
struct Pill: View {
  let text: String
  var color: Color = Theme.accent

  var body: some View {
    Text(text)
      .font(.system(size: 10, weight: .semibold))
      .padding(.horizontal, 6)
      .padding(.vertical, 1.5)
      .foregroundStyle(color)
      .background(color.opacity(0.14), in: Capsule())
  }
}
