#if canImport(UIKit)
  import ImageIO
  import SwiftUI
  import UIKit

  /// Core Graphics images are immutable once decoded; the box only crosses to the main actor to
  /// create a UIImage. Decode and decompression run on this serial worker, with explicit bounds.
  struct MobileDecodedImage: @unchecked Sendable {
    let image: CGImage
  }

  actor MobileImageDecoder {
    static let shared = MobileImageDecoder()
    static let maximumBytes = 32 * 1024 * 1024

    func decode(_ data: Data) -> MobileDecodedImage? {
      guard !Task.isCancelled, data.count <= Self.maximumBytes,
        let source = CGImageSourceCreateWithData(
          data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
        let width = properties[kCGImagePropertyPixelWidth] as? Int,
        let height = properties[kCGImagePropertyPixelHeight] as? Int,
        width > 0, height > 0, width <= 50_000, height <= 50_000,
        Double(width) * Double(height) <= 100_000_000,
        let image = CGImageSourceCreateThumbnailAtIndex(
          source, 0,
          [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 2_048,
            kCGImageSourceShouldCacheImmediately: true,
          ] as CFDictionary), !Task.isCancelled
      else { return nil }
      return MobileDecodedImage(image: image)
    }
  }

  struct MobileZoomableImage: UIViewRepresentable {
    let image: UIImage
    let label: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIScrollView {
      let scroll = ImageScrollView()
      scroll.minimumZoomScale = 1
      scroll.maximumZoomScale = 6
      scroll.delegate = context.coordinator
      scroll.imageView.contentMode = .scaleAspectFit
      scroll.imageView.isAccessibilityElement = true
      scroll.addSubview(scroll.imageView)
      scroll.imageView.accessibilityCustomActions = [
        UIAccessibilityCustomAction(name: "Zoom in") { [weak scroll] _ in
          guard let scroll else { return false }
          scroll.setZoomScale(min(6, scroll.zoomScale * 1.5), animated: false)
          return true
        },
        UIAccessibilityCustomAction(name: "Reset zoom") { [weak scroll] _ in
          scroll?.setZoomScale(1, animated: false)
          return scroll != nil
        },
      ]
      context.coordinator.imageView = scroll.imageView
      return scroll
    }

    func updateUIView(_ uiView: UIScrollView, context: Context) {
      context.coordinator.imageView?.image = image
      context.coordinator.imageView?.accessibilityLabel = label
      uiView.setNeedsLayout()
    }

    final class Coordinator: NSObject, UIScrollViewDelegate {
      weak var imageView: UIImageView?
      func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
    }

    private final class ImageScrollView: UIScrollView {
      let imageView = UIImageView()
      override func layoutSubviews() {
        super.layoutSubviews()
        if zoomScale == 1 { imageView.frame = bounds }
      }
    }
  }
#endif
