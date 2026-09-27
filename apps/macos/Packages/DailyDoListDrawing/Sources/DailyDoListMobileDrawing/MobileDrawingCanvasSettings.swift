#if canImport(UIKit)
  import SwiftUI

  struct MobileDrawingCanvasSettings: View {
    let controller: MobileDrawingController
    @State private var clearing = false
    @State private var background = ""
    @State private var search = ""
    var body: some View {
      let _ = controller.editor.committedRevision
      Form {
        Section("Canvas") {
          TextField("Background color", text: $background).textInputAutocapitalization(.never)
            .autocorrectionDisabled().onAppear {
              background = controller.editor.scene.viewBackgroundColor
            }
          Button("Apply background") { controller.editor.setCanvasBackground(background) }
          HStack {
            ForEach(["#ffffff", "#f8f9fa", "#fff9db", "#e7f5ff", "#1e1e1e"], id: \.self) { color in
              Button {
                background = color
                controller.editor.setCanvasBackground(color)
              } label: {
                Circle().fill(
                  Color(cgColor: DrawingColorCache.shared.cgColor(color, theme: .light))
                )
                .frame(width: 36, height: 36).overlay(Circle().stroke(.secondary))
              }.accessibilityLabel("Canvas background \(color)")
            }
          }
          Button("Clear canvas", role: .destructive) { clearing = true }
        }
        Section("Find text") {
          TextField("Search drawing text", text: $search)
          if !search.isEmpty {
            ForEach(
              controller.editor.scene.visibleElements.filter {
                ($0.text?.originalText ?? $0.name ?? "").localizedCaseInsensitiveContains(search)
              }, id: \.id
            ) { element in
              Button(element.text?.originalText ?? element.name ?? element.type.rawValue) {
                controller.editor.select([element.id])
                controller.zoomToSelection()
              }
            }
          }
        }
        Section("Statistics") {
          LabeledContent("Elements", value: "\(controller.editor.scene.visibleElements.count)")
          LabeledContent("Selected", value: "\(controller.editor.selectedIds.count)")
          LabeledContent(
            "Image files", value: "\(controller.editor.scene.files.objectValue?.count ?? 0)")
        }
        Section("Touch and keyboard") {
          Text(
            "Use one finger or Apple Pencil with the selected tool. Two fingers pan and pinch. Double-tap a shape to edit its label. Use the actions menu for points, frames, clipboard and the library."
          )
          Text(
            "Hardware keys: V select, H hand, R rectangle, D diamond, O ellipse, A arrow, L line, P pencil, T text, E eraser, F frame. Q keeps a tool active. Enter edits text or finishes a line. Escape cancels. Arrow keys nudge; Shift nudges farther."
          )
          Text(
            "Command-Z undoes, Shift-Command-Z redoes. Command-A selects all; Command-D duplicates; Command-C, X and V copy, cut and paste. Command-G groups; Shift-Command-G ungroups. Command-plus/minus zoom; Command-0 resets zoom. Delete removes the selection."
          )
          Text(
            "VoiceOver exposes each shape with select, edit, duplicate, delete and move actions. Locking a shape prevents those editing actions."
          )
        }
      }.navigationTitle("Canvas settings and help")
        .alert("Clear this drawing?", isPresented: $clearing) {
          Button("Clear", role: .destructive) { controller.editor.clearCanvas() }
          Button("Cancel", role: .cancel) {}
        } message: {
          Text("All elements, including locked elements, are removed. Undo restores them.")
        }
    }
  }
#endif
