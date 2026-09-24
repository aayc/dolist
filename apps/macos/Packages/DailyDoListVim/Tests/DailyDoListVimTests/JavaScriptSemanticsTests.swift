import Testing

@testable import DailyDoListVim

/// The JavaScript semantics vim.js relies on: word characters (`CodeMirror.isWordChar`),
/// whitespace (`/\s/`), full case mapping, `parseInt`, number formatting and `Math.round`.
@Suite struct JavaScriptSemanticsTests {
  private func unit(_ scalar: Unicode.Scalar) -> UInt16 { UInt16(scalar.value) }

  @Test func wordCharactersMatchCodeMirror() {
    // /[\w\p{Alphabetic}\p{Number}_]/u, tested one UTF-16 code unit at a time.
    for c: Unicode.Scalar in ["a", "Z", "0", "_", "é", "日", "\u{663}", "½", "ǅ", "ª", "Ⅰ"] {
      #expect(isWordChar(unit(c)), "\(c)")
    }
    for c: Unicode.Scalar in ["-", " ", "\u{301}", "\u{200B}", "。"] {
      #expect(!isWordChar(unit(c)), "\(c)")
    }
    // Surrogate halves are punctuation: an emoji is a two-unit "word" of its own.
    #expect(!isWordChar(0xD83D) && isPunctuationChar(0xD83D))
    #expect(
      isPunctuationChar(unit("-")) && !isPunctuationChar(unit("é")) && !isPunctuationChar(unit(" "))
    )
  }

  @Test func whitespaceIsJavaScripts() {
    for c: Unicode.Scalar in [
      "\t", "\n", "\u{B}", "\u{C}", "\r", " ", "\u{A0}", "\u{1680}", "\u{2000}", "\u{200A}",
      "\u{2028}", "\u{2029}", "\u{202F}", "\u{205F}", "\u{3000}", "\u{FEFF}",
    ] {
      #expect(isJSWhitespace(unit(c)), "U+\(String(c.value, radix: 16))")
    }
    for c: Unicode.Scalar in ["\u{85}", "\u{180E}", "\u{200B}", "a"] {
      #expect(!isJSWhitespace(unit(c)), "U+\(String(c.value, radix: 16))")
    }
  }

  @Test func caseMappingIsFullAndContextual() {
    func lower(_ s: String) -> String {
      String(decoding: JSCase.lowercase(Array(s.utf16)), as: UTF16.self)
    }
    func upper(_ s: String) -> String {
      String(decoding: JSCase.uppercase(Array(s.utf16)), as: UTF16.self)
    }
    #expect(lower("ΟΔΟΣ") == "οδος")
    #expect(lower("Σ") == "σ")
    #expect(lower("ΑΣ Σ") == "ας σ")
    #expect(upper("straße") == "STRASSE")
    #expect(upper("ﬁ") == "FI")
    #expect(lower("İ") == "i\u{307}")
    #expect(upper("ǆ") == "Ǆ")
    #expect(upper("😀a") == "😀A")
    // A lone surrogate passes through.
    #expect(JSCase.uppercase([0xD83D, 0x61]) == [0xD83D, 0x41])
  }

  @Test func parseIntFollowsJavaScript() {
    #expect(JSNumber.parseInt("08") == 8)
    #expect(JSNumber.parseInt("0x1f") == 31)
    #expect(JSNumber.parseInt("  -12px") == -12)
    #expect(JSNumber.parseInt("abc").isNaN)
    #expect(JSNumber.parseInt("123", radix: 2) == 1)
    #expect(JSNumber.parseInt("ff", radix: 16) == 255)
    #expect(JSNumber.parseInt("99999999999999999999") == 1e20)
    #expect(JSNumber.parseInt("9007199254740993") == 9_007_199_254_740_992)
    #expect(JSNumber.parseInt("9007199254740995") == 9_007_199_254_740_996)
    #expect(JSNumber.parseInt("fffffffffffffffff", radix: 16) == 295_147_905_179_352_825_856)
  }

  @Test func numbersFormatLikeJavaScript() {
    #expect(JSNumber.format(123) == "123")
    #expect(JSNumber.format(-0.0) == "0")
    #expect(JSNumber.format(0.1 + 0.2) == "0.30000000000000004")
    #expect(JSNumber.format(1e21) == "1e+21")
    #expect(JSNumber.format(1e-7) == "1e-7")
    #expect(JSNumber.format(255, radix: 16) == "ff")
    #expect(JSNumber.format(-255, radix: 2) == "-11111111")
    #expect(JSNumber.format(.infinity) == "Infinity")
  }

  @Test func mathRound() {
    #expect(JSNumber.round(2.5) == 3)
    #expect(JSNumber.round(-2.5) == -2)
    #expect(JSNumber.round(0.49999999999999994) == 0)
    #expect(JSNumber.round(-0.4).sign == .minus)
  }
}
