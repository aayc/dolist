import CoreGraphics

/// Widths of the side panes: the user's choice, clamped to each pane's range, and shrunk when the
/// window is narrow (the agent panel first) so the note always keeps ``noteMinWidth``.
enum PaneLayout {
  static let sidebarRange: ClosedRange<CGFloat> = 180...420
  static let sidebarDefault: CGFloat = 240
  static let inspectorRange: ClosedRange<CGFloat> = 300...560
  static let inspectorDefault: CGFloat = 340
  static let noteMinWidth: CGFloat = 400

  /// Drawn widths; nil = the pane is hidden.
  struct Widths: Equatable {
    var sidebar: CGFloat?
    var inspector: CGFloat?
  }

  /// The widths to draw in a window `total` points wide.
  static func fit(total: CGFloat, sidebar: CGFloat?, inspector: CGFloat?) -> Widths {
    var sidebar = sidebar.map { clamp($0, to: sidebarRange) }
    var inspector = inspector.map { clamp($0, to: inspectorRange) }
    var excess = (sidebar ?? 0) + (inspector ?? 0) + noteMinWidth - total
    if excess > 0, let width = inspector {
      let cut = min(excess, width - inspectorRange.lowerBound)
      inspector = width - cut
      excess -= cut
    }
    if excess > 0, let width = sidebar {
      sidebar = width - min(excess, width - sidebarRange.lowerBound)
    }
    return Widths(sidebar: sidebar, inspector: inspector)
  }

  /// A width being dragged: within the pane's range and never taking the note below its minimum.
  static func dragged(
    _ width: CGFloat, range: ClosedRange<CGFloat>, total: CGFloat, otherPane: CGFloat?
  ) -> CGFloat {
    let room = total - (otherPane ?? 0) - noteMinWidth
    return clamp(min(width, room), to: range)
  }

  /// The smallest window that fits the visible panes at their minimum widths.
  static func minimumWindowWidth(sidebar: Bool, inspector: Bool) -> CGFloat {
    (sidebar ? sidebarRange.lowerBound : 0) + (inspector ? inspectorRange.lowerBound : 0)
      + noteMinWidth
  }

  private static func clamp(_ value: CGFloat, to range: ClosedRange<CGFloat>) -> CGFloat {
    min(max(value, range.lowerBound), range.upperBound)
  }
}
