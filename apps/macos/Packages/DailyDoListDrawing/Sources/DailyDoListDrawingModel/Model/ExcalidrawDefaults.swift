import Foundation

/// Excalidraw's palette and defaults (`colors.ts`, `constants.ts`, 0.18): the colors its pickers
/// offer (open-color shades 0, 2, 4, 6, 8, plus Radix bronze), the quick picks, stroke widths and
/// sloppiness levels, and what new elements start with.
public enum ExcalidrawPalette {
  public static let transparent = "transparent"
  public static let black = "#1e1e1e"
  public static let white = "#ffffff"

  /// Hue → five shades, lightest first, in the pickers' order.
  public static let shades: [(name: String, colors: [String])] = [
    ("gray", ["#f8f9fa", "#e9ecef", "#ced4da", "#868e96", "#343a40"]),
    ("bronze", ["#f8f1ee", "#eaddd7", "#d2bab0", "#a18072", "#846358"]),
    ("red", ["#fff5f5", "#ffc9c9", "#ff8787", "#fa5252", "#e03131"]),
    ("pink", ["#fff0f6", "#fcc2d7", "#f783ac", "#e64980", "#c2255c"]),
    ("grape", ["#f8f0fc", "#eebefa", "#da77f2", "#be4bdb", "#9c36b5"]),
    ("violet", ["#f3f0ff", "#d0bfff", "#9775fa", "#7950f2", "#6741d9"]),
    ("blue", ["#e7f5ff", "#a5d8ff", "#4dabf7", "#228be6", "#1971c2"]),
    ("cyan", ["#e3fafc", "#99e9f2", "#3bc9db", "#15aabf", "#0c8599"]),
    ("teal", ["#e6fcf5", "#96f2d7", "#38d9a9", "#12b886", "#099268"]),
    ("green", ["#ebfbee", "#b2f2bb", "#69db7c", "#40c057", "#2f9e44"]),
    ("yellow", ["#fff9db", "#ffec99", "#ffd43b", "#fab005", "#f08c00"]),
    ("orange", ["#fff4e6", "#ffd8a8", "#ffa94d", "#fd7e14", "#e8590c"]),
  ]

  /// The stroke color quick picks (black, then shade 4 of red, green, blue, yellow).
  public static let strokePicks = [black, "#e03131", "#2f9e44", "#1971c2", "#f08c00"]
  /// The background quick picks (transparent, then shade 1 of red, green, blue, yellow).
  public static let backgroundPicks = [transparent, "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99"]

  /// Every stroke color the picker offers (quick picks first, then the grid by hue).
  public static var strokeColors: [String] {
    var colors = strokePicks
    for (_, row) in shades { colors += row.filter { !colors.contains($0) } }
    return colors + [white]
  }

  /// Every background the picker offers.
  public static var backgroundColors: [String] {
    var colors = backgroundPicks
    for (_, row) in shades { colors += row.filter { !colors.contains($0) } }
    return colors + [white]
  }

  /// Thin, bold, extra bold.
  public static let strokeWidths: [Double] = [1, 2, 4]
  /// Architect, artist, cartoonist.
  public static let roughnessLevels: [Double] = [0, 1, 2]
  public static let defaultFontSize: Double = 20
  /// Small, medium, large, very large.
  public static let fontSizes: [Double] = [16, 20, 28, 36]
}

/// What a new element is drawn with: Excalidraw's `DEFAULT_ELEMENT_PROPS` and the tool bar's
/// current item.
public struct ElementStyle: Hashable, Sendable {
  public var strokeColor = ExcalidrawPalette.black
  public var backgroundColor = ExcalidrawPalette.transparent
  public var fillStyle = FillStyle.solid
  public var strokeWidth: Double = 2
  public var strokeStyle = StrokeStyle.solid
  public var roughness: Double = 1
  public var opacity: Double = 100
  /// Rounded corners for new rectangles, diamonds and linear elements ("round" edges).
  public var roundEdges = true
  public var startArrowhead: Arrowhead? = nil
  public var endArrowhead: Arrowhead? = .arrow
  public var fontSize: Double = ExcalidrawPalette.defaultFontSize
  public var fontFamily: Int = FontFamily.excalifont
  public var textAlign = TextAlign.left

  public init() {}
}
