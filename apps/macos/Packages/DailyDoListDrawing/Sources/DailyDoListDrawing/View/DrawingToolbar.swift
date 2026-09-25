import DailyDoListUI
import SwiftUI

/// The floating tool bar: Excalidraw's tools with their shortcuts in the tooltips, the tool lock,
/// undo and redo, and the properties popover.
struct DrawingToolbar: View {
  let editor: DrawingEditor
  let theme: DrawingTheme
  @State private var showsProperties = false

  var body: some View {
    HStack(spacing: 2) {
      IconButton(
        editor.isToolLocked ? "lock.fill" : "lock.open", label: DrawingCommand.lockTool.label,
        keys: DrawingCommand.lockTool.shortcut, isActive: editor.isToolLocked, size: .compact
      ) {
        editor.isToolLocked.toggle()
      }
      divider
      ForEach(DrawingTool.toolbarTools, id: \.self) { tool in
        IconButton(
          tool.symbol, label: tool.label, keys: tool.shortcut, isActive: editor.tool == tool
        ) {
          editor.tool = tool
        }
      }
      divider
      IconButton(
        "slider.horizontal.3", label: "Properties", isActive: showsProperties
      ) {
        showsProperties.toggle()
      }
      .popover(isPresented: $showsProperties, arrowEdge: .bottom) {
        DrawingPropertiesPanel(editor: editor)
      }
      IconButton(
        "arrow.uturn.backward", label: DrawingCommand.undo.label,
        keys: DrawingCommand.undo.shortcut,
        isEnabled: editor.canUndo
      ) {
        editor.undo()
      }
      IconButton(
        "arrow.uturn.forward", label: DrawingCommand.redo.label, keys: DrawingCommand.redo.shortcut,
        isEnabled: editor.canRedo
      ) {
        editor.redo()
      }
      if !editor.selectedIds.isEmpty {
        IconButton(
          "trash", label: DrawingCommand.delete.label, keys: DrawingCommand.delete.shortcut
        ) {
          editor.deleteSelection()
        }
      }
    }
    .padding(4)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(.regularMaterial)
        .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .strokeBorder(Color.primary.opacity(0.08))
    )
    .environment(\.colorScheme, theme == .dark ? .dark : .light)
    .fixedSize()
  }

  private var divider: some View {
    Rectangle().fill(Color.primary.opacity(0.1)).frame(width: 1, height: 18).padding(.horizontal, 3)
  }
}
