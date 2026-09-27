#if canImport(UIKit)
  import SwiftUI

  struct MobileDrawingProperties: View {
    let editor: DrawingEditor

    var body: some View {
      Form {
        Section("Colors") {
          colorPicker("Stroke", value: editor.style.strokeColor, transparent: false) { value in
            editor.applyStyle { $0.strokeColor = value }
          }
          colorPicker("Background", value: editor.style.backgroundColor, transparent: true) {
            value in editor.applyStyle { $0.backgroundColor = value }
          }
        }
        Section("Shape") {
          Picker("Fill", selection: binding(\.fillStyle)) {
            Text("Solid").tag(FillStyle.solid)
            Text("Hachure").tag(FillStyle.hachure)
            Text("Cross hatch").tag(FillStyle.crossHatch)
            Text("Zigzag").tag(FillStyle.zigzag)
          }
          Picker("Stroke", selection: binding(\.strokeStyle)) {
            Text("Solid").tag(StrokeStyle.solid)
            Text("Dashed").tag(StrokeStyle.dashed)
            Text("Dotted").tag(StrokeStyle.dotted)
          }
          Picker("Width", selection: binding(\.strokeWidth)) {
            Text("Thin").tag(1.0)
            Text("Medium").tag(2.0)
            Text("Thick").tag(4.0)
          }
          Picker("Sloppiness", selection: binding(\.roughness)) {
            Text("Architect").tag(0.0)
            Text("Artist").tag(1.0)
            Text("Cartoonist").tag(2.0)
          }
          Toggle("Round edges", isOn: binding(\.roundEdges))
          LabeledContent("Opacity", value: "\(Int(editor.style.opacity))%")
          Slider(value: binding(\.opacity), in: 0...100, step: 10).accessibilityLabel("Opacity")
        }
        Section("Text") {
          Picker("Font", selection: binding(\.fontFamily)) {
            Text("Excalifont — hand drawn").tag(FontFamily.excalifont)
            Text("Virgil — legacy hand drawn").tag(FontFamily.virgil)
            Text("Helvetica — sans serif").tag(FontFamily.helvetica)
            Text("Cascadia — code").tag(FontFamily.cascadia)
            Text("Nunito — rounded").tag(FontFamily.nunito)
            Text("Lilita One — bold").tag(FontFamily.lilitaOne)
            Text("Comic Shanns — hand drawn code").tag(FontFamily.comicShanns)
            Text("Liberation Sans — classic").tag(FontFamily.liberationSans)
          }
          Stepper(
            "Size \(Int(editor.style.fontSize))", value: binding(\.fontSize), in: 8...144, step: 2)
          Picker("Alignment", selection: binding(\.textAlign)) {
            Text("Left").tag(TextAlign.left)
            Text("Center").tag(TextAlign.center)
            Text("Right").tag(TextAlign.right)
          }
        }
        Section("Text layout") {
          Picker(
            "Vertical alignment",
            selection: Binding(
              get: { editor.selectedTextElements.first?.text?.verticalAlign ?? .middle },
              set: { editor.setTextVerticalAlignment($0) })
          ) {
            Text("Top").tag(VerticalAlign.top)
            Text("Middle").tag(VerticalAlign.middle)
            Text("Bottom").tag(VerticalAlign.bottom)
          }.disabled(editor.selectedTextElements.isEmpty)
          Toggle(
            "Auto width",
            isOn: Binding(
              get: { editor.selectedTextElements.first?.text?.autoResize ?? true },
              set: { editor.setTextAutoResize($0) })
          )
          .disabled(!editor.selectedTextElements.contains { $0.containerId == nil })
          Button("Bind selected text and shape") { editor.bindSelectedText() }
            .disabled(editor.selectedIds.count != 2)
          Button("Unbind text") { editor.unbindSelectedText() }
            .disabled(!editor.selectedTextElements.contains { $0.containerId != nil })
          Button("Wrap text in a rectangle") { editor.wrapSelectedText() }
            .disabled(!editor.selectedTextElements.contains { $0.containerId == nil })
          Text(
            "Excalifont is bundled. Other family identifiers are preserved and use the device's closest available fonts."
          )
          .font(.footnote).foregroundStyle(.secondary)
        }
        Section("Arrowheads") {
          arrowheadPicker("Start", selection: binding(\.startArrowhead))
          arrowheadPicker("End", selection: binding(\.endArrowhead))
        }
      }
    }

    private func binding<Value>(_ keyPath: WritableKeyPath<ElementStyle, Value>) -> Binding<Value> {
      Binding(
        get: { editor.style[keyPath: keyPath] },
        set: { value in editor.applyStyle { $0[keyPath: keyPath] = value } })
    }

    private func arrowheadPicker(_ label: String, selection: Binding<Arrowhead?>) -> some View {
      Picker(label, selection: selection) {
        Text("None").tag(Arrowhead?.none)
        ForEach(
          [
            Arrowhead.arrow, .bar, .dot, .circle, .circleOutline, .triangle, .triangleOutline,
            .diamond, .diamondOutline, .crowfootOne, .crowfootMany, .crowfootOneOrMany,
          ], id: \.self
        ) { head in
          Text(head.rawValue.replacingOccurrences(of: "_", with: " ").capitalized).tag(
            Optional(head))
        }
      }
    }

    private func colorPicker(
      _ label: String, value: String, transparent: Bool, apply: @escaping (String) -> Void
    ) -> some View {
      DisclosureGroup("\(label): \(value)") {
        LazyVGrid(
          columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 5), spacing: 4
        ) {
          ForEach(
            (transparent ? ["transparent"] : []) + ["#1e1e1e", "#ffffff"]
              + ExcalidrawPalette.shades.flatMap(\.colors), id: \.self
          ) { color in
            Button {
              apply(color)
            } label: {
              ZStack {
                RoundedRectangle(cornerRadius: 6).fill(
                  Color(cgColor: DrawingColorCache.shared.cgColor(color, theme: .light)))
                if color == "transparent" {
                  Image(systemName: "nosign").foregroundStyle(.secondary)
                }
                if color == value {
                  Image(systemName: "checkmark.circle.fill").symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .black)
                }
              }.frame(minHeight: 44).overlay(
                RoundedRectangle(cornerRadius: 6).stroke(.secondary.opacity(0.4)))
            }
            .buttonStyle(.plain).accessibilityLabel(color == "transparent" ? "Transparent" : color)
            .accessibilityAddTraits(color == value ? .isSelected : [])
          }
        }
      }
    }
  }
#endif
