import CoreGraphics
import Foundation

/// Where the canvas looks: `zoom` screen points per scene unit, and the scene point at the
/// view's top-left corner.
public struct DrawingViewport: Hashable, Sendable {
  public var zoom: Double
  public var origin: DrawingPoint

  public init(zoom: Double = 1, origin: DrawingPoint = .zero) {
    self.zoom = zoom
    self.origin = origin
  }

  public func sceneToView(_ point: DrawingPoint) -> CGPoint {
    CGPoint(x: (point.x - origin.x) * zoom, y: (point.y - origin.y) * zoom)
  }

  public func viewToScene(_ point: CGPoint) -> DrawingPoint {
    DrawingPoint(point.x / zoom + origin.x, point.y / zoom + origin.y)
  }

  /// The part of the scene a view of `size` shows.
  public func visibleRect(size: CGSize) -> DrawingRect {
    DrawingRect(x: origin.x, y: origin.y, width: size.width / zoom, height: size.height / zoom)
  }

  /// Transforms a y-down context from view points to scene units.
  public func apply(to context: CGContext) {
    context.scaleBy(x: zoom, y: zoom)
    context.translateBy(x: -origin.x, y: -origin.y)
  }
}

/// The elements that aren't changing, rendered once into a bitmap a margin larger than the view:
/// panning and drawing over thousands of elements only blits it. It's redrawn when those
/// elements change (by id, version and nonce), the zoom, theme or pixel scale changes, or the
/// view moves past the margin.
final class StaticLayerCache {
  private struct Key: Equatable {
    var signature: Int
    var zoom: Double
    var theme: DrawingTheme
    var scale: Double
  }

  private var key: Key?
  private var image: CGImage?
  /// The scene rectangle the image covers.
  private var covered = DrawingRect(minX: 0, minY: 0, maxX: 0, maxY: 0)
  private(set) var renderCount = 0

  /// Fraction of the view added on each side.
  static let margin = 0.5

  func invalidate() {
    key = nil
    image = nil
  }

  /// Draws the static elements into a y-down view context.
  func draw(
    elements: [ExcalidrawElement], index: SceneRenderer.Index, skipping skipped: Set<String>,
    renderer: SceneRenderer, viewport: DrawingViewport, viewSize: CGSize, scale: Double,
    theme: DrawingTheme, canvasBackground: String, hairlineZoom: Double, in context: CGContext
  ) {
    var hasher = Hasher()
    for element in elements where !element.isDeleted && !skipped.contains(element.id) {
      hasher.combine(element.id)
      hasher.combine(element.version)
      hasher.combine(element.versionNonce)
    }
    hasher.combine(skipped.count)
    hasher.combine(hairlineZoom)
    let newKey = Key(signature: hasher.finalize(), zoom: viewport.zoom, theme: theme, scale: scale)
    let visible = viewport.visibleRect(size: viewSize)
    if newKey != key || image == nil || !covered.contains(visible) {
      render(
        elements: elements, index: index, skipping: skipped, renderer: renderer, viewport: viewport,
        viewSize: viewSize, scale: scale, theme: theme, canvasBackground: canvasBackground,
        hairlineZoom: hairlineZoom)
      key = newKey
    }
    guard let image else { return }
    let topLeft = viewport.sceneToView(DrawingPoint(covered.minX, covered.minY))
    let rect = CGRect(
      x: topLeft.x, y: topLeft.y, width: covered.width * viewport.zoom,
      height: covered.height * viewport.zoom)
    context.saveGState()
    // The context is y-down; images draw y-up.
    context.translateBy(x: rect.minX, y: rect.maxY)
    context.scaleBy(x: 1, y: -1)
    context.interpolationQuality = .none
    context.draw(image, in: CGRect(origin: .zero, size: rect.size))
    context.restoreGState()
  }

  private func render(
    elements: [ExcalidrawElement], index: SceneRenderer.Index, skipping skipped: Set<String>,
    renderer: SceneRenderer, viewport: DrawingViewport, viewSize: CGSize, scale: Double,
    theme: DrawingTheme, canvasBackground: String, hairlineZoom: Double
  ) {
    let visible = viewport.visibleRect(size: viewSize)
    let marginX = visible.width * Self.margin
    let marginY = visible.height * Self.margin
    let region = DrawingRect(
      minX: visible.minX - marginX, minY: visible.minY - marginY, maxX: visible.maxX + marginX,
      maxY: visible.maxY + marginY)
    let pixelsPerUnit = viewport.zoom * scale
    let width = max(1, Int((region.width * pixelsPerUnit).rounded(.up)))
    let height = max(1, Int((region.height * pixelsPerUnit).rounded(.up)))
    guard
      let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
          | CGBitmapInfo.byteOrder32Little.rawValue)
    else {
      image = nil
      return
    }
    context.translateBy(x: 0, y: Double(height))
    context.scaleBy(x: pixelsPerUnit, y: -pixelsPerUnit)
    context.translateBy(x: -region.minX, y: -region.minY)
    renderer.draw(
      elements, index: index, in: context, theme: theme, canvasBackground: canvasBackground,
      visibleRect: region, zoom: hairlineZoom, skipping: skipped)
    image = context.makeImage()
    covered = region
    renderCount += 1
  }
}
