import CoreGraphics
import CoreText
import Foundation
import ImageIO

/// A self-contained SVG of the native rendering. Rough strokes and text glyphs remain vectors;
/// embedded images are normalized locally to PNG. No links, scripts or external resources escape.
public enum DrawingSVG {
  public static func render(_ scene: ExcalidrawScene, theme: DrawingTheme = .light) throws -> String
  {
    guard scene.elements.count <= 10_000 else { throw DrawingTransferError.tooLarge }
    let renderer = SceneRenderer()
    let bounds = DrawingImage.contentBounds(of: scene, renderer: renderer)
    guard
      [bounds.minX, bounds.minY, bounds.width, bounds.height].allSatisfy({
        $0.isFinite && abs($0) < 1e9
      })
    else { throw DrawingTransferError.invalid }
    let index = SceneRenderer.Index(scene.elements, files: scene.files)
    var output =
      "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"\(n(bounds.width))\" height=\"\(n(bounds.height))\" viewBox=\"\(n(bounds.minX)) \(n(bounds.minY)) \(n(bounds.width)) \(n(bounds.height))\">"
    for (ordinal, element) in scene.visibleElements.enumerated() {
      if element.type == .text, let container = element.containerId,
        index.elements[container] != nil
      {
        continue
      }
      let label = element.boundTextId.flatMap { index.elements[$0] }
      if let id = element.frameId, let frame = index.elements[id] {
        output +=
          "<defs><clipPath id=\"frame\(ordinal)\"><rect x=\"\(n(frame.x))\" y=\"\(n(frame.y))\" width=\"\(n(frame.width))\" height=\"\(n(frame.height))\" rx=\"8\"/></clipPath></defs><g clip-path=\"url(#frame\(ordinal))\">"
      }
      if element.type == .arrow, let label, label.text?.text.isEmpty == false {
        output +=
          "<defs><clipPath id=\"label\(ordinal)\"><path clip-rule=\"evenodd\" d=\"M-10000000 -10000000h20000000v20000000h-20000000z M\(n(label.x)) \(n(label.y))h\(n(label.width))v\(n(label.height))h-\(n(label.width))z\"/></clipPath></defs><g clip-path=\"url(#label\(ordinal))\">"
      }
      output += try draw(element, scene: scene, renderer: renderer, theme: theme)
      if element.type == .arrow, let label, label.text?.text.isEmpty == false { output += "</g>" }
      if let label { output += try draw(label, scene: scene, renderer: renderer, theme: theme) }
      if let id = element.frameId, index.elements[id] != nil { output += "</g>" }
      guard output.utf8.count <= DrawingClipboard.maximumBytes else {
        throw DrawingTransferError.tooLarge
      }
    }
    return output + "</svg>"
  }

