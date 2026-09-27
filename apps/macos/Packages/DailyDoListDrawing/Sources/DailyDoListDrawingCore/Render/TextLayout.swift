import CoreGraphics
import CoreText
import Foundation

/// Text as Excalidraw sets it: one line per `\n`, `lineHeight × fontSize` apart, the first
/// baseline where the family's metrics put it (`getVerticalOffset`), aligned left, center or
/// right in the element's width.
public struct TextLayout: @unchecked Sendable {
  public var lines: [String]
  var ctLines: [CTLine]
  public var lineWidths: [Double]
  public var lineHeightPx: Double
  public var verticalOffset: Double

  /// The width Excalidraw would measure (the widest line).
  public var width: Double { lineWidths.max() ?? 0 }
  /// Lines × line height.
  public var height: Double { Double(lines.count) * lineHeightPx }

  public init(text: String, fontSize: Double, fontFamily: Int, lineHeight: Double) {
    let font = DrawingFonts.font(family: fontFamily, size: fontSize)
    lines = Self.normalize(text).split(separator: "\n", omittingEmptySubsequences: false).map(
      String.init)
    ctLines = lines.map { Self.line($0, font: font) }
    lineWidths = ctLines.map { CTLineGetTypographicBounds($0, nil, nil, nil) }
    lineHeightPx = fontSize * lineHeight
    verticalOffset = FontFamily.metrics(fontFamily).verticalOffset(
      fontSize: fontSize, lineHeightPx: lineHeightPx)
  }

  public init(_ properties: TextProperties) {
    self.init(
      text: properties.text, fontSize: properties.fontSize, fontFamily: properties.fontFamily,
      lineHeight: properties.lineHeight)
  }

  /// `normalizeText`: `\r\n` and `\r` become `\n`, a tab becomes eight spaces.
  static func normalize(_ text: String) -> String {
    text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
      .replacingOccurrences(of: "\t", with: "        ")
  }

  static func line(_ text: String, font: CTFont) -> CTLine {
    let attributes: [CFString: Any] = [
      kCTFontAttributeName: font, kCTForegroundColorFromContextAttributeName: true,
    ]
    let string = CFAttributedStringCreate(nil, text as CFString, attributes as CFDictionary)!
    return CTLineCreateWithAttributedString(string)
  }

  /// Draws the lines in a y-down context whose origin is the element's top-left corner.
  func draw(in context: CGContext, width: Double, align: TextAlign) {
    context.saveGState()
    context.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
    for (index, line) in ctLines.enumerated() {
      let lineWidth = lineWidths[index]
      let x: Double =
        switch align {
        case .center: width / 2 - lineWidth / 2
        case .right: width - lineWidth
        default: 0
        }
      context.textPosition = CGPoint(x: x, y: Double(index) * lineHeightPx + verticalOffset)
      CTLineDraw(line, context)
    }
    context.restoreGState()
  }

  /// `measureText`: the size of text (empty lines count as a space).
  public static func measure(
    _ text: String, fontSize: Double, fontFamily: Int, lineHeight: Double
  ) -> (width: Double, height: Double) {
    let padded = normalize(text).split(separator: "\n", omittingEmptySubsequences: false).map {
      $0.isEmpty ? " " : String($0)
    }.joined(separator: "\n")
    let layout = TextLayout(
      text: padded, fontSize: fontSize, fontFamily: fontFamily, lineHeight: lineHeight)
    return (layout.width, layout.height)
  }

  /// The width of one line of text.
  public static func lineWidth(_ text: String, fontSize: Double, fontFamily: Int) -> Double {
    CTLineGetTypographicBounds(
      line(text, font: DrawingFonts.font(family: fontFamily, size: fontSize)), nil, nil, nil)
  }

  /// `wrapText`: breaks lines longer than `maxWidth` at spaces, and words longer than a line
  /// between characters.
  public static func wrap(
    _ text: String, fontSize: Double, fontFamily: Int, maxWidth: Double
  ) -> String {
    guard maxWidth.isFinite, maxWidth >= 0 else { return text }
    func width(_ string: String) -> Double {
      lineWidth(string, fontSize: fontSize, fontFamily: fontFamily)
    }
    var lines: [String] = []
    for original in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
      if width(original) <= maxWidth {
        lines.append(original)
        continue
      }
      var current = ""
      for token in tokens(original) {
        let candidate = current + token
        if token.allSatisfy(\.isWhitespace) || width(candidate) <= maxWidth {
          current = candidate
          continue
        }
        if current.isEmpty {
          var piece = ""
          for character in token {
            if width(piece + String(character)) <= maxWidth || piece.isEmpty {
              piece.append(character)
            } else {
              lines.append(piece)
              piece = String(character)
            }
          }
          current = piece
        } else {
          lines.append(String(current.reversed().drop(while: \.isWhitespace).reversed()))
          current = token.allSatisfy(\.isWhitespace) ? "" : token
          if width(current) > maxWidth {
            var piece = ""
            for character in current {
              if width(piece + String(character)) <= maxWidth || piece.isEmpty {
                piece.append(character)
              } else {
                lines.append(piece)
                piece = String(character)
              }
            }
            current = piece
          }
        }
      }
      if !current.isEmpty || lines.isEmpty {
        let trimmed =
          width(current) > maxWidth
          ? String(current.reversed().drop(while: \.isWhitespace).reversed()) : current
        lines.append(trimmed)
      }
    }
    return lines.joined(separator: "\n")
  }

  /// Words and runs of whitespace; CJK characters are words of their own.
  static func tokens(_ line: String) -> [String] {
    var tokens: [String] = []
    var current = ""
    var currentIsSpace = false
    for character in line {
      let isSpace = character.isWhitespace
      let isCJK =
        character.unicodeScalars.first.map {
          (0x2E80...0x9FFF).contains($0.value) || (0xAC00...0xD7AF).contains($0.value)
            || (0xF900...0xFAFF).contains($0.value)
        } ?? false
      if isCJK {
        if !current.isEmpty { tokens.append(current) }
        tokens.append(String(character))
        current = ""
        continue
      }
      if !current.isEmpty && isSpace != currentIsSpace {
        tokens.append(current)
        current = ""
      }
      current.append(character)
      currentIsSpace = isSpace
    }
    if !current.isEmpty { tokens.append(current) }
    return tokens
  }
}
