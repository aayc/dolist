import Foundation

/// A string as JavaScript (and so vim.js) sees it: a sequence of UTF-16 code units.
///
/// Every column, length and index in this package counts UTF-16 code units, like JavaScript,
/// `NSString` and `NSTextView`. Unlike `String`, a `VimText` can hold a lone surrogate (vim.js can
/// produce one, for example `X` right after an emoji deletes only its low surrogate).
public struct VimText: Hashable, Sendable {
  /// The UTF-16 code units.
  public var units: [UInt16]

  public init() {
    units = []
  }

  public init(units: [UInt16]) {
    self.units = units
  }

  public init<S: StringProtocol>(_ string: S) {
    units = Array(string.utf16)
  }

  /// The characters of `string`, lone surrogates included.
  public init(_ string: NSString) {
    let count = string.length
    var buffer = [UInt16](repeating: 0, count: count)
    if count > 0 {
      buffer.withUnsafeMutableBufferPointer { string.getCharacters($0.baseAddress!, range: NSRange(location: 0, length: count)) }
    }
    units = buffer
  }

  /// The text as a Swift string (a lone surrogate becomes U+FFFD).
  public var string: String { String(decoding: units, as: UTF16.self) }

  /// The text as an `NSString` (lossless).
  public var nsString: NSString {
    units.withUnsafeBufferPointer { NSString(characters: $0.baseAddress ?? UnsafePointer(bitPattern: 1)!, length: $0.count) }
  }

  /// JavaScript's `length`: the number of UTF-16 code units.
  public var length: Int { units.count }

  public var isEmpty: Bool { units.isEmpty }
}

extension VimText: ExpressibleByStringLiteral {
  public init(stringLiteral value: String) {
    self.init(value)
  }
}

extension VimText: CustomStringConvertible, CustomDebugStringConvertible {
  public var description: String { string }
  public var debugDescription: String { string.debugDescription }
}

extension VimText: Comparable {
  /// JavaScript's `a < b`: lexicographic order of code units.
  public static func < (a: VimText, b: VimText) -> Bool {
    a.units.lexicographicallyPrecedes(b.units)
  }
}

// MARK: - JavaScript string methods (the subset vim.js uses)

extension VimText {
  static let empty = VimText()

  init(unit: UInt16) {
    units = [unit]
  }

  init(_ units: ArraySlice<UInt16>) {
    self.units = Array(units)
  }

  @inline(__always) subscript(i: Int) -> UInt16 { units[i] }

  /// `charCodeAt(i)`, nil for NaN (out of range).
  @inline(__always) func code(at i: Int) -> UInt16? {
    i >= 0 && i < units.count ? units[i] : nil
  }

  /// `charAt(i)`: the code unit at `i` as a string, "" out of range.
  func charAt(_ i: Int) -> VimText {
    i >= 0 && i < units.count ? VimText(unit: units[i]) : .empty
  }

  /// `str[i]`: like `charAt` but nil (undefined) out of range.
  func at(_ i: Int) -> VimText? {
    i >= 0 && i < units.count ? VimText(unit: units[i]) : nil
  }

  /// `slice(start, end)`: negative indices count from the end.
  func slice(_ start: Int, _ end: Int? = nil) -> VimText {
    let n = units.count
    var from = start < 0 ? max(n + start, 0) : min(start, n)
    let to = end.map { $0 < 0 ? max(n + $0, 0) : min($0, n) } ?? n
    if from > to { from = to }
    return VimText(units[from..<to])
  }

  /// `substring(start, end)`: clamps both and swaps them when reversed.
  func substring(_ start: Int, _ end: Int? = nil) -> VimText {
    let n = units.count
    let a = min(max(start, 0), n)
    let b = min(max(end ?? n, 0), n)
    return VimText(units[min(a, b)..<max(a, b)])
  }

  /// `substr(start, length)`.
  func substr(_ start: Int, _ length: Int? = nil) -> VimText {
    let n = units.count
    let from = start < 0 ? max(n + start, 0) : min(start, n)
    let count = min(max(length ?? n, 0), n - from)
    return VimText(units[from..<(from + count)])
  }

  /// `indexOf(search, fromIndex)`.
  func indexOf(_ search: VimText, _ fromIndex: Int = 0) -> Int {
    let n = units.count, m = search.units.count
    var i = min(max(fromIndex, 0), n)
    if m == 0 { return i }
    let first = search.units[0]
    while i + m <= n {
      if units[i] == first {
        var k = 1
        while k < m && units[i + k] == search.units[k] { k += 1 }
        if k == m { return i }
      }
      i += 1
    }
    return -1
  }

  func indexOf(unit: UInt16, _ fromIndex: Int = 0) -> Int {
    var i = max(fromIndex, 0)
    while i < units.count {
      if units[i] == unit { return i }
      i += 1
    }
    return -1
  }

  /// `lastIndexOf(search, fromIndex)`.
  func lastIndexOf(_ search: VimText, _ fromIndex: Int? = nil) -> Int {
    let n = units.count, m = search.units.count
    var i = min(max(fromIndex ?? n, 0), n - m)
    if m == 0 { return min(max(fromIndex ?? n, 0), n) }
    while i >= 0 {
      var k = 0
      while k < m && units[i + k] == search.units[k] { k += 1 }
      if k == m { return i }
      i -= 1
    }
    return -1
  }

