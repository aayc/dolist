import CoreGraphics
import DailyDoListDrawingModel
import Foundation
import ImageIO
import Testing

@testable import DailyDoListDrawing

/// Offscreen renders written to the package's `.build/drawing-snapshots/` for review (never
/// committed), with checks on their pixels: every element type, light and dark, the three
/// sloppiness levels, stroke styles and widths, and every arrowhead.
@Suite("Render snapshots", .serialized)
struct RenderSnapshotTests {
  @Test(arguments: DrawingTheme.allCases)
  func rendersEveryElementType(theme: DrawingTheme) throws {
    let scene = TestScenes.gallery()
    let image = try #require(DrawingImage.render(scene, scale: 2, theme: theme))
    _ = try Pixels.writePNG(image, name: "gallery-\(theme.rawValue)")
    #expect(Pixels.distinctColors(image) > 40, "the render looks blank")
    let corner = Pixels.color(image, x: 2, y: 2)
    if theme == .light {
      #expect(corner.r == 255 && corner.g == 255 && corner.b == 255)
    } else {
      // #ffffff through invert(93%): Excalidraw's dark canvas, #121212.
      #expect(abs(corner.r - 0x12) <= 1 && abs(corner.g - 0x12) <= 1 && abs(corner.b - 0x12) <= 1)
    }
  }

  @Test func rendersThePluginFixtureInBothThemes() throws {
    let document = ExcalidrawMarkdown.parse(try Fixtures.text("plugin-json.excalidraw.md"))
    for theme in DrawingTheme.allCases {
      let image = try #require(DrawingImage.render(document.scene, scale: 2, theme: theme))
      _ = try Pixels.writePNG(image, name: "plugin-fixture-\(theme.rawValue)")
      #expect(Pixels.distinctColors(image) > 20)
    }
  }

