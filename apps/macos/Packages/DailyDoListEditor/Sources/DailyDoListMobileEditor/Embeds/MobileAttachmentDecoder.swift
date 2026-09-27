#if canImport(UIKit)
  import CoreGraphics
  import DailyDoListMobileDrawing
  import Foundation
  import ImageIO

  struct MobileAttachmentPreview: Sendable {
    let image: CGImage
    let naturalSize: CGSize
    let pageCount: Int
  }

  /// Serial, bounded decoding off the UI actor. No external URLs or PDF actions are evaluated.
  actor MobileAttachmentDecoder {
    static let maximumBytes = 32 * 1024 * 1024
    static let shared = MobileAttachmentDecoder()
    private var cache: [String: MobileAttachmentPreview] = [:]
    private var order: [String] = []
    private var cost = 0
    private let maximumCost = 32 * 1024 * 1024

    func preview(_ attachment: MobileEditorAttachment, identity: String, page: Int = 1)
      -> MobileAttachmentPreview?
    {
      guard !attachment.data.isEmpty, attachment.data.count <= Self.maximumBytes else { return nil }
      let key = "\(identity)\u{0}\(attachment.path)\u{0}\(attachment.version)\u{0}\(page)"
      if let cached = cache[key] {
        order.removeAll { $0 == key }
        order.append(key)
        return cached
      }
      let result: MobileAttachmentPreview?
      if attachment.mimeType.lowercased() == "application/pdf" {
        result = pdf(attachment.data, page: page)
      } else if attachment.mimeType.lowercased().hasPrefix("image/") {
        result = image(attachment.data)
      } else {
        result = nil
      }
      guard let result else { return nil }
      let bytes = result.image.bytesPerRow * result.image.height
      while cost + bytes > maximumCost, let oldest = order.first {
        order.removeFirst()
        if let removed = cache.removeValue(forKey: oldest) {
          cost -= removed.image.bytesPerRow * removed.image.height
        }
      }
      if bytes <= maximumCost {
        cache[key] = result
        order.append(key)
        cost += bytes
      }
      return result
    }

    private func image(_ data: Data) -> MobileAttachmentPreview? {
      if let source = CGImageSourceCreateWithData(data as CFData, nil),
        let image = CGImageSourceCreateThumbnailAtIndex(
          source, 0,
          [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 1600,
            kCGImageSourceShouldCacheImmediately: true,
          ] as CFDictionary)
      {
        return MobileAttachmentPreview(
          image: image, naturalSize: CGSize(width: image.width, height: image.height), pageCount: 1)
      }
      guard let image = StaticSVGImage.decode(data) else { return nil }
      let natural = CGSize(width: image.width, height: image.height)
      let scale = min(1, 1600 / max(natural.width, natural.height))
      guard scale < 1 else {
        return MobileAttachmentPreview(image: image, naturalSize: natural, pageCount: 1)
      }
      guard
        let context = CGContext(
          data: nil, width: max(1, Int(natural.width * scale)),
          height: max(1, Int(natural.height * scale)), bitsPerComponent: 8, bytesPerRow: 0,
          space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return nil }
      context.draw(image, in: CGRect(x: 0, y: 0, width: context.width, height: context.height))
      guard let thumbnail = context.makeImage() else { return nil }
      return MobileAttachmentPreview(image: thumbnail, naturalSize: natural, pageCount: 1)
    }

    private func pdf(_ data: Data, page index: Int) -> MobileAttachmentPreview? {
      guard let provider = CGDataProvider(data: data as CFData),
        let document = CGPDFDocument(provider), !document.isEncrypted,
        document.numberOfPages > 0, let page = document.page(at: index)
      else { return nil }
      let box = page.getBoxRect(.cropBox)
      guard box.width.isFinite, box.height.isFinite, box.width > 0, box.height > 0 else {
        return nil
      }
      let scale = min(1600 / box.width, 1600 / box.height)
      let size = CGSize(
        width: max(1, floor(box.width * scale)), height: max(1, floor(box.height * scale)))
      guard
        let context = CGContext(
          data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8,
          bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return nil }
      context.setFillColor(CGColor(gray: 1, alpha: 1))
      context.fill(CGRect(origin: .zero, size: size))
      context.concatenate(
        page.getDrawingTransform(
          .cropBox, rect: CGRect(origin: .zero, size: size), rotate: 0, preserveAspectRatio: true))
      context.drawPDFPage(page)
      guard let image = context.makeImage() else { return nil }
      return MobileAttachmentPreview(
        image: image, naturalSize: box.size, pageCount: document.numberOfPages)
    }
  }
#endif
