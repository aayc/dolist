#if canImport(UIKit)
  import SwiftUI

  struct MobileDrawingArrangeMenu: View {
    let editor: DrawingEditor
    var body: some View {
      Menu("Arrange") {
        Button("Rotate clockwise 15°") { editor.rotateSelection(by: .pi / 12) }
        Button("Rotate counterclockwise 15°") { editor.rotateSelection(by: -.pi / 12) }
        Button("Rotate clockwise 90°") { editor.rotateSelection(by: .pi / 2) }
        Button("Flip horizontally") { editor.flipSelection(horizontally: true) }
        Button("Flip vertically") { editor.flipSelection(horizontally: false) }
        Divider()
        Button("Bring to front") { editor.moveSelection(to: .front) }
        Button("Bring forward") { editor.moveSelection(to: .forward) }
        Button("Send backward") { editor.moveSelection(to: .backward) }
        Button("Send to back") { editor.moveSelection(to: .back) }
        Divider()
        Button("Group") { editor.groupSelection() }
        Button("Ungroup") { editor.ungroupSelection() }
        Button("Lock selection") { editor.lockSelection() }
        Menu("Align") {
          Button("Left") { editor.alignSelection(.left) }
          Button("Center horizontally") { editor.alignSelection(.horizontalCenter) }
          Button("Right") { editor.alignSelection(.right) }
          Button("Top") { editor.alignSelection(.top) }
          Button("Center vertically") { editor.alignSelection(.verticalCenter) }
          Button("Bottom") { editor.alignSelection(.bottom) }
          Button("Distribute horizontally") { editor.distributeSelection(horizontally: true) }
          Button("Distribute vertically") { editor.distributeSelection(horizontally: false) }
        }
      }.disabled(editor.selectedIds.isEmpty)
    }
  }
#endif
