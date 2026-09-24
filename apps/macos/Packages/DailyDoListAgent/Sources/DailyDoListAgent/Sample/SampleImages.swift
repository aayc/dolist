import AppKit

/// Synthetic surface frames (a restaurant booking page, a desktop), drawn in code so no real
/// screenshots ship with the repo. Base64 PNG, like `SurfaceFrame.data`.
enum SampleImages {
  static let browserSize = (width: 1280, height: 800)
  static let desktopSize = (width: 1440, height: 900)
  /// Where the browser frame's "Complete reservation" button is (frame pixels).
  static let reserveButtonCenter = (x: 1000.0, y: 648.0)
  /// Where the desktop frame's "Add to cart" button is (frame pixels).
  static let addToCartCenter = (x: 1012.0, y: 604.0)

  static let browserFrame: String = render(width: browserSize.width, height: browserSize.height) { size in
    fill(NSRect(origin: .zero, size: size), 0xFFFFFF)
    // Site header
    fill(NSRect(x: 0, y: 0, width: size.width, height: 76), 0x2F3B2F)
    text("Trattoria Sole", at: NSPoint(x: 48, y: 22), size: 26, weight: .bold, color: 0xF6EBD9)
    for (index, item) in ["Menu", "Reservations", "Private dining", "Contact"].enumerated() {
      text(item, at: NSPoint(x: 780 + index * 120, y: 29), size: 16, weight: .medium, color: 0xE8DCC6)
    }
    // Photo placeholder
    let photo = NSRect(x: 760, y: 120, width: 472, height: 300)
    NSGradient(starting: NSColor(rgb: 0xE9A15B), ending: NSColor(rgb: 0x8E3B2E))?
      .draw(in: NSBezierPath(roundedRect: photo, xRadius: 14, yRadius: 14), angle: 60)
    text("Patio · Summer menu", at: NSPoint(x: 788, y: 380), size: 18, weight: .semibold, color: 0xFFFFFF)
    // Form
    text("Reserve a table", at: NSPoint(x: 48, y: 120), size: 40, weight: .bold, color: 0x1F1F1F)
    text("Friday, 7:00 PM · Party of 4 · Patio", at: NSPoint(x: 50, y: 178), size: 18, weight: .regular, color: 0x5C5C5C)
    let fields = [
      ("Name", "Alex Example"), ("Phone", "(555) 010-2323"), ("Party size", "4 guests"),
      ("Time", "Friday, 7:00 PM"), ("Seating", "Patio"),
    ]
    for (index, field) in fields.enumerated() {
      let y = 236 + index * 78
      text(field.0, at: NSPoint(x: 50, y: y), size: 14, weight: .semibold, color: 0x5C5C5C)
      let box = NSRect(x: 48, y: CGFloat(y + 22), width: 640, height: 44)
      fill(box, 0xF6F6F6, radius: 8)
      stroke(box, 0xD6D6D6, radius: 8)
      text(field.1, at: NSPoint(x: 64, y: y + 33), size: 17, weight: .regular, color: 0x1F1F1F)
    }
    let button = NSRect(
      x: reserveButtonCenter.x - 170, y: reserveButtonCenter.y - 30, width: 340, height: 60)
    fill(button, 0x2F7D4F, radius: 12)
    text("Complete reservation", at: NSPoint(x: button.minX + 62, y: button.minY + 17), size: 20, weight: .semibold, color: 0xFFFFFF)
    text("You'll get a confirmation by text message.", at: NSPoint(x: 776, y: 700), size: 14, weight: .regular, color: 0x7A7A7A)
  }

