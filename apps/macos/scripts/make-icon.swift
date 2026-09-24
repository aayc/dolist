// Renders the Daily Do List app icon: a macOS-style squircle with a deep purple gradient and a
// white rounded checkbox with a checkmark. Pure CoreGraphics, so it runs with the Command Line
// Tools alone:
//
//   swift apps/macos/scripts/make-icon.swift --iconset build/AppIcon.iconset   # all sizes
//   swift apps/macos/scripts/make-icon.swift --png Resources/AppIcon-1024.png   # one PNG (1024 px)
//   iconutil -c icns -o AppIcon.icns build/AppIcon.iconset
//
// Geometry follows Apple's macOS icon grid: a 824 pt body centered on a 1024 pt canvas, with a
// soft drop shadow in the margin.
import CoreGraphics
import Foundation
import ImageIO

let purpleTop = CGColor(srgbRed: 0x7F / 255, green: 0x6D / 255, blue: 0xF2 / 255, alpha: 1)
let purpleBottom = CGColor(srgbRed: 0x4B / 255, green: 0x3B / 255, blue: 0xB5 / 255, alpha: 1)
let checkPurple = CGColor(srgbRed: 0x55 / 255, green: 0x44 / 255, blue: 0xC4 / 255, alpha: 1)
let white = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)

/// A superellipse ("squircle") inscribed in `rect`: continuous curvature like macOS icons.
func squircle(in rect: CGRect, exponent: CGFloat = 5) -> CGPath {
  let path = CGMutablePath()
  let a = rect.width / 2
  let b = rect.height / 2
  let steps = 720
  for step in 0...steps {
    let t = CGFloat(step) / CGFloat(steps) * 2 * .pi
    let c = cos(t)
    let s = sin(t)
    let x = rect.midX + a * copysign(pow(abs(c), 2 / exponent), c)
    let y = rect.midY + b * copysign(pow(abs(s), 2 / exponent), s)
    if step == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
  }
  path.closeSubpath()
  return path
}

func drawIcon(in context: CGContext, size: CGFloat) {
  let unit = size / 1024
  // Tiny sizes (menu bar, Finder lists) get a bigger checkbox and a bolder check, without the
  // checkbox shadow, so the mark stays legible.
  let tiny = size <= 16
  let small = size <= 32
  context.clear(CGRect(x: 0, y: 0, width: size, height: size))

  // Body with a drop shadow.
  let body = CGRect(x: 100 * unit, y: 100 * unit, width: 824 * unit, height: 824 * unit)
  let bodyPath = squircle(in: body)
  context.saveGState()
  context.setShadow(
    offset: CGSize(width: 0, height: -12 * unit), blur: 28 * unit,
    color: CGColor(srgbRed: 0.1, green: 0.05, blue: 0.3, alpha: 0.35))
  context.addPath(bodyPath)
  context.setFillColor(purpleBottom)
  context.fillPath()
  context.restoreGState()

  // Gradient fill, top (#7F6DF2) to bottom (#4B3BB5).
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  context.saveGState()
  context.addPath(bodyPath)
  context.clip()
  let gradient = CGGradient(
    colorsSpace: space, colors: [purpleTop, purpleBottom] as CFArray, locations: [0, 1])!
  context.drawLinearGradient(
    gradient, start: CGPoint(x: body.midX, y: body.maxY), end: CGPoint(x: body.midX, y: body.minY),
    options: [])
  // A faint sheen on the upper half for depth.
  let sheen = CGGradient(
    colorsSpace: space,
    colors: [
      CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.16), CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0),
    ] as CFArray,
    locations: [0, 1])!
  context.drawLinearGradient(
    sheen, start: CGPoint(x: body.midX, y: body.maxY), end: CGPoint(x: body.midX, y: body.midY),
    options: [])
  context.restoreGState()

  // The checkbox: a white rounded square with a soft shadow.
  let boxSize = (tiny ? 600 : small ? 520 : 430) * unit
  let box = CGRect(x: (size - boxSize) / 2, y: (size - boxSize) / 2 - 6 * unit, width: boxSize, height: boxSize)
  let boxPath = CGPath(
    roundedRect: box, cornerWidth: boxSize * 0.22, cornerHeight: boxSize * 0.22, transform: nil)
  context.saveGState()
  if !small {
    context.setShadow(
      offset: CGSize(width: 0, height: -10 * unit), blur: 24 * unit,
      color: CGColor(srgbRed: 0.08, green: 0.03, blue: 0.25, alpha: 0.35))
  }
  context.addPath(boxPath)
  context.setFillColor(white)
  context.fillPath()
  context.restoreGState()

  // The checkmark, in the icon's purple.
  let check = CGMutablePath()
  check.move(to: CGPoint(x: box.minX + boxSize * 0.24, y: box.minY + boxSize * 0.52))
  check.addLine(to: CGPoint(x: box.minX + boxSize * 0.43, y: box.minY + boxSize * 0.32))
  check.addLine(to: CGPoint(x: box.minX + boxSize * 0.77, y: box.minY + boxSize * 0.71))
  context.saveGState()
  context.addPath(check)
  context.setStrokeColor(checkPurple)
  context.setLineWidth(boxSize * (small ? 0.17 : 0.13))
  context.setLineCap(.round)
  context.setLineJoin(.round)
  context.strokePath()
  context.restoreGState()
}

func renderPNG(size pixels: Int, to url: URL) throws {
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  guard
    let context = CGContext(
      data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: space,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { throw IconError("could not create a \(pixels)px bitmap") }
  context.interpolationQuality = .high
  context.setShouldAntialias(true)
  drawIcon(in: context, size: CGFloat(pixels))
  guard let image = context.makeImage(),
    let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)
  else { throw IconError("could not encode \(url.lastPathComponent)") }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else { throw IconError("could not write \(url.path)") }
}

struct IconError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

/// iconutil's expected file names: 16…512 pt at @1x and @2x.
let iconsetImages: [(name: String, pixels: Int)] = [16, 32, 128, 256, 512].flatMap { points in
  [("icon_\(points)x\(points).png", points), ("icon_\(points)x\(points)@2x.png", points * 2)]
}

func run() throws {
  var arguments = Array(CommandLine.arguments.dropFirst())
  var iconset: String?
  var png: String?
  var size = 1024
  while !arguments.isEmpty {
    let argument = arguments.removeFirst()
    switch argument {
    case "--iconset": iconset = arguments.isEmpty ? nil : arguments.removeFirst()
    case "--png": png = arguments.isEmpty ? nil : arguments.removeFirst()
    case "--size": size = arguments.isEmpty ? size : Int(arguments.removeFirst()) ?? size
    default: throw IconError("unknown argument \(argument). Usage: make-icon.swift [--iconset DIR] [--png FILE [--size N]]")
    }
  }
  if iconset == nil && png == nil { iconset = "AppIcon.iconset" }
  if let iconset {
    let directory = URL(fileURLWithPath: iconset, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    for image in iconsetImages {
      try renderPNG(size: image.pixels, to: directory.appendingPathComponent(image.name))
    }
    print("Wrote \(iconsetImages.count) images to \(iconset)")
  }
  if let png {
    let url = URL(fileURLWithPath: png)
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try renderPNG(size: size, to: url)
    print("Wrote \(png) (\(size)px)")
  }
}

do {
  try run()
} catch {
  FileHandle.standardError.write(Data("make-icon: \(error)\n".utf8))
  exit(1)
}
