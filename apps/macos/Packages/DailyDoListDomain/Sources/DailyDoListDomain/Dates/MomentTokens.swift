/// The Moment format tokens @ddl/core understands.
// swift-format-ignore: AlwaysUseLowerCamelCase
// Each case is spelled as its token, and case matters (`MM` is the month, `mm` the minute).
enum MomentToken: String, CaseIterable, Sendable {
  case YYYY, YY, gggg, gg, GGGG, GG, MMMM, MMM, MM, M, DDDD, DDD, Do, DD, D
  case dddd, ddd, dd, d, E, e, ww, w, WW, W
  case HH, H, hh, h, mm, m, ss, s, A, a, X, x
}

/// A piece of a format string: literal text (plain or `[bracketed]`) or a token.
enum MomentSegment: Equatable {
  /// UTF-16 range of the literal text in the format.
  case literal(Range<Int>)
  case token(MomentToken)
}

/// Splits a format exactly like the core's `TOKEN_RE` scan: at each position a `[…]` literal
/// (only if a `]` follows; an unterminated `[` is plain text), else the longest token starting
/// with that letter, else one character of plain text.
enum MomentTokenizer {
  static func tokenize(_ p: UnsafePointer<UInt16>, _ n: Int) -> [MomentSegment] {
    var segments: [MomentSegment] = []
    var textStart = 0
    var i = 0
    func flush(_ end: Int) {
      if end > textStart { segments.append(.literal(textStart..<end)) }
    }
    while i < n {
      if p[i] == 0x5B {  // [
        var j = i + 1
        while j < n && p[j] != 0x5D { j += 1 }
        if j < n {
          flush(i)
          segments.append(.literal((i + 1)..<j))
          i = j + 1
          textStart = i
          continue
        }
      } else if let (token, length) = token(at: i, p, n) {
        flush(i)
        segments.append(.token(token))
        i += length
        textStart = i
        continue
      }
      i += 1
    }
    flush(n)
    return segments
  }

  private static func token(at i: Int, _ p: UnsafePointer<UInt16>, _ n: Int) -> (MomentToken, Int)?
  {
    let c = p[i]
    var run = 1
    while run < 4 && i + run < n && p[i + run] == c { run += 1 }
    switch c {
    case 0x59:  // Y
      return run >= 4 ? (.YYYY, 4) : run >= 2 ? (.YY, 2) : nil
    case 0x67:  // g
      return run >= 4 ? (.gggg, 4) : run >= 2 ? (.gg, 2) : nil
    case 0x47:  // G
      return run >= 4 ? (.GGGG, 4) : run >= 2 ? (.GG, 2) : nil
    case 0x4D:  // M
      return [(MomentToken.M, 1), (.MM, 2), (.MMM, 3), (.MMMM, 4)][run - 1]
    case 0x44:  // D: DDDD|DDD|Do|DD|D
      if run >= 3 { return run >= 4 ? (.DDDD, 4) : (.DDD, 3) }
      if i + 1 < n && p[i + 1] == 0x6F { return (.Do, 2) }
      return run == 2 ? (.DD, 2) : (.D, 1)
    case 0x64:  // d
      return [(MomentToken.d, 1), (.dd, 2), (.ddd, 3), (.dddd, 4)][run - 1]
    case 0x45: return (.E, 1)
    case 0x65: return (.e, 1)
    case 0x77: return run >= 2 ? (.ww, 2) : (.w, 1)
    case 0x57: return run >= 2 ? (.WW, 2) : (.W, 1)
    case 0x48: return run >= 2 ? (.HH, 2) : (.H, 1)
    case 0x68: return run >= 2 ? (.hh, 2) : (.h, 1)
    case 0x6D: return run >= 2 ? (.mm, 2) : (.m, 1)
    case 0x73: return run >= 2 ? (.ss, 2) : (.s, 1)
    case 0x41: return (.A, 1)
    case 0x61: return (.a, 1)
    case 0x58: return (.X, 1)
    case 0x78: return (.x, 1)
    default: return nil
    }
  }
}

enum MomentNames {
  static let months = [
    "January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December",
  ]
  static let weekdays = [
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
  ]
}
