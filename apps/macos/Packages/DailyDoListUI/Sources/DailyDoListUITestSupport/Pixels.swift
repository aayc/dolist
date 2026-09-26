import AppKit

extension NSView {
  /// What the view (or `rect` of it) draws, the way the screen would show it.
  public func bitmap(in rect: NSRect? = nil) -> NSBitmapImageRep {
    let rect = rect ?? bounds
    let rep = bitmapImageRepForCachingDisplay(in: rect)!
    cacheDisplay(in: rect, to: rep)
    return rep
  }
}

extension NSBitmapImageRep {
  /// Distinct colors on a coarse grid (`grid` samples a side, `levels` shades a channel), so
  /// snapshot tests can tell a render from a blank one (which has one or two).
  public func distinctColors(grid: Int = 120, levels: Int = 256) -> Int {
    var colors = Set<[Int]>()
    for y in stride(from: 0, to: pixelsHigh, by: max(1, pixelsHigh / grid)) {
      for x in stride(from: 0, to: pixelsWide, by: max(1, pixelsWide / grid)) {
        guard let color = colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
        colors.insert(
          [color.redComponent, color.greenComponent, color.blueComponent].map {
            Int(($0 * CGFloat(levels - 1)).rounded())
          })
      }
    }
    return colors.count
  }

  /// Writes the image to `<directory>/<name>.png` (for eyes; creates the directory).
  @discardableResult
  public func writePNG(_ name: String, in directory: URL) throws -> URL {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent("\(name).png")
    try representation(using: .png, properties: [:])!.write(to: url)
    return url
  }
}

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
