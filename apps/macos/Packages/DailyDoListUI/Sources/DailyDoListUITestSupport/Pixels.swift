import CoreGraphics

/// The image redrawn as 8-bit sRGB RGBA bytes (premultiplied), nil if it can't be drawn.
public func rgbaBytes(_ image: CGImage) -> [UInt8]? {
  var data = [UInt8](repeating: 0, count: image.width * image.height * 4)
  let ok = data.withUnsafeMutableBytes { buffer -> Bool in
    guard
      let context = CGContext(
        data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
        bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return false }
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    return true
  }
  return ok ? data : nil
}

/// Distinct colors on a coarse grid, so snapshot tests can tell a render from a blank one (which
/// has one or two).
public func distinctColors(_ image: CGImage) -> Int {
  guard let data = rgbaBytes(image) else { return 0 }
  var colors = Set<UInt32>()
  for y in stride(from: 0, to: image.height, by: max(1, image.height / 120)) {
    for x in stride(from: 0, to: image.width, by: max(1, image.width / 120)) {
      let offset = (y * image.width + x) * 4
      colors.insert(
        UInt32(data[offset]) << 16 | UInt32(data[offset + 1]) << 8 | UInt32(data[offset + 2]))
    }
  }
  return colors.count
}
