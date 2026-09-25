import CoreGraphics
import CoreText
import Foundation

/// Draws Excalidraw elements into a CoreGraphics context the way Excalidraw's static scene does:
/// in z-order, bound text right after its container, children clipped to their frame, each
/// element at its opacity, rotated around its center. Coordinates are scene coordinates in a
/// y-down context (the caller sets zoom and scroll on the context).
public final class SceneRenderer: @unchecked Sendable {
  public let cache: ElementRenderCache

  public init(cache: ElementRenderCache = ElementRenderCache()) {
    self.cache = cache
  }

  /// FRAME_STYLE.
  static let frameStrokeColor = "#bbbbbb"
  static let frameRadius: Double = 8
  static let frameNameColors = (light: "#999999", dark: "#7a7a7a")

  /// The scene's elements by id (containers, frames and labels look each other up).
  public struct Index: Sendable {
    public var elements: [String: ExcalidrawElement]

    public init(_ elements: [ExcalidrawElement]) {
      var byId: [String: ExcalidrawElement] = [:]
      byId.reserveCapacity(elements.count)
      for element in elements where !element.isDeleted { byId[element.id] = element }
      self.elements = byId
    }
  }

  /// Draws `elements` (a scene's, or a subset) with their labels.
  /// - Parameters:
  ///   - visibleRect: the part of the scene on screen; elements outside it are skipped.
  ///   - canvasBackground: the canvas color (for outlined arrowheads).
  ///   - zoom: screen pixels per scene unit, for hairlines that keep their width.
  public func draw(
    _ elements: [ExcalidrawElement], index: Index, in context: CGContext, theme: DrawingTheme,
    canvasBackground: String, visibleRect: DrawingRect? = nil, zoom: Double = 1,
    skipping skipped: Set<String> = []
  ) {
    for element in elements where !element.isDeleted && !skipped.contains(element.id) {
      if element.type == .text, let containerId = element.containerId,
        index.elements[containerId] != nil
      {
        continue
      }
      if let visibleRect, !bounds(of: element, index: index).intersects(visibleRect) { continue }
      context.saveGState()
      if let frameId = element.frameId, let frame = index.elements[frameId], frame.type.isFrameLike
      {
        let rect = CGRect(x: frame.x, y: frame.y, width: frame.width, height: frame.height)
        context.addPath(
          CGPath(
            roundedRect: rect, cornerWidth: Self.frameRadius / zoom,
            cornerHeight: Self.frameRadius / zoom, transform: nil))
        context.clip()
      }
      let label = element.boundTextId.flatMap { index.elements[$0] }
      draw(
        element, label: label, in: context, theme: theme, canvasBackground: canvasBackground,
        zoom: zoom)
      if let label, !skipped.contains(label.id) {
        draw(
          label, label: nil, in: context, theme: theme, canvasBackground: canvasBackground,
          zoom: zoom)
      }
      context.restoreGState()
    }
  }

  /// The element's on-screen bounds, with room for its stroke (and its label).
  public func bounds(of element: ExcalidrawElement, index: Index) -> DrawingRect {
    var box: DrawingRect
    if element.type.hasPoints {
      let local =
        cache.entry(for: element).pointBounds ?? DrawingRect(minX: 0, minY: 0, maxX: 0, maxY: 0)
      box = DrawingRect(
        minX: local.minX + element.x, minY: local.minY + element.y, maxX: local.maxX + element.x,
        maxY: local.maxY + element.y)
      if element.angle != 0 { box = ElementGeometry.bounds(element) }
    } else {
      box = ElementGeometry.bounds(element)
    }
    if element.type.isFrameLike { box.minY -= 24 }
    let margin = element.strokeWidth * 4.25 + (element.type == .arrow ? 30 : 4)
    box = box.insetBy(-margin)
    if let labelId = element.boundTextId, let label = index.elements[labelId] {
      box = box.union(ElementGeometry.bounds(label))
    }
    return box
  }

