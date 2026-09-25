import Foundation

/// A string-valued Excalidraw enum that keeps values it doesn't know (a newer Excalidraw's) as is.
public protocol OpenStringEnum: RawRepresentable, Hashable, Sendable where RawValue == String {
  init(rawValue: String)
}

/// An element's `type`.
public struct ElementType: OpenStringEnum, CustomStringConvertible {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let rectangle = ElementType(rawValue: "rectangle")
  public static let ellipse = ElementType(rawValue: "ellipse")
  public static let diamond = ElementType(rawValue: "diamond")
  public static let arrow = ElementType(rawValue: "arrow")
  public static let line = ElementType(rawValue: "line")
  public static let freedraw = ElementType(rawValue: "freedraw")
  public static let text = ElementType(rawValue: "text")
  public static let image = ElementType(rawValue: "image")
  public static let frame = ElementType(rawValue: "frame")
  public static let magicframe = ElementType(rawValue: "magicframe")
  public static let embeddable = ElementType(rawValue: "embeddable")
  public static let iframe = ElementType(rawValue: "iframe")
  public static let selection = ElementType(rawValue: "selection")

  public var description: String { rawValue }

  /// Line or arrow: drawn from `points`.
  public var isLinear: Bool { self == .line || self == .arrow }
  /// Has `points` (linear elements and freehand strokes).
  public var hasPoints: Bool { isLinear || self == .freedraw }
  /// Rectangle, ellipse or diamond.
  public var isShape: Bool { self == .rectangle || self == .ellipse || self == .diamond }
  public var isFrameLike: Bool { self == .frame || self == .magicframe }
  /// Can hold a bound text label.
  public var isTextContainer: Bool { isShape || self == .arrow }
  /// Arrows can bind to it.
  public var isBindable: Bool {
    isShape || self == .text || self == .image || self == .embeddable || self == .iframe
      || isFrameLike
  }
  /// Types this engine draws and edits in full.
  public var isSupported: Bool { isShape || hasPoints || self == .text }
}

/// `fillStyle`.
public struct FillStyle: OpenStringEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let hachure = FillStyle(rawValue: "hachure")
  public static let crossHatch = FillStyle(rawValue: "cross-hatch")
  public static let solid = FillStyle(rawValue: "solid")
  public static let zigzag = FillStyle(rawValue: "zigzag")
}

/// `strokeStyle`.
public struct StrokeStyle: OpenStringEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let solid = StrokeStyle(rawValue: "solid")
  public static let dashed = StrokeStyle(rawValue: "dashed")
  public static let dotted = StrokeStyle(rawValue: "dotted")
}

/// `startArrowhead` / `endArrowhead`.
public struct Arrowhead: OpenStringEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let arrow = Arrowhead(rawValue: "arrow")
  public static let bar = Arrowhead(rawValue: "bar")
  public static let dot = Arrowhead(rawValue: "dot")
  public static let circle = Arrowhead(rawValue: "circle")
  public static let circleOutline = Arrowhead(rawValue: "circle_outline")
  public static let triangle = Arrowhead(rawValue: "triangle")
  public static let triangleOutline = Arrowhead(rawValue: "triangle_outline")
  public static let diamond = Arrowhead(rawValue: "diamond")
  public static let diamondOutline = Arrowhead(rawValue: "diamond_outline")
  public static let crowfootOne = Arrowhead(rawValue: "crowfoot_one")
  public static let crowfootMany = Arrowhead(rawValue: "crowfoot_many")
  public static let crowfootOneOrMany = Arrowhead(rawValue: "crowfoot_one_or_many")
}

/// `textAlign`.
public struct TextAlign: OpenStringEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let left = TextAlign(rawValue: "left")
  public static let center = TextAlign(rawValue: "center")
  public static let right = TextAlign(rawValue: "right")
}

/// `verticalAlign`.
public struct VerticalAlign: OpenStringEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let top = VerticalAlign(rawValue: "top")
  public static let middle = VerticalAlign(rawValue: "middle")
  public static let bottom = VerticalAlign(rawValue: "bottom")
}

/// `roundness`: how corners are rounded (`null` in JSON is sharp).
public struct Roundness: Hashable, Sendable {
  /// 1 legacy, 2 proportional (lines, diamonds), 3 adaptive (rectangles).
  public var type: Int
  /// The adaptive radius; absent means 32.
  public var value: Double?

  public init(type: Int, value: Double? = nil) {
    self.type = type
    self.value = value
  }

  public static let legacy = 1
  public static let proportionalRadius = 2
  public static let adaptiveRadius = 3

  public static let proportional = Roundness(type: proportionalRadius)
  public static let adaptive = Roundness(type: adaptiveRadius)
}

/// Excalidraw's font family ids.
public enum FontFamily {
  public static let virgil = 1
  public static let helvetica = 2
  public static let cascadia = 3
  /// Unused by Excalidraw (Obsidian's custom font used it).
  public static let local = 4
  public static let excalifont = 5
  public static let nunito = 6
  public static let lilitaOne = 7
  public static let comicShanns = 8
  public static let liberationSans = 9

  /// Unitless line height Excalidraw uses for a family (`getLineHeight`).
  public static func lineHeight(_ family: Int) -> Double {
    metrics(family).lineHeight
  }

  /// `FONT_METADATA`: the metrics Excalidraw positions text with, whatever font draws it.
  public static func metrics(_ family: Int) -> FontMetrics {
    switch family {
    case nunito: FontMetrics(unitsPerEm: 1000, ascender: 1011, descender: -353, lineHeight: 1.35)
    case lilitaOne: FontMetrics(unitsPerEm: 1000, ascender: 923, descender: -220, lineHeight: 1.15)
    case comicShanns:
      FontMetrics(unitsPerEm: 1000, ascender: 750, descender: -250, lineHeight: 1.25)
    case helvetica: FontMetrics(unitsPerEm: 2048, ascender: 1577, descender: -471, lineHeight: 1.15)
    case cascadia: FontMetrics(unitsPerEm: 2048, ascender: 1900, descender: -480, lineHeight: 1.2)
    case liberationSans:
      FontMetrics(unitsPerEm: 2048, ascender: 1854, descender: -434, lineHeight: 1.15)
    default: FontMetrics(unitsPerEm: 1000, ascender: 886, descender: -374, lineHeight: 1.25)
    }
  }
}

/// A font's vertical metrics in font units, as Excalidraw records them.
public struct FontMetrics: Hashable, Sendable {
  public var unitsPerEm: Double
  public var ascender: Double
  public var descender: Double
  public var lineHeight: Double

  /// Where the first baseline sits below a line box's top (`getVerticalOffset`).
  public func verticalOffset(fontSize: Double, lineHeightPx: Double) -> Double {
    let em = fontSize / unitsPerEm
    let lineGap = (lineHeightPx - em * ascender + em * descender) / 2
    return em * ascender + lineGap
  }
}
