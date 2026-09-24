/// Text helpers ported from @ddl/core `text.ts`. Lengths, bigrams and truncation count UTF-16 code
/// units and case mapping follows JavaScript's `toLowerCase()`, so results match the daemon.
public enum TextTools {
  /// `normalizeText`: trims, collapses runs of whitespace to one space and lowercases.
  public static func normalize(_ text: String) -> String {
    String(utf16Units: normalizedUnits(text))
  }

  /// `diceSimilarity`: Sørensen–Dice coefficient over UTF-16 bigrams of the normalized texts (0…1).
  public static func diceSimilarity(_ a: String, _ b: String) -> Double {
    TextFeatures(a).similarity(TextFeatures(b))
  }

  /// `isPrefixExtension`: one normalized text extends the other (the user is still typing).
  public static func isPrefixExtension(_ a: String, _ b: String, minLength: Int = 3) -> Bool {
    TextFeatures(a).extends(TextFeatures(b), minLength: minLength)
  }

  /// `truncate`: at most `max` UTF-16 units, ending in `…` when cut, never splitting a surrogate
  /// pair; trailing whitespace before the ellipsis is trimmed.
  public static func truncate(_ text: String, max: Int) -> String {
    let buffer = UTF16Buffer(text)
    if buffer.count <= max { return text }
    if max < 1 { return "" }
    return buffer.withPointer { p, _ in
      var end = max - 1
      if end >= 1, p[end - 1] >= 0xD800, p[end - 1] <= 0xDBFF { end -= 1 }
      while end > 0 && isJSWhitespace(p[end - 1]) { end -= 1 }
      return String(utf16: p, count: end) + "…"
    }
  }

  /// `hashString`: fast non-cryptographic 53-bit hash (cyrb53) as 14 hex digits. Change detection
  /// only.
  public static func hash(_ text: String, seed: Int = 0) -> String {
    let s = UInt32(truncatingIfNeeded: seed)
    var h1: UInt32 = 0xDEAD_BEEF ^ s
    var h2: UInt32 = 0x41C6_CE57 ^ s
    for unit in text.utf16 {
      h1 = (h1 ^ UInt32(unit)) &* 2_654_435_761
      h2 = (h2 ^ UInt32(unit)) &* 1_597_334_677
    }
    h1 = ((h1 ^ (h1 >> 16)) &* 2_246_822_507) ^ ((h2 ^ (h2 >> 13)) &* 3_266_489_909)
    h2 = ((h2 ^ (h2 >> 16)) &* 2_246_822_507) ^ ((h1 ^ (h1 >> 13)) &* 3_266_489_909)
    let value = (UInt64(h2 & 0x1F_FFFF) << 32) + UInt64(h1)
    let hex = String(value, radix: 16)
    return String(repeating: "0", count: Swift.max(0, 14 - hex.count)) + hex
  }

  /// `splitLines`: splits on `\n` and `\r\n` (a lone `\r` is not a break).
  public static func splitLines(_ text: String) -> [String] {
    let buffer = UTF16Buffer(text)
    return buffer.withPointer { p, n in
      var lines: [String] = []
      var start = 0
      for i in 0..<n where p[i] == 0x0A {
        let end = i > start && p[i - 1] == 0x0D ? i - 1 : i
        lines.append(String(utf16: p, start..<end))
        start = i + 1
      }
      lines.append(String(utf16: p, start..<n))
      return lines
    }
  }

  /// JavaScript's `trim()`: removes WhiteSpace and LineTerminator code points at both ends.
  public static func trimmed(_ text: String) -> String {
    let buffer = UTF16Buffer(text)
    return buffer.withPointer { p, n in String(utf16: p, jsTrim(p, 0..<n)) }
  }

  /// JavaScript's `toLowerCase()`: full Unicode mappings plus the Final_Sigma rule.
  public static func lowercased(_ text: String) -> String {
    JSCase.lowercased(text)
  }

  static func normalizedUnits(_ text: String) -> [UInt16] {
    UTF16Buffer(text).withPointer { p, n in normalizedUnits(p, 0..<n) }
  }

  /// `input.trim().replace(/\s+/g, " ").toLowerCase()` on code units.
  static func normalizedUnits(_ p: UnsafePointer<UInt16>, _ range: Range<Int>) -> [UInt16] {
    let trimmed = jsTrim(p, range)
    var ascii = true
    let collapsed = [UInt16](unsafeUninitializedCapacity: trimmed.count) { out, count in
      var k = 0
      var i = trimmed.lowerBound
      while i < trimmed.upperBound {
        let u = p[i]
        if isJSWhitespace(u) {
          out[k] = 0x20
          k += 1
          while i < trimmed.upperBound && isJSWhitespace(p[i]) { i += 1 }
          continue
        }
        if u >= 0x80 { ascii = false }
        out[k] = u >= 0x41 && u <= 0x5A ? u + 32 : u
        k += 1
        i += 1
      }
      count = k
    }
    if ascii { return collapsed }
    return withUTF16Pointer(collapsed) { q, n in JSCase.lowercase(q, 0..<n) }
  }
}