  /// Draws one element (not its label). `label` is its bound text, which arrows leave room for.
  public func draw(
    _ element: ExcalidrawElement, label: ExcalidrawElement? = nil, in context: CGContext,
    theme: DrawingTheme, canvasBackground: String, zoom: Double = 1
  ) {
    let entry = cache.entry(for: element)
    context.saveGState()
    defer { context.restoreGState() }
    context.setAlpha(max(0, min(1, element.opacity / 100)))
    if element.type == .arrow, let label, let text = label.text, !text.text.isEmpty {
      // Excalidraw clears the label's box out of the arrow.
      context.addRect(CGRect(x: -1e7, y: -1e7, width: 2e7, height: 2e7))
      context.addRect(CGRect(x: label.x, y: label.y, width: label.width, height: label.height))
      context.clip(using: .evenOdd)
    }
    // Excalidraw's transform: to the center, rotate, back to the element's origin.
    let box: DrawingRect
    if element.type.hasPoints, let local = entry.pointBounds {
      box = DrawingRect(
        minX: local.minX + element.x, minY: local.minY + element.y, maxX: local.maxX + element.x,
        maxY: local.maxY + element.y)
    } else {
      box = DrawingRect(x: element.x, y: element.y, width: element.width, height: element.height)
    }
    let cx = (box.minX + box.maxX) / 2
    let cy = (box.minY + box.maxY) / 2
    let shiftX = (box.maxX - box.minX) / 2 - (element.x - box.minX)
    let shiftY = (box.maxY - box.minY) / 2 - (element.y - box.minY)
    context.translateBy(x: cx, y: cy)
    if element.angle != 0 { context.rotate(by: element.angle) }
    context.translateBy(x: -shiftX, y: -shiftY)

    switch element.type {
    case .rectangle, .diamond, .ellipse, .line, .arrow, .iframe, .embeddable:
      context.setLineJoin(.round)
      context.setLineCap(.round)
      paint(entry.parts, in: context, theme: theme, canvasBackground: canvasBackground)
    case .freedraw:
      paint(entry.parts, in: context, theme: theme, canvasBackground: canvasBackground)
      if let path = entry.freedrawPath {
        context.setFillColor(DrawingColorCache.shared.cgColor(element.strokeColor, theme: theme))
        context.addPath(path)
        context.fillPath()
      }
    case .text:
      guard let layout = entry.textLayout, let text = element.text else { return }
      context.setFillColor(DrawingColorCache.shared.cgColor(element.strokeColor, theme: theme))
      layout.draw(in: context, width: element.width, align: text.textAlign)
    case .image:
      drawImagePlaceholder(element, in: context, theme: theme)
    case .frame, .magicframe:
      drawFrame(element, in: context, theme: theme, zoom: zoom)
    default:
      drawUnknown(element, in: context, theme: theme, zoom: zoom)
    }
  }

  func paint(
    _ parts: [ShapePart], in context: CGContext, theme: DrawingTheme, canvasBackground: String
  ) {
    let colors = DrawingColorCache.shared
    func color(_ css: String) -> CGColor {
      colors.cgColor(
        css == ExcalidrawShapes.canvasBackground ? canvasBackground : css, theme: theme)
    }
    for part in parts {
      switch part.paint {
      case .stroke(let css, let width, let dash):
        context.setStrokeColor(color(css))
        context.setLineWidth(width)
        if let dash { context.setLineDash(phase: 0, lengths: dash.map { CGFloat($0) }) }
        context.addPath(part.path)
        context.strokePath()
        if dash != nil { context.setLineDash(phase: 0, lengths: []) }
      case .fill(let css, let evenOdd):
        guard !css.isEmpty else { continue }
        context.setFillColor(color(css))
        context.addPath(part.path)
        context.fillPath(using: evenOdd ? .evenOdd : .winding)
      case .sketch(let css, let width):
        guard !css.isEmpty else { continue }
        context.setStrokeColor(color(css))
        context.setLineWidth(width)
        context.addPath(part.path)
        context.strokePath()
      }
    }
  }

