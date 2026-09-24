import Foundation

/// UTF-16 code units the tokenizer and commands look at. Everything in this package indexes text in
/// UTF-16 code units, like `NSString`/`NSRange`, so offsets can be used with TextKit directly.
enum UTF16Unit {
  static let tab: UInt16 = 0x09
  static let newline: UInt16 = 0x0A
  static let carriageReturn: UInt16 = 0x0D
  static let space: UInt16 = 0x20
  static let bang: UInt16 = 0x21
  static let doubleQuote: UInt16 = 0x22
  static let hash: UInt16 = 0x23
  static let ampersand: UInt16 = 0x26
  static let singleQuote: UInt16 = 0x27
  static let openParen: UInt16 = 0x28
  static let closeParen: UInt16 = 0x29
  static let asterisk: UInt16 = 0x2A
  static let plus: UInt16 = 0x2B
  static let comma: UInt16 = 0x2C
  static let dash: UInt16 = 0x2D
  static let dot: UInt16 = 0x2E
  static let slash: UInt16 = 0x2F
  static let zero: UInt16 = 0x30
  static let nine: UInt16 = 0x39
  static let colon: UInt16 = 0x3A
  static let semicolon: UInt16 = 0x3B
  static let lessThan: UInt16 = 0x3C
  static let equals: UInt16 = 0x3D
  static let greaterThan: UInt16 = 0x3E
  static let question: UInt16 = 0x3F
  static let at: UInt16 = 0x40
  static let openBracket: UInt16 = 0x5B
  static let backslash: UInt16 = 0x5C
  static let closeBracket: UInt16 = 0x5D
  static let underscore: UInt16 = 0x5F
  static let backtick: UInt16 = 0x60
  static let pipe: UInt16 = 0x7C
  static let tilde: UInt16 = 0x7E
  static let upperA: UInt16 = 0x41
  static let upperZ: UInt16 = 0x5A
  static let lowerA: UInt16 = 0x61
  static let lowerZ: UInt16 = 0x7A
  static let lowerX: UInt16 = 0x78
  static let upperX: UInt16 = 0x58
}

/// Character classes over UTF-16 code units, with the CommonMark notions of whitespace and
/// punctuation. Surrogate pairs are decoded where it matters (flanking rules, tags); a lone
/// surrogate counts as an ordinary (word) character, so malformed text never traps.
enum CharClass {
  @inline(__always) static func isSpaceOrTab(_ c: UInt16) -> Bool {
    c == UTF16Unit.space || c == UTF16Unit.tab
  }

  /// Blank for line-structure purposes: space, tab and a stray carriage return.
  @inline(__always) static func isLineBlank(_ c: UInt16) -> Bool {
    c == UTF16Unit.space || c == UTF16Unit.tab || c == UTF16Unit.carriageReturn
  }

  @inline(__always) static func isASCIIDigit(_ c: UInt16) -> Bool {
    c >= UTF16Unit.zero && c <= UTF16Unit.nine
  }

  @inline(__always) static func isASCIILetter(_ c: UInt16) -> Bool {
    (c >= UTF16Unit.upperA && c <= UTF16Unit.upperZ)
      || (c >= UTF16Unit.lowerA && c <= UTF16Unit.lowerZ)
  }

  @inline(__always) static func isASCIIAlphanumeric(_ c: UInt16) -> Bool {
    isASCIIDigit(c) || isASCIILetter(c)
  }

  /// ASCII punctuation as defined by CommonMark (escapable characters).
  @inline(__always) static func isASCIIPunctuation(_ c: UInt16) -> Bool {
    (c >= 0x21 && c <= 0x2F) || (c >= 0x3A && c <= 0x40) || (c >= 0x5B && c <= 0x60)
      || (c >= 0x7B && c <= 0x7E)
  }

  @inline(__always) static func isHighSurrogate(_ c: UInt16) -> Bool { c >= 0xD800 && c <= 0xDBFF }
  @inline(__always) static func isLowSurrogate(_ c: UInt16) -> Bool { c >= 0xDC00 && c <= 0xDFFF }

