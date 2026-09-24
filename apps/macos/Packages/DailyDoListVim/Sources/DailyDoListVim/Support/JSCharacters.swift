// Ported from vim.js (@replit/codemirror-vim-core 0.1.0) and `CodeMirror.isWordChar` of
// @replit/codemirror-vim 6.4.0 (MIT, © Marijn Haverbeke and others): the character tests.
//
// Character classes with JavaScript semantics, as vim.js and the CodeMirror 6 adapter test them.
// vim.js tests one UTF-16 code unit at a time (`line.charAt(i)`), so a surrogate half is never a
// letter: astral characters (emoji, math letters) count as punctuation.

/// `/\s/` in JavaScript: WhiteSpace and LineTerminator code points.
@inline(__always)
func isJSWhitespace(_ u: UInt16) -> Bool {
  if u == 0x20 || (u >= 0x09 && u <= 0x0D) { return true }
  if u < 0xA0 { return false }
  switch u {
  case 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
  default: return false
  }
}

/// `/\w/` without the `u`+`i` flags: `[A-Za-z0-9_]`.
@inline(__always)
func isJSAsciiWordChar(_ u: UInt16) -> Bool {
  (u >= 0x61 && u <= 0x7A) || (u >= 0x41 && u <= 0x5A) || (u >= 0x30 && u <= 0x39) || u == 0x5F
}

@inline(__always)
func isASCIIDigit(_ u: UInt16) -> Bool { u >= 0x30 && u <= 0x39 }

/// `CodeMirror.isWordChar` of the CodeMirror 6 adapter: `/[\w\p{Alphabetic}\p{Number}_]/u`.
@inline(__always)
func isWordChar(_ u: UInt16) -> Bool {
  if u < 0x80 { return isJSAsciiWordChar(u) }
  return bmpWordChars[Int(u) >> 6] & (1 << UInt64(u & 63)) != 0
}

/// One bit per BMP code point: Alphabetic or General_Category=Number (surrogates never are).
private let bmpWordChars: [UInt64] = {
  var bits = [UInt64](repeating: 0, count: 1024)
  for value in 0x80..<0x10000 {
    guard let scalar = Unicode.Scalar(UInt32(value)) else { continue }
    let properties = scalar.properties
    var word = properties.isAlphabetic
    if !word {
      switch properties.generalCategory {
      case .decimalNumber, .letterNumber, .otherNumber: word = true
      default: break
      }
    }
    if word { bits[value >> 6] |= 1 << UInt64(value & 63) }
  }
  return bits
}()

/// vim.js's `wordCharTest[1]`: a non-empty character that is neither a word character nor
/// whitespace (punctuation, symbols, surrogate halves).
@inline(__always)
func isPunctuationChar(_ u: UInt16) -> Bool { !isWordChar(u) && !isJSWhitespace(u) }

/// `/^[\p{Lu}]$/u` for one code unit (vim.js's `isUpperCase`).
func isUppercaseLetter(_ u: UInt16) -> Bool {
  if u < 0x80 { return u >= 0x41 && u <= 0x5A }
  guard let scalar = Unicode.Scalar(u) else { return false }
  return scalar.properties.generalCategory == .uppercaseLetter
}

/// `/^[a-z]$/` (vim.js's `isLowerCase`).
@inline(__always)
func isASCIILower(_ u: UInt16) -> Bool { u >= 0x61 && u <= 0x7A }

extension VimText {
  /// vim.js's `isWhiteSpaceString(k)`: `/^\s*$/.test(k)`; undefined (nil) tests the string
  /// "undefined", which is false.
  static func isWhiteSpaceString(_ k: VimText?) -> Bool {
    guard let k else { return false }
    return k.units.allSatisfy(isJSWhitespace)
  }

  /// vim.js's `isEndOfSentenceSymbol(k)`: `'.?!'.indexOf(k) != -1` (so "" is one; undefined isn't).
  static func isEndOfSentenceSymbol(_ k: VimText?) -> Bool {
    guard let k else { return false }
    return VimText(".?!").indexOf(k) != -1
  }

  /// `/^\w$/`: a single ASCII word character (vim.js's `latinCharRegex`).
  var isLatinChar: Bool { units.count == 1 && isJSAsciiWordChar(units[0]) }

  /// `/^[a-z]$/`.
  var isLowerCaseLetter: Bool { units.count == 1 && isASCIILower(units[0]) }

  /// `/^[\p{Lu}]$/u`: exactly one upper-case code point.
  var isUpperCaseLetter: Bool {
    if units.count == 1 { return isUppercaseLetter(units[0]) }
    if units.count == 2, isHighSurrogate(units[0]), isLowSurrogate(units[1]) {
      let value = 0x10000 + ((UInt32(units[0]) - 0xD800) << 10) + (UInt32(units[1]) - 0xDC00)
      return Unicode.Scalar(value)?.properties.generalCategory == .uppercaseLetter
    }
    return false
  }

  /// `/\d/.test(k)` (vim.js's `isNumber`).
  var containsDigit: Bool { units.contains(where: isASCIIDigit) }

  /// `'()[]{}'.indexOf(k) != -1`.
  var isMatchableSymbol: Bool { VimText("()[]{}").indexOf(self) != -1 }
}
