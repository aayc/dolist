import CoreGraphics
import DailyDoListDrawingModel
import DailyDoListUITestSupport
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
    #expect(distinctColors(image) > 40, "the render looks blank")
    let corner = Pixels.color(image, x: 2, y: 2)
    if theme == .light {
      #expect(corner.r == 255 && corner.g == 255 && corner.b == 255)
    } else {
      // #ffffff through invert(93%): Excalidraw's dark canvas, #121212.
      #expect(abs(corner.r - 0x12) <= 1 && abs(corner.g - 0x12) <= 1 && abs(corner.b - 0x12) <= 1)
    }
  }

  @Test func rendersAreDeterministic() throws {
    let scene = TestScenes.gallery()
    let first = try #require(DrawingImage.render(scene, scale: 1, theme: .light))
    let second = try #require(
      DrawingImage.render(scene, scale: 1, theme: .light, renderer: SceneRenderer()))
    #expect(rgbaBytes(first) == rgbaBytes(second))
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
