import CoreGraphics
import Foundation

/// What's behind the drawing in a rendered image.
public enum DrawingBackground: Hashable, Sendable {
  /// The scene's `viewBackgroundColor` (themed).
  case scene
  case transparent
  /// A CSS color, not themed.
  case color(String)
}

/// Static renders of a scene: its bounds with Excalidraw's export padding, and a bitmap.
public enum DrawingImage {
  /// `DEFAULT_EXPORT_PADDING`.
  public static let padding: Double = 10

  /// The part of the scene a render shows: every visible element with room for strokes, plus
  /// the padding; a small square for an empty scene.
  public static func contentBounds(
    of scene: ExcalidrawScene, renderer: SceneRenderer = SceneRenderer(), padding: Double = padding
  ) -> DrawingRect {
    let visible = scene.visibleElements
    let index = SceneRenderer.Index(visible)
    var result: DrawingRect?
    for element in visible {
      var box = ElementGeometry.bounds(element)
      if element.type.hasPoints, element.angle == 0,
        let local = renderer.cache.entry(for: element).pointBounds
      {
        box = DrawingRect(
          minX: local.minX + element.x, minY: local.minY + element.y, maxX: local.maxX + element.x,
          maxY: local.maxY + element.y)
      }
      if element.type == .arrow || element.type == .line || element.type == .freedraw {
        box = box.insetBy(-element.strokeWidth * 2)
      }
      if element.type.isFrameLike { box.minY -= 20 }
      if let label = element.boundTextId.flatMap({ index.elements[$0] }) {
        box = box.union(ElementGeometry.bounds(label))
      }
      result = result.map { $0.union(box) } ?? box
    }
    guard let result else {
      return DrawingRect(minX: -padding, minY: -padding, maxX: 100 + padding, maxY: 100 + padding)
    }
    return result.insetBy(-padding)
  }

  /// The size a scene renders at, in points at zoom 1.
  public static func preferredSize(of scene: ExcalidrawScene) -> CGSize {
    let bounds = contentBounds(of: scene)
    return CGSize(width: bounds.width, height: bounds.height)
  }

  /// Renders the scene into a new bitmap, `scale` pixels per scene unit.
  public static func render(
    _ scene: ExcalidrawScene, scale: Double, theme: DrawingTheme,
    background: DrawingBackground = .scene,
    renderer: SceneRenderer = SceneRenderer(), bounds: DrawingRect? = nil
  ) -> CGImage? {
    let bounds = bounds ?? contentBounds(of: scene, renderer: renderer)
    let width = max(1, Int((bounds.width * scale).rounded(.up)))
    let height = max(1, Int((bounds.height * scale).rounded(.up)))
    guard width * height <= 64_000_000,
      let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    // y-down scene coordinates.
    context.translateBy(x: 0, y: Double(height))
    context.scaleBy(x: scale, y: -scale)
    context.translateBy(x: -bounds.minX, y: -bounds.minY)
    fill(background, scene: scene, theme: theme, rect: bounds, in: context)
    let visible = scene.visibleElements
    renderer.draw(
      visible, index: SceneRenderer.Index(visible), in: context, theme: theme,
      canvasBackground: scene.viewBackgroundColor, zoom: scale)
    return context.makeImage()
  }

  static func fill(
    _ background: DrawingBackground, scene: ExcalidrawScene, theme: DrawingTheme, rect: DrawingRect,
    in context: CGContext
  ) {
    let color: CGColor
    switch background {
    case .transparent: return
    case .scene: color = DrawingColorCache.shared.cgColor(scene.viewBackgroundColor, theme: theme)
    case .color(let css): color = DrawingColorCache.shared.cgColor(css, theme: .light)
    }
    context.setFillColor(color)
    context.fill(CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height))
  }
}

/// Rendered previews of drawings for inline display, cached by the scene's content hash, theme,
/// background and pixel width (a few dozen at most, least recently used first out).
public final class DrawingPreviewCache: @unchecked Sendable {
  public struct Key: Hashable, Sendable {
    public var contentHash: UInt64
    public var theme: DrawingTheme
    public var background: DrawingBackground
    public var pixelWidth: Int
  }

  private let lock = NSLock()
  private var images: [Key: CGImage] = [:]
  private var order: [Key] = []
  private let capacity: Int
  private let renderer = SceneRenderer()
  public private(set) var renderCount = 0

  public init(capacity: Int = 48) {
    self.capacity = capacity
  }

  /// The drawing `width` points wide at `displayScale` pixels per point.
  /// - Parameter contentHash: the file's hash if the caller has it (else the scene's).
  public func image(
    for scene: ExcalidrawScene, contentHash: UInt64? = nil, width: Double, displayScale: Double = 2,
    theme: DrawingTheme, background: DrawingBackground = .scene
  ) -> CGImage? {
    let pixelWidth = max(1, Int((width * displayScale).rounded()))
    let key = Key(
      contentHash: contentHash ?? DrawingContentHash.hash(scene), theme: theme,
      background: background,
      pixelWidth: pixelWidth)
    if let image = lock.withLock({ images[key] }) {
      lock.withLock {
        order.removeAll { $0 == key }
        order.append(key)
      }
      return image
    }
    let bounds = DrawingImage.contentBounds(of: scene, renderer: renderer)
    let scale = Double(pixelWidth) / bounds.width
    guard
      let image = DrawingImage.render(
        scene, scale: scale, theme: theme, background: background, renderer: renderer,
        bounds: bounds)
    else { return nil }
    lock.withLock {
      renderCount += 1
      images[key] = image
      order.append(key)
      while order.count > capacity { images.removeValue(forKey: order.removeFirst()) }
    }
    return image
  }

  public func removeAll() {
    lock.withLock {
      images.removeAll()
      order.removeAll()
    }
  }
}
