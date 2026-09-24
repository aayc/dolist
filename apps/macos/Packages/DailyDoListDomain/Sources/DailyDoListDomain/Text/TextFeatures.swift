import Foundation

// Hot loops below are `while` loops over raw pointers: in unoptimized (test) builds `for … in`
// ranges and array subscripts cost an order of magnitude more.

/// A task text normalized once (`normalizeText`), with a hash for grouping identical texts and
/// lazily built bigram counts for Dice similarity. Port of the tracker's `TextFeatures`.
final class TextFeatures {
  let normalized: [UInt16]
  let hash: Int
  private var table: BigramTable?

  init(_ text: String) {
    normalized = TextFeatures.normalizeASCII(text) ?? TextTools.normalizedUnits(text)
    var h: UInt64 = 0xCBF2_9CE4_8422_2325  // FNV-1a
    withUTF16Pointer(normalized) { p, n in
      var i = 0
      while i < n {
        h = (h ^ UInt64(p[i])) &* 0x0000_0100_0000_01B3
        i += 1
      }
    }
    hash = Int(truncatingIfNeeded: h)
  }

  var count: Int { normalized.count }

  func isEqual(to other: TextFeatures) -> Bool {
    guard hash == other.hash, count == other.count else { return false }
    return normalized.withUnsafeBytes { a in
      other.normalized.withUnsafeBytes { b in a.count == 0 || memcmp(a.baseAddress!, b.baseAddress!, a.count) == 0 }
    }
  }

  /// Same value as `diceSimilarity` on the original texts. Streams this text's bigrams against
  /// the other's (cached) counts, so matching one text against many builds one table.
  func similarity(_ other: TextFeatures) -> Double {
    if isEqual(to: other) { return 1 }
    if count < 2 || other.count < 2 { return 0 }
    if other.table == nil { other.table = BigramTable(other.normalized) }
    let overlap = withUTF16Pointer(normalized) { p, n in other.table!.overlap(streaming: p, count: n) }
    return Double(2 * overlap) / Double(count - 1 + (other.count - 1))
  }

  /// An upper bound of `similarity(other)` that needs no bigrams (both texts ≥ 2 units long).
  func similarityBound(_ other: TextFeatures) -> Double {
    let x = count - 1
    let y = other.count - 1
    return Double(2 * Swift.min(x, y)) / Double(x + y)
  }

  /// Same value as `isPrefixExtension` on the original texts.
  func extends(_ other: TextFeatures, minLength: Int = 3) -> Bool {
    guard count >= minLength, other.count >= minLength else { return false }
    let length = Swift.min(count, other.count)
    return normalized.withUnsafeBytes { a in
      other.normalized.withUnsafeBytes { b in length == 0 || memcmp(a.baseAddress!, b.baseAddress!, length * 2) == 0 }
    }
  }

  /// `normalizeText` straight from the UTF-8 bytes of an ASCII text (nil otherwise): the common
  /// case, without the intermediate buffers of the general path.
  private static func normalizeASCII(_ text: String) -> [UInt16]? {
    var copy = text
    return copy.withUTF8 { bytes -> [UInt16]? in
      guard let p = bytes.baseAddress, bytes.count > 0 else { return [] }
      let n = bytes.count
      var i = 0
      while i < n {
        if p[i] >= 0x80 { return nil }
        i += 1
      }
      // ASCII whitespace for `\s`: 0x09-0x0D and space.
      var start = 0
      var end = n
      while start < end && (p[start] == 0x20 || (p[start] >= 0x09 && p[start] <= 0x0D)) { start += 1 }
      while end > start && (p[end - 1] == 0x20 || (p[end - 1] >= 0x09 && p[end - 1] <= 0x0D)) { end -= 1 }
      return [UInt16](unsafeUninitializedCapacity: end - start) { out, count in
        guard let o = out.baseAddress else {
          count = 0
          return
        }
        var k = 0
        var j = start
        while j < end {
          let b = p[j]
          if b == 0x20 || (b >= 0x09 && b <= 0x0D) {
            o[k] = 0x20
            j += 1
            while j < end && (p[j] == 0x20 || (p[j] >= 0x09 && p[j] <= 0x0D)) { j += 1 }
          } else {
            o[k] = UInt16(b >= 0x41 && b <= 0x5A ? b + 32 : b)
            j += 1
          }
          k += 1
        }
        count = k
      }
    }
  }
}

/// Multiset of UTF-16 bigrams in an open-addressing hash table (flat arrays, pointer access).
struct BigramTable {
  private var keys: [UInt32]
  private var counts: [Int32]
  private let mask: Int

  init(_ units: [UInt16]) {
    let pairs = Swift.max(0, units.count - 1)
    var capacity = 8
    while capacity < pairs * 2 { capacity <<= 1 }
    let mask = capacity - 1
    self.mask = mask
    var keys = [UInt32](repeating: 0, count: capacity)
    var counts = [Int32](repeating: 0, count: capacity)
    withUTF16Pointer(units) { u, _ in
      keys.withUnsafeMutableBufferPointer { kb in
        counts.withUnsafeMutableBufferPointer { cb in
          let k = kb.baseAddress!
          let c = cb.baseAddress!
          var i = 0
          while i < pairs {
            let key = UInt32(u[i]) << 16 | UInt32(u[i + 1])
            var slot = Int(truncatingIfNeeded: (key &* 0x9E37_79B1) >> 7) & mask
            while c[slot] != 0 && k[slot] != key { slot = (slot + 1) & mask }
            k[slot] = key
            c[slot] += 1
            i += 1
          }
        }
      }
    }
    self.keys = keys
    self.counts = counts
  }

  /// Σ min(count in `units`, count here) over bigrams: each bigram of `units` uses up one
  /// occurrence here, exactly like the core's `diceSimilarity` loop.
  func overlap(streaming units: UnsafePointer<UInt16>, count n: Int) -> Int {
    guard n >= 2 else { return 0 }
    let mask = self.mask
    return keys.withUnsafeBufferPointer { kb in
      counts.withUnsafeBufferPointer { cb in
        withUnsafeTemporaryAllocation(of: Int32.self, capacity: cb.count) { rb in
          let k = kb.baseAddress!
          let c = cb.baseAddress!  // occupancy: probe chains never shorten
          let r = rb.baseAddress!
          r.initialize(from: c, count: cb.count)
          var total = 0
          var i = 0
          while i < n - 1 {
            let key = UInt32(units[i]) << 16 | UInt32(units[i + 1])
            var slot = Int(truncatingIfNeeded: (key &* 0x9E37_79B1) >> 7) & mask
            while c[slot] != 0 {
              if k[slot] == key {
                if r[slot] > 0 {
                  r[slot] -= 1
                  total += 1
                }
                break
              }
              slot = (slot + 1) & mask
            }
            i += 1
          }
          return total
        }
      }
    }
  }
}
