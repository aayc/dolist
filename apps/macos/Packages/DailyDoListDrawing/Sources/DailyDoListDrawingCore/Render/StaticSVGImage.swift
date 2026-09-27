import CoreGraphics
import Foundation

#if canImport(FoundationXML)
  import FoundationXML
#endif

/// A deliberately restricted static SVG decoder. It never resolves entities, CSS, fonts,
/// links or URLs. Unsupported constructs reject the complete image; original bytes stay in files.
public enum StaticSVGImage {
  public static func decode(_ data: Data) -> CGImage? {
    guard data.count <= 2_000_000, let source = String(data: data, encoding: .utf8),
      !source.lowercased().contains("<!doctype"), !source.lowercased().contains("<!entity")
    else { return nil }
    let delegate = StaticSVGParser()
    let parser = XMLParser(data: data)
    parser.shouldResolveExternalEntities = false
    parser.delegate = delegate
    guard parser.parse(), !delegate.failed, let root = delegate.root, root.name == "svg" else {
      return nil
    }
    let box: CGRect
    if let value = root.attributes["viewBox"] {
      guard let values = StaticSVGNumbers.list(value), values.count == 4, values[2] > 0,
        values[3] > 0
      else { return nil }
      box = CGRect(x: values[0], y: values[1], width: values[2], height: values[3])
    } else {
      box = CGRect(x: 0, y: 0, width: root.number("width", 300), height: root.number("height", 150))
    }
    let width = root.number("width", box.width)
    let height = root.number("height", box.height)
    guard width > 0, height > 0, box.width > 0, box.height > 0 else { return nil }
    let scale = min(1, Double(EmbeddedDrawingImages.maximumDimension) / max(width, height))
    let pixelWidth = max(1, Int((width * scale).rounded(.up)))
    let pixelHeight = max(1, Int((height * scale).rounded(.up)))
    guard
      let context = CGContext(
        data: nil, width: pixelWidth, height: pixelHeight,
        bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    context.translateBy(x: 0, y: Double(pixelHeight))
    context.scaleBy(x: scale, y: -scale)
    let sx = width / box.width
    let sy = height / box.height
    if root.attributes["preserveAspectRatio"] == "none" {
      context.scaleBy(x: sx, y: sy)
    } else {
      let fit = min(sx, sy)
      context.translateBy(x: (width - box.width * fit) / 2, y: (height - box.height * fit) / 2)
      context.scaleBy(x: fit, y: fit)
    }
    context.translateBy(x: -box.minX, y: -box.minY)
    guard draw(root, in: context, inherited: [:], definitions: delegate.definitions) else {
      return nil
    }
    return context.makeImage()
  }

  private static func draw(
    _ node: StaticSVGNode, in context: CGContext, inherited: [String: String],
    definitions: [String: StaticSVGNode]
  ) -> Bool {
    if ["defs", "clipPath", "title", "desc"].contains(node.name) { return true }
    var style = inherited
    for (key, value) in node.attributes where StaticSVGParser.styles.contains(key) {
      style[key] = value
    }
    context.saveGState()
    defer { context.restoreGState() }
    if let transform = node.attributes["transform"] {
      guard let value = StaticSVGPath.transform(transform) else { return false }
      context.concatenate(value)
    }
    if let clip = node.attributes["clip-path"] {
      guard clip.hasPrefix("url(#"), clip.hasSuffix(")"),
        let definition = definitions[String(clip.dropFirst(5).dropLast())],
        definition.name == "clipPath"
      else { return false }
      let path = CGMutablePath()
      for child in definition.children {
        guard let shape = child.path() else { return false }
        if let raw = child.attributes["transform"] {
          guard let transform = StaticSVGPath.transform(raw) else { return false }
          path.addPath(shape, transform: transform)
        } else {
          path.addPath(shape)
        }
      }
      context.addPath(path)
      context.clip(
        using: definition.children.contains { $0.attributes["clip-rule"] == "evenodd" }
          ? .evenOdd : .winding)
    }
    context.setAlpha(node.number("opacity", 1))
    context.beginTransparencyLayer(auxiliaryInfo: nil)
    defer { context.endTransparencyLayer() }
    context.setAlpha(1)
    if node.name == "image" {
      guard let url = node.attributes["href"] ?? node.attributes["xlink:href"],
        let bytes = EmbeddedDrawingImages.data(from: url),
        let image = EmbeddedDrawingImages.decodeRaster(bytes)
      else { return false }
      let x = node.number("x")
      let y = node.number("y")
      let width = node.number("width", Double(image.width))
      let height = node.number("height", Double(image.height))
      guard width > 0, height > 0 else { return false }
      var rect = CGRect(x: x, y: y, width: width, height: height)
      if node.attributes["preserveAspectRatio"] != "none" {
        let fit = min(width / Double(image.width), height / Double(image.height))
        let w = Double(image.width) * fit
        let h = Double(image.height) * fit
        rect = CGRect(x: x + (width - w) / 2, y: y + (height - h) / 2, width: w, height: h)
      }
      context.translateBy(x: rect.minX, y: rect.maxY)
      context.scaleBy(x: 1, y: -1)
      context.draw(image, in: CGRect(origin: .zero, size: rect.size))
    } else if let path = node.path() {
      func color(_ name: String, default fallback: String) -> CGColor? {
        var value = style[name] ?? fallback
        if value == "none" { return DrawingColor.clear.cgColor }
        if value == "currentColor" { value = style["color"] ?? "black" }
        guard var color = DrawingColor.parse(value) else { return nil }
        color.alpha *= Double(style[name + "-opacity"] ?? "1") ?? 1
        return color.cgColor
      }
      guard let fill = color("fill", default: "black"),
        let stroke = color("stroke", default: "none")
      else { return false }
      context.addPath(path)
      context.setFillColor(fill)
      context.fillPath(using: style["fill-rule"] == "evenodd" ? .evenOdd : .winding)
      context.addPath(path)
      context.setStrokeColor(stroke)
      context.setLineWidth(Double(style["stroke-width"] ?? "1") ?? 1)
      context.setLineCap(
        style["stroke-linecap"] == "round"
          ? .round : style["stroke-linecap"] == "square" ? .square : .butt)
      context.setLineJoin(
        style["stroke-linejoin"] == "round"
          ? .round : style["stroke-linejoin"] == "bevel" ? .bevel : .miter)
      if let dash = style["stroke-dasharray"], dash != "none" {
        guard let values = StaticSVGNumbers.list(dash), !values.isEmpty,
          values.allSatisfy({ $0 >= 0 }), values.contains(where: { $0 > 0 })
        else { return false }
        context.setLineDash(
          phase: Double(style["stroke-dashoffset"] ?? "0") ?? 0, lengths: values.map { CGFloat($0) }
        )
      }
      context.strokePath()
    } else if !["svg", "g"].contains(node.name) {
      return false
    }
    for child in node.children
    where !draw(child, in: context, inherited: style, definitions: definitions) { return false }
    return true
  }
}

private final class StaticSVGNode {
  let name: String
  let attributes: [String: String]
  var children: [StaticSVGNode] = []
  init(name: String, attributes: [String: String]) {
    self.name = name
    self.attributes = attributes
  }
  func number(_ key: String, _ fallback: Double = 0) -> Double {
    attributes[key].flatMap { Double($0.replacingOccurrences(of: "px", with: "")) } ?? fallback
  }
  func path() -> CGPath? {
    switch name {
    case "path": return StaticSVGPath.decode(attributes["d"] ?? "")
    case "rect":
      let box = CGRect(
        x: number("x"), y: number("y"), width: number("width"), height: number("height"))
      guard box.width >= 0, box.height >= 0 else { return nil }
      let rx = number("rx", number("ry"))
      let ry = number("ry", rx)
      return CGPath(
        roundedRect: box, cornerWidth: min(rx, box.width / 2),
        cornerHeight: min(ry, box.height / 2), transform: nil)
    case "circle", "ellipse":
      let rx = name == "circle" ? number("r") : number("rx")
      let ry = name == "circle" ? rx : number("ry")
      guard rx >= 0, ry >= 0 else { return nil }
      return CGPath(
        ellipseIn: CGRect(
          x: number("cx") - rx, y: number("cy") - ry, width: 2 * rx, height: 2 * ry), transform: nil
      )
    case "line":
      let path = CGMutablePath()
      path.move(to: CGPoint(x: number("x1"), y: number("y1")))
      path.addLine(to: CGPoint(x: number("x2"), y: number("y2")))
      return path
    case "polygon", "polyline":
      guard let values = StaticSVGNumbers.list(attributes["points"] ?? ""), values.count >= 4,
        values.count.isMultiple(of: 2)
      else { return nil }
      let path = CGMutablePath()
      path.move(to: CGPoint(x: values[0], y: values[1]))
      for i in stride(from: 2, to: values.count, by: 2) {
        path.addLine(to: CGPoint(x: values[i], y: values[i + 1]))
      }
      if name == "polygon" { path.closeSubpath() }
      return path
    default: return nil
    }
  }
}

private final class StaticSVGParser: NSObject, XMLParserDelegate {
  static let styles: Set<String> = [
    "fill", "stroke", "color", "fill-opacity", "stroke-opacity", "stroke-width", "stroke-linecap",
    "stroke-linejoin", "fill-rule", "stroke-dasharray", "stroke-dashoffset",
  ]
  static let numeric: Set<String> = [
    "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "rx", "ry", "r", "width", "height", "opacity",
    "fill-opacity", "stroke-opacity", "stroke-width", "stroke-dashoffset",
  ]
  static let attributes = styles.union(numeric).union([
    "xmlns", "version", "viewBox", "preserveAspectRatio", "d", "points", "id", "transform",
    "clip-path", "clip-rule", "clipPathUnits", "style", "href", "xlink:href", "xmlns:xlink",
  ])
  var root: StaticSVGNode?
  var definitions: [String: StaticSVGNode] = [:]
  var stack: [StaticSVGNode] = []
  var failed = false
  var count = 0
  func parser(
    _ parser: XMLParser, didStartElement name: String, namespaceURI: String?,
    qualifiedName: String?, attributes raw: [String: String]
  ) {
    count += 1
    guard count <= 10_000, stack.count < 64,
      [
        "svg", "g", "defs", "clipPath", "title", "desc", "path", "rect", "circle", "ellipse",
        "line", "polygon", "polyline", "image",
      ].contains(name),
      raw.keys.allSatisfy({ Self.attributes.contains($0) })
    else {
      reject(parser)
      return
    }
    var attributes = raw
    if let style = attributes.removeValue(forKey: "style") {
      for declaration in style.split(separator: ";") {
        let parts = declaration.split(separator: ":", maxSplits: 1).map {
          $0.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard parts.count == 2, Self.styles.contains(parts[0]) || parts[0] == "opacity" else {
          reject(parser)
          return
        }
        attributes[parts[0]] = parts[1]
      }
    }
    for (key, value) in attributes where Self.numeric.contains(key) {
      guard let number = Double(value.replacingOccurrences(of: "px", with: "")), number.isFinite,
        abs(number) <= 1e9
      else {
        reject(parser)
        return
      }
    }
    if let aspect = attributes["preserveAspectRatio"],
      !["none", "xMidYMid", "xMidYMid meet"].contains(aspect)
    {
      reject(parser)
      return
    }
    if let units = attributes["clipPathUnits"], units != "userSpaceOnUse" {
      reject(parser)
      return
    }
    if name == "svg", root != nil {
      reject(parser)
      return
    }
    let node = StaticSVGNode(name: name, attributes: attributes)
    if let id = attributes["id"] {
      guard definitions[id] == nil else {
        reject(parser)
        return
      }
      definitions[id] = node
    }
    if let parent = stack.last { parent.children.append(node) } else { root = node }
    stack.append(node)
  }
  func parser(
    _ parser: XMLParser, didEndElement: String, namespaceURI: String?, qualifiedName: String?
  ) { if !stack.isEmpty { stack.removeLast() } }
  func parser(_ parser: XMLParser, foundCharacters string: String) {
    if !["title", "desc"].contains(stack.last?.name ?? ""), !string.allSatisfy(\.isWhitespace) {
      reject(parser)
    }
  }
  func parser(
    _ parser: XMLParser, foundProcessingInstructionWithTarget target: String, data: String?
  ) { reject(parser) }
  func parser(_ parser: XMLParser, resolveExternalEntityName name: String, systemID: String?)
    -> Data?
  {
    reject(parser)
    return nil
  }
  private func reject(_ parser: XMLParser) {
    failed = true
    parser.abortParsing()
  }
}