  /// The Unicode scalar ending right before `index` (decoding a surrogate pair), or nil at the start.
  static func scalar(before index: Int, in units: [UInt16], lowerBound: Int) -> Unicode.Scalar? {
    guard index > lowerBound, index <= units.count else { return nil }
    let last = units[index - 1]
    if isLowSurrogate(last), index - 2 >= lowerBound, isHighSurrogate(units[index - 2]) {
      return decode(high: units[index - 2], low: last)
    }
    return Unicode.Scalar(last)
  }

  /// The Unicode scalar starting at `index` (decoding a surrogate pair), or nil at the end.
  static func scalar(at index: Int, in units: [UInt16], upperBound: Int) -> Unicode.Scalar? {
    guard index >= 0, index < upperBound, index < units.count else { return nil }
    let first = units[index]
    if isHighSurrogate(first), index + 1 < upperBound, isLowSurrogate(units[index + 1]) {
      return decode(high: first, low: units[index + 1])
    }
    return Unicode.Scalar(first)
  }

  @inline(__always) static func decode(high: UInt16, low: UInt16) -> Unicode.Scalar? {
    let value = 0x10000 + ((UInt32(high) - 0xD800) << 10) + (UInt32(low) - 0xDC00)
    return Unicode.Scalar(value)
  }

  /// CommonMark "Unicode whitespace" (Zs plus tab, LF, FF, CR). Nil (a line boundary) counts too.
  static func isWhitespace(_ scalar: Unicode.Scalar?) -> Bool {
    guard let scalar else { return true }
    switch scalar.value {
    case 0x09, 0x0A, 0x0C, 0x0D, 0x20: return true
    case 0..<0x80: return false
    default: return scalar.properties.generalCategory == .spaceSeparator
    }
  }

  /// CommonMark "Unicode punctuation" (general categories P and S).
  static func isPunctuation(_ scalar: Unicode.Scalar?) -> Bool {
    guard let scalar else { return false }
    if scalar.value < 0x80 { return isASCIIPunctuation(UInt16(scalar.value)) }
    switch scalar.properties.generalCategory {
    case .connectorPunctuation, .dashPunctuation, .openPunctuation, .closePunctuation,
      .initialPunctuation, .finalPunctuation, .otherPunctuation, .mathSymbol, .currencySymbol,
      .modifierSymbol, .otherSymbol:
      return true
    default:
      return false
    }
  }

  /// Letters, marks and numbers (Obsidian's tag alphabet beyond ASCII).
  static func isLetterMarkOrNumber(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.properties.generalCategory {
    case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
      .nonspacingMark, .spacingMark, .enclosingMark, .decimalNumber, .letterNumber, .otherNumber:
      return true
    default:
      return false
    }
  }

  /// Word characters for "word at the caret" (formatting commands): letters, digits, marks, `_`.
  static func isWordCharacter(_ c: UInt16) -> Bool {
    if c < 0x80 { return isASCIIAlphanumeric(c) || c == UTF16Unit.underscore }
    if isHighSurrogate(c) || isLowSurrogate(c) { return false }
    guard let scalar = Unicode.Scalar(c) else { return false }
    return isLetterMarkOrNumber(scalar)
  }
}

extension NSString {
  /// The UTF-16 code units in `range` (clamped to the string).
  func utf16Units(in range: NSRange) -> [UInt16] {
    let start = max(0, min(range.location, length))
    let end = max(start, min(range.location + range.length, length))
    let count = end - start
    guard count > 0 else { return [] }
    return [UInt16](unsafeUninitializedCapacity: count) { buffer, initialized in
      getCharacters(buffer.baseAddress!, range: NSRange(location: start, length: count))
      initialized = count
    }
  }
}

extension String {
  /// Builds a string from UTF-16 code units (lone surrogates become U+FFFD).
  init(utf16Units units: ArraySlice<UInt16>) {
    self = String(decoding: units, as: UTF16.self)
  }
}