  private static func draw(
    _ element: ExcalidrawElement, scene: ExcalidrawScene,
    renderer: SceneRenderer, theme: DrawingTheme
  ) throws -> String {
    let entry = renderer.cache.entry(for: element)
    let box =
      entry.pointBounds ?? DrawingRect(x: 0, y: 0, width: element.width, height: element.height)
    let center = DrawingPoint(element.x + box.center.x, element.y + box.center.y)
    var result =
      "<g opacity=\"\(n(max(0, min(1, element.opacity / 100))))\" transform=\"translate(\(n(center.x)) \(n(center.y))) rotate(\(n(element.angle * 180 / .pi))) translate(\(n(-box.center.x)) \(n(-box.center.y)))\" stroke-linecap=\"round\" stroke-linejoin=\"round\">"
    func paint(_ css: String, _ attribute: String) -> String {
      let value = css == ExcalidrawShapes.canvasBackground ? scene.viewBackgroundColor : css
      let color = (DrawingColor.parse(value) ?? .black).themed(theme)
      return
        "\(attribute)=\"rgb(\(n(color.red * 255)),\(n(color.green * 255)),\(n(color.blue * 255)))\" \(attribute)-opacity=\"\(n(color.alpha))\""
    }
    for part in entry.parts {
      let style: String
      switch part.paint {
      case .fill(let color, let evenOdd):
        if color.isEmpty { continue }
        style = paint(color, "fill") + " fill-rule=\"\(evenOdd ? "evenodd" : "nonzero")\""
      case .stroke(let color, let width, let dash):
        style =
          "fill=\"none\" " + paint(color, "stroke") + " stroke-width=\"\(n(width))\""
          + (dash.map { " stroke-dasharray=\"\($0.map(n).joined(separator: " "))\"" } ?? "")
      case .sketch(let color, let width):
        if color.isEmpty { continue }
        style = "fill=\"none\" " + paint(color, "stroke") + " stroke-width=\"\(n(width))\""
      }
      result += "<path d=\"\(path(part.path))\" \(style)/>"
    }
    if let freehand = entry.freedrawPath {
      result += "<path d=\"\(path(freehand))\" \(paint(element.strokeColor, "fill"))/>"
    }
    if let text = element.text, let layout = entry.textLayout {
      result +=
        "<path d=\"\(glyphs(layout, width: element.width, align: text.textAlign))\" \(paint(element.strokeColor, "fill"))/>"
    }
    if element.type == .image {
      var normalized = element
      normalized.x = 0
      normalized.y = 0
      normalized.angle = 0
      normalized.opacity = 100
      normalized.frameId = nil
      let scale = min(1, 4096 / max(1, element.width, element.height))
      if let image = DrawingImage.render(
        .init(elements: [normalized], files: scene.files), scale: scale,
        theme: theme, background: .transparent,
        bounds: .init(x: 0, y: 0, width: element.width, height: element.height))
      {
        let data = NSMutableData()
        if let destination = CGImageDestinationCreateWithData(
          data, "public.png" as CFString, 1, nil)
        {
          CGImageDestinationAddImage(destination, image, nil)
          if CGImageDestinationFinalize(destination) {
            result +=
              "<image width=\"\(n(element.width))\" height=\"\(n(element.height))\" href=\"data:image/png;base64,\((data as Data).base64EncodedString())\"/>"
          }
        }
      }
    }
    if element.type.isFrameLike {
      result +=
        "<rect width=\"\(n(element.width))\" height=\"\(n(element.height))\" rx=\"8\" fill=\"none\" \(paint("#bbbbbb", "stroke"))/>"
      let layout = TextLayout(
        text: element.name ?? "Frame", fontSize: 14, fontFamily: FontFamily.helvetica,
        lineHeight: 1.15)
      result +=
        "<g transform=\"translate(0 -22)\"><path d=\"\(glyphs(layout, width: element.width, align: .left))\" \(paint("#999999", "fill"))/></g>"
    }
    return result + "</g>"
  }

  static func path(_ path: CGPath) -> String {
    var parts: [String] = []
    path.applyWithBlock { pointer in
      let value = pointer.pointee
      func p(_ i: Int) -> String { "\(n(value.points[i].x)) \(n(value.points[i].y))" }
      switch value.type {
      case .moveToPoint: parts.append("M" + p(0))
      case .addLineToPoint: parts.append("L" + p(0))
      case .addQuadCurveToPoint: parts.append("Q" + p(0) + " " + p(1))
      case .addCurveToPoint: parts.append("C" + p(0) + " " + p(1) + " " + p(2))
      case .closeSubpath: parts.append("Z")
      @unknown default: break
      }
    }
    return parts.joined(separator: " ")
  }

  private static func glyphs(_ layout: TextLayout, width: Double, align: TextAlign) -> String {
    var result = ""
    for (index, line) in layout.ctLines.enumerated() {
      let x =
        align == .center
        ? (width - layout.lineWidths[index]) / 2
        : align == .right ? width - layout.lineWidths[index] : 0
      let baseline = Double(index) * layout.lineHeightPx + layout.verticalOffset
      for run in CTLineGetGlyphRuns(line) as! [CTRun] {
        let font = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName] as! CTFont
        let count = CTRunGetGlyphCount(run)
        var glyphs = [CGGlyph](repeating: 0, count: count)
        var positions = [CGPoint](repeating: .zero, count: count)
        CTRunGetGlyphs(run, CFRange(location: 0, length: count), &glyphs)
        CTRunGetPositions(run, CFRange(location: 0, length: count), &positions)
        for i in 0..<count {
          var transform = CGAffineTransform(
            a: 1, b: 0, c: 0, d: -1,
            tx: x + positions[i].x, ty: baseline - positions[i].y)
          if let outline = CTFontCreatePathForGlyph(font, glyphs[i], &transform) {
            result += path(outline) + " "
          }
        }
      }
    }
    return result
  }

  private static func n(_ value: Double) -> String {
    value.isFinite ? String(format: "%.12g", locale: Locale(identifier: "en_US_POSIX"), value) : "0"
  }
}
