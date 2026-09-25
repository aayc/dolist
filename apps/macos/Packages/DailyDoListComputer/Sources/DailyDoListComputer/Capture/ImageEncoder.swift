import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct EncodedImage: Sendable {
  var data: Data
  var width: Int
  var height: Int
}

/// Scales captures down and encodes them as JPEG (ImageIO).
enum ImageEncoder {
  static let jpegQuality = 0.7

  /// `width`×`height` scaled down (never up) so the longer side is at most `maxSide`, like the
  /// screen-level screenshot (`sips -Z`).
  static func fittedSize(width: Int, height: Int, maxSide: Int) -> (width: Int, height: Int) {
    let longer = max(width, height)
    guard longer > maxSide, longer > 0 else { return (width, height) }
    let factor = Double(maxSide) / Double(longer)
    return (
      max(1, Int((Double(width) * factor).rounded())),
      max(1, Int((Double(height) * factor).rounded()))
    )
  }

  /// Transparent pixels (a window's rounded corners) come out white.
  static func jpeg(_ image: CGImage, maxSide: Int, quality: Double = jpegQuality) throws
    -> EncodedImage
  {
    let size = fittedSize(width: image.width, height: image.height, maxSide: maxSide)
    guard
      let context = CGContext(
        data: nil, width: size.width, height: size.height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { throw ComputerError.failed("Couldn't allocate the screenshot.") }
    let bounds = CGRect(x: 0, y: 0, width: size.width, height: size.height)
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(bounds)
    context.interpolationQuality = .high
    context.draw(image, in: bounds)
    guard let scaled = context.makeImage() else {
      throw ComputerError.failed("Couldn't scale the screenshot.")
    }
    let data = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        data as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil)
    else { throw ComputerError.failed("Couldn't encode the screenshot.") }
    CGImageDestinationAddImage(
      destination, scaled, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else {
      throw ComputerError.failed("Couldn't encode the screenshot.")
    }
    return EncodedImage(data: data as Data, width: size.width, height: size.height)
  }
}