  /// `drawImagePlaceholder`: a light gray box with a picture glyph (images aren't loaded yet).
  func drawImagePlaceholder(
    _ element: ExcalidrawElement, in context: CGContext, theme: DrawingTheme
  ) {
    let colors = DrawingColorCache.shared
    context.setFillColor(colors.cgColor("#e7e7e7", theme: theme))
    context.fill(CGRect(x: 0, y: 0, width: element.width, height: element.height))
    let side = min(element.width, element.height)
    let size = min(side, min(side * 0.4, 100))
    guard size > 4 else { return }
    let rect = CGRect(
      x: element.width / 2 - size / 2, y: element.height / 2 - size / 2, width: size,
      height: size * 0.8)
    context.setStrokeColor(colors.cgColor("#9e9e9e", theme: theme))
    context.setFillColor(colors.cgColor("#9e9e9e", theme: theme))
    context.setLineWidth(max(1, size / 18))
    context.setLineJoin(.round)
    context.addPath(
      CGPath(roundedRect: rect, cornerWidth: size / 10, cornerHeight: size / 10, transform: nil))
    context.strokePath()
    context.move(to: CGPoint(x: rect.minX + size * 0.12, y: rect.maxY - size * 0.12))
    context.addLine(to: CGPoint(x: rect.minX + size * 0.4, y: rect.minY + size * 0.4))
    context.addLine(to: CGPoint(x: rect.minX + size * 0.6, y: rect.minY + size * 0.58))
    context.addLine(to: CGPoint(x: rect.minX + size * 0.72, y: rect.minY + size * 0.48))
    context.addLine(to: CGPoint(x: rect.maxX - size * 0.12, y: rect.maxY - size * 0.12))
    context.strokePath()
    context.fillEllipse(
      in: CGRect(
        x: rect.maxX - size * 0.34, y: rect.minY + size * 0.14, width: size * 0.14,
        height: size * 0.14))
  }

  /// A frame's outline and name (Excalidraw draws the name above its top-left corner).
  func drawFrame(
    _ element: ExcalidrawElement, in context: CGContext, theme: DrawingTheme, zoom: Double
  ) {
    let colors = DrawingColorCache.shared
    let rect = CGRect(x: 0, y: 0, width: element.width, height: element.height)
    context.setStrokeColor(colors.cgColor(Self.frameStrokeColor, theme: .light))
    context.setLineWidth(2 / zoom)
    context.addPath(
      CGPath(
        roundedRect: rect, cornerWidth: Self.frameRadius / zoom,
        cornerHeight: Self.frameRadius / zoom, transform: nil))
    context.strokePath()
    let name = element.name ?? (element.type == .magicframe ? "AI Frame" : "Frame")
    let fontSize = 14 / zoom
    let layout = TextLayout(
      text: name, fontSize: fontSize, fontFamily: FontFamily.helvetica, lineHeight: 1.25)
    context.saveGState()
    context.translateBy(x: 0, y: -layout.height - 3 / zoom)
    let nameColor = theme == .light ? Self.frameNameColors.light : Self.frameNameColors.dark
    context.setFillColor(colors.cgColor(nameColor, theme: .light))
    layout.draw(in: context, width: element.width, align: .left)
    context.restoreGState()
  }

  /// Types this engine doesn't know: a dashed box where they are.
  func drawUnknown(
    _ element: ExcalidrawElement, in context: CGContext, theme: DrawingTheme, zoom: Double
  ) {
    guard element.width > 0, element.height > 0 else { return }
    context.setStrokeColor(DrawingColorCache.shared.cgColor("#adb5bd", theme: theme))
    context.setLineWidth(1 / zoom)
    context.setLineDash(phase: 0, lengths: [4 / zoom, 4 / zoom])
    context.stroke(CGRect(x: 0, y: 0, width: element.width, height: element.height))
    context.setLineDash(phase: 0, lengths: [])
  }
}