  static let desktopFrame: String = render(width: desktopSize.width, height: desktopSize.height) { size in
    NSGradient(starting: NSColor(rgb: 0x3B2F8F), ending: NSColor(rgb: 0x1B6F9E))?
      .draw(in: NSRect(origin: .zero, size: size), angle: -35)
    // Menu bar
    fill(NSRect(x: 0, y: 0, width: size.width, height: 30), 0xE9E9EF)
    text("Browser   File   Edit   View   History", at: NSPoint(x: 20, y: 6), size: 14, weight: .medium, color: 0x222222)
    // Window
    let window = NSRect(x: 180, y: 110, width: 1080, height: 680)
    fill(window, 0xFFFFFF, radius: 12)
    fill(NSRect(x: window.minX, y: window.minY, width: window.width, height: 44), 0xF1F1F4, radius: 12)
    for (index, color) in [0xFF5F57, 0xFEBC2E, 0x28C840].enumerated() {
      fill(NSRect(x: window.minX + 18 + CGFloat(index) * 22, y: window.minY + 15, width: 13, height: 13), UInt32(color), radius: 6.5)
    }
    text("example-roasters.example/reorder", at: NSPoint(x: 560, y: 124), size: 14, weight: .regular, color: 0x6A6A6A)
    text("Example Roasters", at: NSPoint(x: 230, y: 190), size: 30, weight: .bold, color: 0x2A1E17)
    text("Your usual order", at: NSPoint(x: 232, y: 236), size: 17, weight: .regular, color: 0x6A6A6A)
    for index in 0..<2 {
      let card = NSRect(x: 230 + CGFloat(index) * 520, y: 290, width: 480, height: 380)
      fill(card, 0xFAF6F1, radius: 12)
      stroke(card, 0xE6DDD2, radius: 12)
      fill(NSRect(x: card.minX + 24, y: card.minY + 24, width: 140, height: 180), index == 0 ? 0x6B4A34 : 0x8C5A3C, radius: 8)
      text(index == 0 ? "House Blend" : "Ethiopia Natural", at: NSPoint(x: card.minX + 190, y: card.minY + 36), size: 22, weight: .semibold, color: 0x2A1E17)
      text(index == 0 ? "Whole bean · 1 lb · $16" : "Whole bean · 12 oz · $19", at: NSPoint(x: card.minX + 190, y: card.minY + 72), size: 15, weight: .regular, color: 0x6A6A6A)
    }
    let button = NSRect(x: addToCartCenter.x - 110, y: addToCartCenter.y - 24, width: 220, height: 48)
    fill(button, 0x2A1E17, radius: 10)
    text("Add to cart", at: NSPoint(x: button.minX + 56, y: button.minY + 13), size: 18, weight: .semibold, color: 0xFFFFFF)
  }

  private static func render(width: Int, height: Int, draw: (NSSize) -> Void) -> String {
    guard
      let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
        samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0),
      let context = NSGraphicsContext(bitmapImageRep: bitmap)
    else { return "" }
    let size = NSSize(width: width, height: height)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    // Draw top-down like a web page.
    let flip = NSAffineTransform()
    flip.translateX(by: 0, yBy: size.height)
    flip.scaleX(by: 1, yBy: -1)
    flip.concat()
    draw(size)
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.representation(using: .png, properties: [:])?.base64EncodedString() ?? ""
  }

  private static func fill(_ rect: NSRect, _ rgb: UInt32, radius: CGFloat = 0) {
    NSColor(rgb: rgb).setFill()
    NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
  }

  private static func stroke(_ rect: NSRect, _ rgb: UInt32, radius: CGFloat) {
    NSColor(rgb: rgb).setStroke()
    let path = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)
    path.lineWidth = 1
    path.stroke()
  }

  /// Draws text with its top-left at `point` in the flipped (top-down) space.
  private static func text(
    _ string: String, at point: NSPoint, size: CGFloat, weight: NSFont.Weight, color: UInt32
  ) {
    let font = NSFont.systemFont(ofSize: size, weight: weight)
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor(rgb: color)]
    NSGraphicsContext.saveGraphicsState()
    // Text draws upside down in a flipped context unless we flip it back around its line.
    let transform = NSAffineTransform()
    transform.translateX(by: point.x, yBy: point.y + size * 1.2)
    transform.scaleX(by: 1, yBy: -1)
    transform.concat()
    NSAttributedString(string: string, attributes: attributes).draw(at: .zero)
    NSGraphicsContext.restoreGraphicsState()
  }
}