  @Test func rendersSloppinessLevels() throws {
    var elements: [ExcalidrawElement] = []
    for (row, roughness) in ExcalidrawPalette.roughnessLevels.enumerated() {
      let y = Double(row) * 130 + 20
      let style: (inout ExcalidrawElement) -> Void = {
        $0.roughness = roughness
        $0.backgroundColor = "#a5d8ff"
        $0.fillStyle = .hachure
      }
      elements.append(
        TestScenes.element(
          .rectangle, id: "r\(row)", x: 20, y: y, width: 160, height: 100, seed: 5, configure: style
        ))
      elements.append(
        TestScenes.element(
          .ellipse, id: "e\(row)", x: 210, y: y, width: 160, height: 100, seed: 6, configure: style)
      )
      elements.append(
        TestScenes.element(
          .diamond, id: "d\(row)", x: 400, y: y, width: 160, height: 100, seed: 7, configure: style)
      )
      elements.append(
        TestScenes.linear(
          .arrow, id: "a\(row)", x: 590, y: y + 50,
          points: [.zero, DrawingPoint(80, -30), DrawingPoint(160, 10)], seed: 8
        ) {
          $0.roughness = roughness
        })
    }
    let image = try #require(
      DrawingImage.render(ExcalidrawScene(elements: elements), scale: 2, theme: .light))
    _ = try Pixels.writePNG(image, name: "sloppiness")
    #expect(Pixels.distinctColors(image) > 10)
  }

  @Test func rendersStrokeStylesAndWidths() throws {
    var elements: [ExcalidrawElement] = []
    for (row, style) in [StrokeStyle.solid, .dashed, .dotted].enumerated() {
      for (column, width) in ExcalidrawPalette.strokeWidths.enumerated() {
        elements.append(
          TestScenes.element(
            .rectangle, id: "r\(row)\(column)", x: Double(column) * 170 + 20,
            y: Double(row) * 110 + 20, width: 140, height: 80, seed: row * 3 + column + 1
          ) {
            $0.strokeStyle = style
            $0.strokeWidth = width
            $0.roundness = .adaptive
          })
      }
    }
    let image = try #require(
      DrawingImage.render(ExcalidrawScene(elements: elements), scale: 2, theme: .light))
    _ = try Pixels.writePNG(image, name: "stroke-styles")
    #expect(Pixels.distinctColors(image) > 4)
  }

  @Test func rendersEveryArrowhead() throws {
    let heads: [Arrowhead?] = [
      nil, .arrow, .bar, .dot, .circle, .circleOutline, .triangle, .triangleOutline, .diamond,
      .diamondOutline, .crowfootOne, .crowfootMany, .crowfootOneOrMany,
    ]
    let elements = heads.enumerated().map { index, head in
      TestScenes.linear(
        .arrow, id: "a\(index)", x: 30, y: Double(index) * 36 + 20,
        points: [.zero, DrawingPoint(220, 0)], seed: index + 1
      ) {
        $0.startArrowhead = head
        $0.endArrowhead = head
      }
    }
    for theme in DrawingTheme.allCases {
      let image = try #require(
        DrawingImage.render(ExcalidrawScene(elements: elements), scale: 2, theme: theme))
      _ = try Pixels.writePNG(image, name: "arrowheads-\(theme.rawValue)")
      #expect(Pixels.distinctColors(image) > 4)
    }
  }

  @Test func rendersAreDeterministic() throws {
    let scene = TestScenes.gallery()
    let first = try #require(DrawingImage.render(scene, scale: 1, theme: .light))
    let second = try #require(
      DrawingImage.render(scene, scale: 1, theme: .light, renderer: SceneRenderer()))
    #expect(Pixels.rgba(first) == Pixels.rgba(second))
  }

  @Test func solidFillsPaintTheBackgroundColor() throws {
    let rectangle = TestScenes.element(
      .rectangle, id: "r", x: 0, y: 0, width: 100, height: 100, seed: 3
    ) {
      $0.backgroundColor = "#ffc9c9"
      $0.fillStyle = .solid
    }
    let image = try #require(
      DrawingImage.render(ExcalidrawScene(elements: [rectangle]), scale: 1, theme: .light))
    let center = Pixels.color(image, x: image.width / 2, y: image.height / 2)
    #expect(center.r == 0xFF && abs(center.g - 0xC9) <= 1 && abs(center.b - 0xC9) <= 1)
  }

  @Test func darkModeFiltersColorsLikeExcalidraw() throws {
    let white = try #require(DrawingColor.parse("#ffffff")).darkModeFiltered
    #expect(white.hexString == "#121212")
    let black = try #require(DrawingColor.parse("#1e1e1e")).darkModeFiltered
    #expect(black.hexString == "#d3d3d3")
    let blue = try #require(DrawingColor.parse("#1971c2")).darkModeFiltered
    #expect(blue.blue > blue.red, "hues survive the inversion")
    #expect(
      DrawingColor.parse("rgba(255, 0, 0, 0.5)")
        == DrawingColor(red: 1, green: 0, blue: 0, alpha: 0.5))
    #expect(DrawingColor.parse("red") == DrawingColor(rgb: 0xFF0000))
    #expect(DrawingColor.parse("#abc") == DrawingColor(rgb: 0xAABBCC))
    #expect(DrawingColor.isTransparent("#12345600"))
    #expect(DrawingColor.parse("nonsense") == nil)
  }

  @Test func previewsAreCachedByContentHash() throws {
    let cache = DrawingPreviewCache()
    var scene = TestScenes.gallery()
    let first = cache.image(for: scene, width: 360, theme: .light)
    _ = cache.image(for: scene, width: 360, theme: .light)
    #expect(first != nil)
    #expect(cache.renderCount == 1)
    _ = cache.image(for: scene, width: 360, theme: .dark)
    #expect(cache.renderCount == 2)
    scene.elements[0].x += 5
    _ = cache.image(for: scene, width: 360, theme: .light)
    #expect(cache.renderCount == 3)
    #expect(first?.width == 720)
  }
}
