import CoreGraphics
import Foundation

/// Bounded SVG numeric/path parsing. Unsupported syntax fails the whole image rather than
/// rendering a misleading partial shape. Arc commands are deliberately not approximated.
struct StaticSVGNumbers {
  var tokens: [String]
  var offset = 0
  init?(_ source: String) {
    guard source.utf8.count <= 2_000_000 else { return nil }
    let expression = try! NSRegularExpression(
      pattern: "[a-zA-Z]|[-+]?(?:[0-9]+\\.?[0-9]*|\\.[0-9]+)(?:[eE][-+]?[0-9]+)?")
    let string = source as NSString
    let matches = expression.matches(in: source, range: NSRange(location: 0, length: string.length))
    guard matches.count <= 100_000 else { return nil }
    var end = 0
    for match in matches {
      let gap = string.substring(with: NSRange(location: end, length: match.range.location - end))
      guard gap.allSatisfy({ $0.isWhitespace || $0 == "," }) else { return nil }
      end = NSMaxRange(match.range)
    }
    guard string.substring(from: end).allSatisfy({ $0.isWhitespace || $0 == "," }) else {
      return nil
    }
    tokens = matches.map { string.substring(with: $0.range) }
  }
  var isEmpty: Bool { offset >= tokens.count }
  mutating func number() -> Double? {
    guard !isEmpty, let value = Double(tokens[offset]), value.isFinite, abs(value) <= 1e9 else {
      return nil
    }
    offset += 1
    return value
  }
  mutating func point(relativeTo origin: CGPoint = .zero) -> CGPoint? {
    guard let x = number(), let y = number() else { return nil }
    return CGPoint(x: x + origin.x, y: y + origin.y)
  }
  static func list(_ source: String) -> [Double]? {
    guard var scanner = Self(source) else { return nil }
    var result: [Double] = []
    while !scanner.isEmpty {
      guard let number = scanner.number() else { return nil }
      result.append(number)
    }
    return result
  }
}

enum StaticSVGPath {
  static func decode(_ data: String) -> CGPath? {
    guard var scanner = StaticSVGNumbers(data) else { return nil }
    let result = CGMutablePath()
    var command = ""
    var previous = ""
    var current = CGPoint.zero
    var start = CGPoint.zero
    var control = CGPoint.zero
    while !scanner.isEmpty {
      let token = scanner.tokens[scanner.offset]
      if token.count == 1, token.first?.isLetter == true {
        command = token
        scanner.offset += 1
      } else if command.isEmpty {
        return nil
      }
      let relative = command == command.lowercased()
      let origin = relative ? current : .zero
      let upper = command.uppercased()
      switch upper {
      case "M", "L":
        guard let next = scanner.point(relativeTo: origin) else { return nil }
        if upper == "M" {
          result.move(to: next)
          start = next
          command = relative ? "l" : "L"
        } else {
          result.addLine(to: next)
        }
        current = next
      case "H":
        guard let x = scanner.number() else { return nil }
        current.x = x + origin.x
        result.addLine(to: current)
      case "V":
        guard let y = scanner.number() else { return nil }
        current.y = y + origin.y
        result.addLine(to: current)
      case "C":
        guard let first = scanner.point(relativeTo: origin),
          let second = scanner.point(relativeTo: origin),
          let end = scanner.point(relativeTo: origin)
        else { return nil }
        result.addCurve(to: end, control1: first, control2: second)
        control = second
        current = end
      case "S":
        guard let second = scanner.point(relativeTo: origin),
          let end = scanner.point(relativeTo: origin)
        else { return nil }
        let first =
          ["C", "S"].contains(previous)
          ? CGPoint(x: 2 * current.x - control.x, y: 2 * current.y - control.y) : current
        result.addCurve(to: end, control1: first, control2: second)
        control = second
        current = end
      case "Q":
        guard let first = scanner.point(relativeTo: origin),
          let end = scanner.point(relativeTo: origin)
        else { return nil }
        result.addQuadCurve(to: end, control: first)
        control = first
        current = end
      case "T":
        guard let end = scanner.point(relativeTo: origin) else { return nil }
        let first =
          ["Q", "T"].contains(previous)
          ? CGPoint(x: 2 * current.x - control.x, y: 2 * current.y - control.y) : current
        result.addQuadCurve(to: end, control: first)
        control = first
        current = end
      case "Z":
        result.closeSubpath()
        current = start
        command = ""
      default: return nil
      }
      previous = upper
    }
    return result
  }

  static func transform(_ source: String) -> CGAffineTransform? {
    let expression = try! NSRegularExpression(pattern: "([a-zA-Z]+)\\s*\\(([^)]*)\\)")
    let string = source as NSString
    let matches = expression.matches(in: source, range: NSRange(location: 0, length: string.length))
    var transform = CGAffineTransform.identity
    var end = 0
    for match in matches {
      guard
        string.substring(with: NSRange(location: end, length: match.range.location - end))
          .allSatisfy({ $0.isWhitespace || $0 == "," }),
        let values = StaticSVGNumbers.list(string.substring(with: match.range(at: 2)))
      else { return nil }
      let next: CGAffineTransform
      switch string.substring(with: match.range(at: 1)) {
      case "matrix" where values.count == 6:
        next = CGAffineTransform(
          a: values[0], b: values[1], c: values[2], d: values[3], tx: values[4], ty: values[5])
      case "translate" where (1...2).contains(values.count):
        next = CGAffineTransform(translationX: values[0], y: values.count == 2 ? values[1] : 0)
      case "scale" where (1...2).contains(values.count):
        next = CGAffineTransform(scaleX: values[0], y: values.count == 2 ? values[1] : values[0])
      case "rotate" where values.count == 1 || values.count == 3:
        let rotation = values[0] * .pi / 180
        if values.count == 3 {
          next = CGAffineTransform(translationX: values[1], y: values[2]).rotated(by: rotation)
            .translatedBy(x: -values[1], y: -values[2])
        } else {
          next = CGAffineTransform(rotationAngle: rotation)
        }
      case "skewX" where values.count == 1:
        next = CGAffineTransform(a: 1, b: 0, c: tan(values[0] * .pi / 180), d: 1, tx: 0, ty: 0)
      case "skewY" where values.count == 1:
        next = CGAffineTransform(a: 1, b: tan(values[0] * .pi / 180), c: 0, d: 1, tx: 0, ty: 0)
      default: return nil
      }
      transform = next.concatenating(transform)
      end = NSMaxRange(match.range)
    }
    guard string.substring(from: end).allSatisfy(\.isWhitespace),
      [transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty].allSatisfy({
        $0.isFinite && abs($0) <= 1e9
      })
    else { return nil }
    return transform
  }
}
