import DailyDoListUI
import SwiftUI

extension View {
  /// A clickable row of a sidebar list (explorer, search results): the pointing hand across the
  /// row and, under the pointer, a tint the shape of the list's selection. `isActive` false turns
  /// both off (a row being renamed); a selected row keeps its selection color instead.
  func hoverRow(_ isActive: Bool = true, isSelected: Bool = false) -> some View {
    modifier(HoverRow(isActive: isActive, isSelected: isSelected))
  }
}

private struct HoverRow: ViewModifier {
  let isActive: Bool
  let isSelected: Bool
  @State private var hovering = false

  func body(content: Content) -> some View {
    content
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
      .listRowBackground(
        // The sidebar list's selection is inset 10 pt from the row's edges.
        RoundedRectangle(cornerRadius: 5)
          .fill(hovering && isActive && !isSelected ? Theme.hover : .clear)
          .padding(.horizontal, 10)
          .animation(.easeOut(duration: 0.11), value: hovering)
      )
      .onHover { hovering = $0 }
      .pointingHandCursor(isActive)
  }
}
