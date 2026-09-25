import CoreGraphics
import Foundation

/// Light or dark, the way Excalidraw draws them: dark is the light drawing through the CSS filter
/// `invert(93%) hue-rotate(180deg)` (`THEME_FILTER`), applied here to each color.
public enum DrawingTheme: String, Hashable, Sendable, CaseIterable {
  case light
  case dark
}

/// An sRGB color parsed from an element's CSS color string.
public struct DrawingColor: Hashable, Sendable {
  public var red: Double
  public var green: Double
  public var blue: Double
  public var alpha: Double

  public init(red: Double, green: Double, blue: Double, alpha: Double = 1) {
    self.red = red
    self.green = green
    self.blue = blue
    self.alpha = alpha
  }

  public init(rgb: UInt32, alpha: Double = 1) {
    self.init(
      red: Double((rgb >> 16) & 0xFF) / 255, green: Double((rgb >> 8) & 0xFF) / 255,
      blue: Double(rgb & 0xFF) / 255, alpha: alpha)
  }

  public static let clear = DrawingColor(red: 0, green: 0, blue: 0, alpha: 0)
  public static let black = DrawingColor(rgb: 0x000000)

  public var isTransparent: Bool { alpha == 0 }

  /// Excalidraw's `isTransparent`: `transparent`, or a hex color with zero alpha.
  public static func isTransparent(_ css: String) -> Bool {
    let value = css.trimmingCharacters(in: .whitespaces).lowercased()
    if value == "transparent" { return true }
    if value.hasPrefix("#"), value.count == 5 { return value.hasSuffix("0") }
    if value.hasPrefix("#"), value.count == 9 { return value.hasSuffix("00") }
    return false
  }

  /// Parses hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), `rgb()`/`rgba()`, `hsl()`/`hsla()`,
  /// `transparent` and the CSS color names; nil for anything else.
  public static func parse(_ css: String) -> DrawingColor? {
    let value = css.trimmingCharacters(in: .whitespaces).lowercased()
    if value == "transparent" { return .clear }
    if value.hasPrefix("#") { return hex(String(value.dropFirst())) }
    if value.hasPrefix("rgb") || value.hasPrefix("hsl") { return functional(value) }
    if let rgb = CSSColorNames.table[value] { return DrawingColor(rgb: rgb) }
    return nil
  }

  private static func hex(_ digits: String) -> DrawingColor? {
    guard digits.allSatisfy(\.isHexDigit) else { return nil }
    var expanded = digits
    if digits.count == 3 || digits.count == 4 {
      expanded = digits.map { "\($0)\($0)" }.joined()
    }
    guard expanded.count == 6 || expanded.count == 8, let value = UInt64(expanded, radix: 16) else {
      return nil
    }
    if expanded.count == 6 { return DrawingColor(rgb: UInt32(value)) }
    return DrawingColor(rgb: UInt32(value >> 8), alpha: Double(value & 0xFF) / 255)
  }

  private static func functional(_ value: String) -> DrawingColor? {
    guard let open = value.firstIndex(of: "("), value.hasSuffix(")") else { return nil }
    let name = value[..<open]
    let body = value[value.index(after: open)..<value.index(before: value.endIndex)]
    let parts = body.replacingOccurrences(of: "/", with: " ").split(
      whereSeparator: { $0 == "," || $0 == " " }
    ).map(String.init)
    guard parts.count == 3 || parts.count == 4 else { return nil }
    func component(_ text: String, scale: Double) -> Double? {
      if text.hasSuffix("%") { return Double(text.dropLast()).map { $0 / 100 } }
      return Double(text).map { $0 / scale }
    }
    let alpha = parts.count == 4 ? component(parts[3], scale: 1) : 1
    guard let alpha else { return nil }
    if name.hasPrefix("rgb") {
      guard let r = component(parts[0], scale: 255), let g = component(parts[1], scale: 255),
        let b = component(parts[2], scale: 255)
      else { return nil }
      return DrawingColor(red: clamp(r), green: clamp(g), blue: clamp(b), alpha: clamp(alpha))
    }
    guard let h = Double(parts[0].replacingOccurrences(of: "deg", with: "")),
      let s = component(parts[1], scale: 100), let l = component(parts[2], scale: 100)
    else { return nil }
    let hue = (h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
    let c = (1 - abs(2 * l - 1)) * s
    let x = c * (1 - abs((hue / 60).truncatingRemainder(dividingBy: 2) - 1))
    let m = l - c / 2
    let (r, g, b): (Double, Double, Double) =
      switch hue {
      case ..<60: (c, x, 0)
      case ..<120: (x, c, 0)
      case ..<180: (0, c, x)
      case ..<240: (0, x, c)
      case ..<300: (x, 0, c)
      default: (c, 0, x)
      }
    return DrawingColor(
      red: clamp(r + m), green: clamp(g + m), blue: clamp(b + m), alpha: clamp(alpha))
  }

  private static func clamp(_ value: Double) -> Double { min(1, max(0, value)) }

  /// The color through `invert(93%) hue-rotate(180deg)`.
  public var darkModeFiltered: DrawingColor {
    let amount = 0.93
    let r = red * (1 - 2 * amount) + amount
    let g = green * (1 - 2 * amount) + amount
    let b = blue * (1 - 2 * amount) + amount
    // hue-rotate(180deg): the Filter Effects matrix with cos = -1, sin = 0.
    let rr = -0.574 * r + 1.43 * g + 0.144 * b
    let gg = 0.426 * r + 0.43 * g + 0.144 * b
    let bb = 0.426 * r + 1.43 * g - 0.856 * b
    return DrawingColor(
      red: Self.clamp(rr), green: Self.clamp(gg), blue: Self.clamp(bb), alpha: alpha)
  }

  public func themed(_ theme: DrawingTheme) -> DrawingColor {
    theme == .dark ? darkModeFiltered : self
  }

  public var cgColor: CGColor {
    CGColor(srgbRed: red, green: green, blue: blue, alpha: alpha)
  }

  /// `#rrggbb` (alpha dropped).
  public var hexString: String {
    String(
      format: "#%02x%02x%02x", Int((red * 255).rounded()), Int((green * 255).rounded()),
      Int((blue * 255).rounded()))
  }
}

/// Parsed and themed colors, cached by their CSS string (drawing asks for the same few colors
/// thousands of times a frame).
final class DrawingColorCache: @unchecked Sendable {
  private let lock = NSLock()
  private var colors: [String: CGColor] = [:]

  static let shared = DrawingColorCache()

  /// The color to draw `css` with in `theme`; unparseable colors draw black, like a canvas.
  func cgColor(_ css: String, theme: DrawingTheme) -> CGColor {
    let key = theme == .dark ? "d" + css : "l" + css
    if let color = lock.withLock({ colors[key] }) { return color }
    let color = (DrawingColor.parse(css) ?? .black).themed(theme).cgColor
    lock.withLock { colors[key] = color }
    return color
  }
}
