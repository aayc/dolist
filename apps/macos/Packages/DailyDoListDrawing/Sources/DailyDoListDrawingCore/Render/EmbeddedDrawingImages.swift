import CoreGraphics
import Foundation
import ImageIO

/// Only embedded image bytes are decoded. A scene can never make the renderer fetch a URL.
public enum EmbeddedDrawingImages {
  public static let maximumBytes = 32 * 1024 * 1024
  public static let maximumDimension = 4096

  public static func data(from dataURL: String) -> Data? {
    guard dataURL.utf8.count <= maximumBytes * 4 / 3 + 128,
      let comma = dataURL.firstIndex(of: ",")
    else { return nil }
    let header = dataURL[..<comma].lowercased()
    guard header.hasPrefix("data:image/"), header.hasSuffix(";base64"),
      let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])),
      data.count <= maximumBytes
    else { return nil }
    return data
  }

  public static func decode(_ data: Data) -> CGImage? {
    guard !data.isEmpty, data.count <= maximumBytes else { return nil }
    if let prefix = String(data: data.prefix(256), encoding: .utf8),
      prefix.trimmingCharacters(
        in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}"))
      ).hasPrefix("<")
    {
      return StaticSVGImage.decode(data)
    }
    return decodeRaster(data)
  }

  static func decodeRaster(_ data: Data) -> CGImage? {
    guard !data.isEmpty, data.count <= maximumBytes,
      let source = CGImageSourceCreateWithData(data as CFData, nil)
    else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maximumDimension,
      kCGImageSourceShouldCacheImmediately: true,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
  }
}

/// Decoded images are bounded and keyed by file ID plus the original data URL. Keeping the
/// source string also invalidates a replaced file with the same ID without hashing bytes per frame.
final class EmbeddedDrawingImageCache: @unchecked Sendable {
  private struct Entry {
    var dataURL: String
    var image: CGImage
  }
  private let lock = NSLock()
  private var entries: [String: Entry] = [:]
  private var order: [String] = []
  private var cost = 0
  private let maximumCost = 64 * 1024 * 1024

  func image(id: String, files: JSONValue) -> CGImage? {
    guard let dataURL = files.objectValue?[id]?.objectValue?["dataURL"]?.stringValue else {
      return nil
    }
    if let image = lock.withLock({ () -> CGImage? in
      guard let entry = entries[id], entry.dataURL == dataURL else { return nil }
      order.removeAll { $0 == id }
      order.append(id)
      return entry.image
    }) {
      return image
    }
    guard let data = EmbeddedDrawingImages.data(from: dataURL),
      let image = EmbeddedDrawingImages.decode(data)
    else { return nil }
    lock.withLock {
      if let previous = entries[id] { cost -= previous.image.bytesPerRow * previous.image.height }
      entries[id] = Entry(dataURL: dataURL, image: image)
      order.removeAll { $0 == id }
      order.append(id)
      cost += image.bytesPerRow * image.height
      while cost > maximumCost, order.count > 1 {
        let removed = order.removeFirst()
        if let old = entries.removeValue(forKey: removed) {
          cost -= old.image.bytesPerRow * old.image.height
        }
      }
    }
    return image
  }
}

extension SceneRenderer {
  func drawEmbeddedImage(_ element: ExcalidrawElement, files: JSONValue, in context: CGContext)
    -> Bool
  {
    guard let id = element.fileId, var image = images.image(id: id, files: files) else {
      return false
    }
    if let crop = element.extraField("crop")?.objectValue,
      let x = crop["x"]?.numberValue, let y = crop["y"]?.numberValue,
      let width = crop["width"]?.numberValue, let height = crop["height"]?.numberValue,
      let naturalWidth = crop["naturalWidth"]?.numberValue,
      let naturalHeight = crop["naturalHeight"]?.numberValue,
      [x, y, width, height, naturalWidth, naturalHeight].allSatisfy({ $0.isFinite }),
      width > 0, height > 0, naturalWidth > 0, naturalHeight > 0
    {
      let cropRect = CGRect(
        x: x / naturalWidth * Double(image.width), y: y / naturalHeight * Double(image.height),
        width: width / naturalWidth * Double(image.width),
        height: height / naturalHeight * Double(image.height))
      if let cropped = image.cropping(to: cropRect) { image = cropped }
    }
    let scale = element.extraField("scale")?.arrayValue
    let flippedX = (scale?.first?.numberValue ?? 1) < 0
    let flippedY = (scale?.last?.numberValue ?? 1) < 0
    context.saveGState()
    context.translateBy(x: flippedX ? element.width : 0, y: flippedY ? 0 : element.height)
    context.scaleBy(x: flippedX ? -1 : 1, y: flippedY ? 1 : -1)
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: element.width, height: element.height))
    context.restoreGState()
    return true
  }
}
