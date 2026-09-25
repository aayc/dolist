import DailyDoListUI
import SwiftUI

/// The properties popover: stroke and background from Excalidraw's palette, fill, stroke width,
/// stroke style, sloppiness, edges, arrowheads, font size and opacity. It edits the selection and
/// the style of new elements, like Excalidraw's shape actions.
struct DrawingPropertiesPanel: View {
  let editor: DrawingEditor

  var body: some View {
    let style = editor.style
    VStack(alignment: .leading, spacing: 12) {
      section("Stroke") {
        swatches(ExcalidrawPalette.strokePicks, selected: style.strokeColor) { color in
          editor.applyStyle { $0.strokeColor = color }
        }
        shades(selected: style.strokeColor, row: 4) { color in
          editor.applyStyle { $0.strokeColor = color }
        }
      }
      section("Background") {
        swatches(ExcalidrawPalette.backgroundPicks, selected: style.backgroundColor) { color in
          editor.applyStyle { $0.backgroundColor = color }
        }
        shades(selected: style.backgroundColor, row: 1) { color in
          editor.applyStyle { $0.backgroundColor = color }
        }
      }
      section("Fill") {
        options(
          [
            ("Hachure", FillStyle.hachure, "line.3.horizontal"),
            ("Cross-hatch", .crossHatch, "grid"),
            ("Solid", .solid, "square.fill"),
          ], selected: style.fillStyle
        ) { value in editor.applyStyle { $0.fillStyle = value } }
      }
      section("Stroke width") {
        options(
          [
            ("Thin", 1.0, "minus"), ("Bold", 2.0, "equal"),
            ("Extra bold", 4.0, "line.3.horizontal"),
          ],
          selected: style.strokeWidth
        ) { value in editor.applyStyle { $0.strokeWidth = value } }
      }
      section("Stroke style") {
        options(
          [
            ("Solid", StrokeStyle.solid, "line.diagonal"), ("Dashed", .dashed, "ellipsis"),
            ("Dotted", .dotted, "circle.dotted"),
          ], selected: style.strokeStyle
        ) { value in editor.applyStyle { $0.strokeStyle = value } }
      }
      section("Sloppiness") {
        options(
          [
            ("Architect", 0.0, "scribble"), ("Artist", 1.0, "scribble.variable"),
            ("Cartoonist", 2.0, "lasso"),
          ], selected: style.roughness
        ) { value in editor.applyStyle { $0.roughness = value } }
      }
      section("Edges") {
        options(
          [("Sharp", false, "square"), ("Round", true, "app")], selected: style.roundEdges
        ) { value in editor.applyStyle { $0.roundEdges = value } }
      }
      section("Arrowheads") {
        HStack(spacing: 10) {
          arrowheadMenu("Start", selected: style.startArrowhead) { value in
            editor.applyStyle { $0.startArrowhead = value }
          }
          arrowheadMenu("End", selected: style.endArrowhead) { value in
            editor.applyStyle { $0.endArrowhead = value }
          }
        }
      }
      section("Font size") {
        options(
          [
            ("Small", 16.0, "textformat.size.smaller"), ("Medium", 20.0, "textformat.size"),
            ("Large", 28.0, "textformat.size.larger"), ("Very large", 36.0, "textformat"),
          ],
          selected: style.fontSize
        ) { value in editor.applyStyle { $0.fontSize = value } }
      }
      section("Opacity") {
        Slider(
          value: Binding(
            get: { style.opacity },
            set: { value in editor.applyStyle { $0.opacity = value.rounded() } }),
          in: 0...100, step: 10)
      }
    }
    .padding(14)
    .frame(width: 236)
  }

  private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content)
    -> some View
  {
    VStack(alignment: .leading, spacing: 6) {
      Text(title).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
      content()
    }
  }

  private func swatches(_ colors: [String], selected: String, action: @escaping (String) -> Void)
    -> some View
  {
    HStack(spacing: 6) {
      ForEach(colors, id: \.self) { color in
        Swatch(css: color, isSelected: color == selected).onTapGesture { action(color) }
          .tooltip(color == ExcalidrawPalette.transparent ? "Transparent" : color)
      }
    }
  }

  /// A row of the palette's shades (one per hue), under the quick picks.
  private func shades(selected: String, row: Int, action: @escaping (String) -> Void) -> some View {
    let colors = ExcalidrawPalette.shades.map { $0.colors[row] }
    return LazyVGrid(
      columns: Array(repeating: GridItem(.fixed(16), spacing: 2), count: 12), spacing: 2
    ) {
      ForEach(colors, id: \.self) { color in
        Swatch(css: color, isSelected: color == selected, side: 16).onTapGesture { action(color) }
          .tooltip(color)
      }
    }
  }

  private func options<Value: Equatable>(
    _ items: [(String, Value, String)], selected: Value, action: @escaping (Value) -> Void
  ) -> some View {
    HStack(spacing: 4) {
      ForEach(Array(items.enumerated()), id: \.offset) { _, item in
        IconButton(item.2, label: item.0, isActive: item.1 == selected, size: .regular) {
          action(item.1)
        }
      }
    }
  }

  private func arrowheadMenu(
    _ title: String, selected: Arrowhead?, action: @escaping (Arrowhead?) -> Void
  ) -> some View {
    let choices: [(String, Arrowhead?)] = [
      ("None", nil), ("Arrow", .arrow), ("Triangle", .triangle), ("Bar", .bar), ("Dot", .dot),
      ("Circle", .circleOutline), ("Diamond", .diamond),
    ]
    let current = choices.first { $0.1 == selected }?.0 ?? selected?.rawValue ?? "None"
    return Menu {
      ForEach(choices, id: \.0) { choice in
        Button(choice.0) { action(choice.1) }
      }
    } label: {
      Text("\(title): \(current)").font(.system(size: 11))
    }
    .menuStyle(.borderlessButton)
    .fixedSize()
    .pointingHandCursor()
  }
}

/// A color swatch: the color on a checkerboard-free square, ringed when selected, crossed out when
/// transparent.
struct Swatch: View {
  let css: String
  let isSelected: Bool
  var side: CGFloat = 22

  var body: some View {
    let color = DrawingColor.parse(css) ?? .clear
    RoundedRectangle(cornerRadius: 4, style: .continuous)
      .fill(Color(cgColor: color.cgColor))
      .overlay {
        if color.isTransparent {
          Path { path in
            path.move(to: CGPoint(x: 3, y: side - 3))
            path.addLine(to: CGPoint(x: side - 3, y: 3))
          }.stroke(Color.red.opacity(0.7), lineWidth: 1.5)
        }
      }
      .overlay(
        RoundedRectangle(cornerRadius: 4, style: .continuous)
          .strokeBorder(Color.primary.opacity(0.15))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 6, style: .continuous)
          .strokeBorder(isSelected ? Color.accentColor : .clear, lineWidth: 2)
          .padding(-3)
      )
      .frame(width: side, height: side)
      .contentShape(Rectangle())
      .pointingHandCursor()
  }
}
