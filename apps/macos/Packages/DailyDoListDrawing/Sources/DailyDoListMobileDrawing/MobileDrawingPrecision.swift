#if canImport(UIKit)
  import SwiftUI

  struct MobileDrawingPrecision: View {
    @Bindable var editor: DrawingEditor
    @State private var frameName = ""
    var body: some View {
      Form {
        Section("Frames") {
          Button("Draw a frame") { editor.tool = .frame }
          Button("Wrap selection in frame") { _ = editor.frameSelection() }
            .disabled(editor.selectedIds.isEmpty)
          Toggle("Show frames and clip their contents", isOn: $editor.framesVisible)
          if let frame = editor.selectedElements.first, editor.selectedIds.count == 1,
            frame.type.isFrameLike
          {
            TextField("Frame name", text: $frameName)
              .onAppear { frameName = frame.name ?? "" }
            Button("Rename frame") { editor.renameFrame(frame.id, name: frameName) }
            Button("Select contents") { editor.selectFrameChildren(frame.id) }
            Button("Remove contents from frame") { editor.removeFrameChildren(frame.id) }
          }
        }
        Section("Precision") {
          Toggle("Snap to grid", isOn: $editor.gridEnabled)
          Stepper(
            "Grid spacing: \(Int(editor.gridSize))", value: $editor.gridSize, in: 1...100, step: 1)
          Toggle("Snap to object edges and centers", isOn: $editor.objectsSnapEnabled)
        }
        Section("Arrows") {
          Picker(
            "Arrow shape",
            selection: Binding(get: { editor.arrowShape }, set: { editor.setArrowShape($0) })
          ) {
            ForEach(DrawingArrowShape.allCases, id: \.self) {
              Text($0.rawValue.capitalized).tag($0)
            }
          }
        }
        if let element = editor.selectedElements.first, editor.selectedIds.count == 1,
          element.type.isLinear
        {
          Section("Line and arrow points") {
            if editor.editingLinearId != element.id {
              Button("Edit points") { editor.beginLinearEditing(element.id) }
            } else {
              Text(
                "Drag an existing point, or a smaller midpoint to add a bend. Select a point below for exact adjustments."
              )
              .font(.footnote)
              ForEach(element.points.indices, id: \.self) { index in
                Button(
                  "Point \(index + 1)\(editor.selectedPointIndex == index ? " · selected" : "")"
                ) {
                  editor.selectLinearPoint(index)
                }
              }
              if let index = editor.selectedPointIndex, element.points.indices.contains(index) {
                let point = ArrowBinding.absolutePoint(element, index)
                LabeledContent("Scene coordinates", value: "\(Int(point.x)), \(Int(point.y))")
                HStack {
                  Button("←") {
                    editor.moveLinearPoint(
                      element.id, index: index, to: point + DrawingPoint(-1, 0))
                  }
                  .accessibilityLabel("Move point left")
                  Button("↑") {
                    editor.moveLinearPoint(
                      element.id, index: index, to: point + DrawingPoint(0, -1))
                  }
                  .accessibilityLabel("Move point up")
                  Button("↓") {
                    editor.moveLinearPoint(element.id, index: index, to: point + DrawingPoint(0, 1))
                  }
                  .accessibilityLabel("Move point down")
                  Button("→") {
                    editor.moveLinearPoint(element.id, index: index, to: point + DrawingPoint(1, 0))
                  }
                  .accessibilityLabel("Move point right")
                }.buttonStyle(.bordered)
                if element.elbowed, index > 0 {
                  let fixed =
                    element.extraField("fixedSegments")?.arrayValue?.contains {
                      $0.objectValue?["index"]?.numberValue == Double(index)
                    } ?? false
                  Button(fixed ? "Release preceding segment" : "Fix preceding segment") {
                    editor.setElbowSegmentFixed(element.id, index: index, fixed: !fixed)
                  }
                  HStack {
                    Button("Move segment left") {
                      editor.moveElbowSegment(element.id, index: index, by: DrawingPoint(-1, 0))
                    }
                    Button("Move segment right") {
                      editor.moveElbowSegment(element.id, index: index, by: DrawingPoint(1, 0))
                    }
                  }
                  HStack {
                    Button("Move segment up") {
                      editor.moveElbowSegment(element.id, index: index, by: DrawingPoint(0, -1))
                    }
                    Button("Move segment down") {
                      editor.moveElbowSegment(element.id, index: index, by: DrawingPoint(0, 1))
                    }
                  }
                }
                Button("Insert midpoint after point") {
                  editor.insertLinearPoint(element.id, after: index)
                }
                .disabled(index >= element.points.count - 1)
                Button("Delete point", role: .destructive) {
                  editor.deleteLinearPoint(element.id, index: index)
                }
                .disabled(element.points.count <= 2)
              }
              if element.elbowed {
                Button("Reroute around bound shapes") { editor.rerouteElbow(element.id) }
              }
              Button("Finish editing points") { editor.endLinearEditing() }
            }
          }
        }
      }
    }
  }
#endif
