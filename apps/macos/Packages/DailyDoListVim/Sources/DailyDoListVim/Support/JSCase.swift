/// JavaScript case mapping: `toLowerCase()` / `toUpperCase()` use the root locale's full mappings
/// (`ß` → `SS`, `İ` → `i̇`) and `toLowerCase()` applies the Final_Sigma rule (Σ → ς at the end of a
/// word). Lone surrogates pass through unchanged.
enum JSCase {
  static func lowercase(_ units: [UInt16]) -> [UInt16] {
    var out: [UInt16] = []
    out.reserveCapacity(units.count)
    var i = 0
    while i < units.count {
      let u = units[i]
      if u < 0x80 {
        out.append(u >= 0x41 && u <= 0x5A ? u + 32 : u)
        i += 1
        continue
      }
      let (scalar, width) = decodeScalar(units, i)
      if let scalar, scalar.value == 0x03A3 {
        let final = isPrecededByCased(units, i) && !isFollowedByCased(units, i + 1)
        out.append(final ? 0x03C2 : 0x03C3)
      } else if let scalar, scalar.properties.changesWhenLowercased {
        out.append(contentsOf: scalar.properties.lowercaseMapping.utf16)
      } else {
        for k in 0..<width { out.append(units[i + k]) }
      }
      i += width
    }
    return out
  }

  static func uppercase(_ units: [UInt16]) -> [UInt16] {
    var out: [UInt16] = []
    out.reserveCapacity(units.count)
    var i = 0
    while i < units.count {
      let u = units[i]
      if u < 0x80 {
        out.append(u >= 0x61 && u <= 0x7A ? u - 32 : u)
        i += 1
        continue
      }
      let (scalar, width) = decodeScalar(units, i)
      if let scalar, scalar.properties.changesWhenUppercased {
        out.append(contentsOf: scalar.properties.uppercaseMapping.utf16)
      } else {
        for k in 0..<width { out.append(units[i + k]) }
      }
      i += width
    }
    return out
  }

  // MARK: Final_Sigma context (Unicode 3.13, as ICU implements it)

  private static func isPrecededByCased(_ units: [UInt16], _ index: Int) -> Bool {
    var i = index
    while i > 0 {
      let (scalar, width) = decodeScalarBackward(units, i)
      i -= width
      guard let scalar else { return false }
      if scalar.properties.isCaseIgnorable { continue }
      return scalar.properties.isCased
    }
    return false
  }

  private static func isFollowedByCased(_ units: [UInt16], _ index: Int) -> Bool {
    var i = index
    while i < units.count {
      let (scalar, width) = decodeScalar(units, i)
      i += width
      guard let scalar else { return false }
      if scalar.properties.isCaseIgnorable { continue }
      return scalar.properties.isCased
    }
    return false
  }
}

/// The scalar starting at `i` and its width in code units (nil for a lone surrogate, width 1).
@inline(__always)
func decodeScalar(_ units: [UInt16], _ i: Int) -> (Unicode.Scalar?, Int) {
  let u = units[i]
  if u & 0xF800 != 0xD800 { return (Unicode.Scalar(u), 1) }
  if u & 0xFC00 == 0xD800, i + 1 < units.count, units[i + 1] & 0xFC00 == 0xDC00 {
    let value = 0x10000 + ((UInt32(u) - 0xD800) << 10) + (UInt32(units[i + 1]) - 0xDC00)
    return (Unicode.Scalar(value), 2)
  }
  return (nil, 1)
}

/// The scalar ending just before `i`.
@inline(__always)
func decodeScalarBackward(_ units: [UInt16], _ i: Int) -> (Unicode.Scalar?, Int) {
  let u = units[i - 1]
  if u & 0xFC00 == 0xDC00, i - 2 >= 0, units[i - 2] & 0xFC00 == 0xD800 {
    return decodeScalar(units, i - 2)
  }
  return u & 0xF800 == 0xD800 ? (nil, 1) : (Unicode.Scalar(u), 1)
}

/// `codePointAt(i)` of JavaScript (a lone surrogate is returned as is).
@inline(__always)
func codePointAt(_ units: [UInt16], _ i: Int) -> UInt32 {
  let c0 = units[i]
  if !isHighSurrogate(c0) || i + 1 == units.count { return UInt32(c0) }
  let c1 = units[i + 1]
  if !isLowSurrogate(c1) { return UInt32(c0) }
  return ((UInt32(c0) - 0xD800) << 10) + (UInt32(c1) - 0xDC00) + 0x10000
}