  func includes(_ search: VimText) -> Bool { indexOf(search) != -1 }

  func contains(unit: UInt16) -> Bool { units.contains(unit) }

  func hasPrefix(_ prefix: VimText) -> Bool { units.starts(with: prefix.units) }

  func hasSuffix(_ suffix: VimText) -> Bool {
    suffix.units.count <= units.count && units[(units.count - suffix.units.count)...].elementsEqual(suffix.units)
  }

  /// `split(separator)` with a string separator ("" splits into code units).
  func split(_ separator: VimText) -> [VimText] {
    if separator.isEmpty { return units.map { VimText(unit: $0) } }
    var parts: [VimText] = []
    var start = 0
    var i = indexOf(separator, 0)
    while i != -1 {
      parts.append(VimText(units[start..<i]))
      start = i + separator.length
      i = indexOf(separator, start)
    }
    parts.append(VimText(units[start...]))
    return parts
  }

  func split(unit: UInt16) -> [VimText] {
    var parts: [VimText] = []
    var start = 0
    for (i, u) in units.enumerated() where u == unit {
      parts.append(VimText(units[start..<i]))
      start = i + 1
    }
    parts.append(VimText(units[start...]))
    return parts
  }

  /// `repeat(count)`.
  func repeating(_ count: Int) -> VimText {
    var out = [UInt16]()
    out.reserveCapacity(units.count * max(count, 0))
    for _ in 0..<max(count, 0) { out.append(contentsOf: units) }
    return VimText(units: out)
  }

  /// `trim()`: strips JavaScript whitespace (`\s`).
  func trim() -> VimText {
    var a = 0, b = units.count
    while a < b && isJSWhitespace(units[a]) { a += 1 }
    while b > a && isJSWhitespace(units[b - 1]) { b -= 1 }
    return VimText(units[a..<b])
  }

  func trimStart() -> VimText {
    var a = 0
    while a < units.count && isJSWhitespace(units[a]) { a += 1 }
    return VimText(units[a...])
  }

  func trimEnd() -> VimText {
    var b = units.count
    while b > 0 && isJSWhitespace(units[b - 1]) { b -= 1 }
    return VimText(units[..<b])
  }

  /// `search(/\S/)`: the index of the first non-whitespace unit, or -1.
  func firstNonWhitespace() -> Int {
    for (i, u) in units.enumerated() where !isJSWhitespace(u) { return i }
    return -1
  }

  /// The number of leading whitespace units (`/^\s*/.exec(s)[0].length`).
  func leadingWhitespaceCount() -> Int {
    var i = 0
    while i < units.count && isJSWhitespace(units[i]) { i += 1 }
    return i
  }

  /// `/\S/.test(s)`.
  var hasNonWhitespace: Bool { units.contains { !isJSWhitespace($0) } }

  func toLowerCase() -> VimText { VimText(units: JSCase.lowercase(units)) }

  func toUpperCase() -> VimText { VimText(units: JSCase.uppercase(units)) }

  static func + (a: VimText, b: VimText) -> VimText { VimText(units: a.units + b.units) }

  static func += (a: inout VimText, b: VimText) { a.units.append(contentsOf: b.units) }

  static func == (a: VimText, b: String) -> Bool { a.units.elementsEqual(b.utf16) }

  static func != (a: VimText, b: String) -> Bool { !(a == b) }

  /// `[a, b, ...].join(separator)`.
  static func join(_ parts: [VimText], _ separator: VimText = .empty) -> VimText {
    var out = [UInt16]()
    for (i, part) in parts.enumerated() {
      if i > 0 { out.append(contentsOf: separator.units) }
      out.append(contentsOf: part.units)
    }
    return VimText(units: out)
  }
}

extension Array where Element == VimText {
  func joined(_ separator: VimText = .empty) -> VimText { VimText.join(self, separator) }
}

// MARK: - Code units

enum Unit {
  static let tab: UInt16 = 0x09
  static let newline: UInt16 = 0x0A
  static let carriageReturn: UInt16 = 0x0D
  static let space: UInt16 = 0x20
  static let backslash: UInt16 = 0x5C
  static let slash: UInt16 = 0x2F

  /// The code unit of a one-unit ASCII literal.
  @inline(__always) static func of(_ c: Unicode.Scalar) -> UInt16 { UInt16(c.value) }
}

@inline(__always) func isHighSurrogate(_ u: UInt16) -> Bool { u >= 0xD800 && u < 0xDC00 }
@inline(__always) func isLowSurrogate(_ u: UInt16) -> Bool { u >= 0xDC00 && u < 0xE000 }

/// A JavaScript line terminator (what `.` and `^`/`$` with the `m` flag stop at).
@inline(__always) func isJSLineTerminator(_ u: UInt16) -> Bool {
  u == 0x0A || u == 0x0D || u == 0x2028 || u == 0x2029
}
