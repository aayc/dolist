// Ported from @marijn/find-cluster-break 1.0.4 (MIT, © Marijn Haverbeke), which CodeMirror 6 uses
// to move by grapheme cluster. The Extend table is Unicode 17's Grapheme_Cluster_Break=Extend.

enum ClusterBreak {
  /// Ranges (from, to) of code points that count as extending characters.
  private static let ranges: [(UInt32, UInt32)] = {
    let numbers =
      "lc,34,7n,7,7b,19,,,,2,,2,,,20,b,1c,l,g,,2t,7,2,6,2,2,,4,z,,u,r,2j,b,1m,9,9,,o,4,,9,,3,,5,17,3,1n,9,16,o,,x,1i,3,,i,,7,a,2,t,3,1k,,,7,2,2,2,3,9,,a,2,q,,2,3,1k,,,5,4,2,2,3,3,,u,2,3,,b,3,1k,,,8,,3,,3,k,2,m,6,,3,1k,,,7,2,2,2,3,7,3,a,2,u,,1n,5,3,3,,4,9,,14,5,1j,,,7,,3,,4,7,2,b,2,t,3,1k,,,7,,3,,4,7,2,b,2,f,,c,4,1j,2,,7,,3,,4,9,,a,2,t,3,1y,,4,6,,,,8,i,2,1p,,,8,c,8,2q,,,a,b,7,21,2,r,,,,,,4,2,1d,k,,2,5,b,,10,9,,2u,b,,6,n,4,4,3,g,4,d,,,3,6,,f,,jj,3,qa,4,s,3,t,2,u,2,1s,w,9,,19,3,,,39,2,y,,3a,c,4,c,63,5,1l,a,,,,,2,o,2,,1c,1a,2,c,k,5,1b,h,12,9,c,3,u,d,1k,e,1c,k,48,3,,l,4,,6,,2,3,5i,1s,ek,,5f,x,2da,3,3x,,2o,w,fe,6,2x,2,n9w,4,,a,w,2,28,2,7k,,3,,4,,n,5,4,,2b,2,1e,i,q,i,d,,12,8,p,d,18,4,1b,e,10,,1v,e,c,,8,2,1a,,1f,,,3,2,2,5,2,,,15,5,5,2,6k,8,,2,fn4,,kh,g,g,g,a6,2,gt,,6a,,45,5,1ae,3,,2,5,4,14,3,4,,4l,2,fx,4,1t,5,8t,2,25,6,1y,b,1d,4,3e,3,1h,f,15,,2,2,a,4,19,b,7,,1p,3,10,e,g,2,18,,c,3,1c,e,8,4,,2,2k,c,6,,2,,4d,c,l,4,1j,2,,7,2,2,2,3,9,,a,2,2,7,3,5,1v,9,,,2,,,4,,5,,,e,2,2a,i,n,,29,k,6j,7,2,9,r,2,2a,h,2y,d,2t,3,2,a,74,f,6t,6,,2,2,4,,,,2,3x,7,2,7,3,,s,a,14,7,,4,8,,9,b,1a,g,5i,8,5j,8,,8,2a,m,,e,3e,6,3,,,2,,7,,,1u,5,,2,,5,9n,4,9,2,,,1c,7,3,5,n,,44l,,6,f,8ug,i,1xc,5,1n,7,t4,,,1j,7,4,29,,b,2,f57,2,3mp,1a,2,n,f2,5,3,6,8,8,2,7,u,4,44,3,1iz,1j,4,1e,8,,e,,m,5,,f,11s,7,,h,2,7,,2,,5,2s,,4g,7,af,,1p,4,e4,4,72,2,6r,,2,,7,2,5,,d6,7,31,7,240,5"
    let values = numbers.split(separator: ",", omittingEmptySubsequences: false).map {
      $0.isEmpty ? UInt32(1) : UInt32($0, radix: 36)!
    }
    var result: [(UInt32, UInt32)] = []
    var n: UInt32 = 0
    var from: UInt32 = 0
    for (i, value) in values.enumerated() {
      n += value
      if i % 2 == 0 { from = n } else { result.append((from, n)) }
    }
    return result
  }()

  static func isExtendingChar(_ code: UInt32) -> Bool {
    if code < 768 { return false }
    var lo = 0
    var hi = ranges.count
    while lo < hi {
      let mid = (lo + hi) >> 1
      if code < ranges[mid].0 {
        hi = mid
      } else if code >= ranges[mid].1 {
        lo = mid + 1
      } else {
        return true
      }
    }
    return false
  }

  private static func isRegionalIndicator(_ code: UInt32) -> Bool {
    code >= 0x1F1E6 && code <= 0x1F1FF
  }

  private static func size(_ code: UInt32) -> Int { code < 0x10000 ? 1 : 2 }

  /// `findClusterBreak(str, pos, forward)`: the next grapheme cluster break after (or before)
  /// `pos`, or `pos` itself when there is none.
  static func find(
    _ units: [UInt16], _ pos: Int, forward: Bool = true, includeExtending: Bool = true
  ) -> Int {
    forward ? next(units, pos, includeExtending) : prev(units, pos, includeExtending)
  }

  private static func next(_ str: [UInt16], _ start: Int, _ includeExtending: Bool) -> Int {
    var pos = start
    if pos == str.count { return pos }
    if pos > 0, isLowSurrogate(str[pos]), isHighSurrogate(str[pos - 1]) { pos -= 1 }
    var prev = codePointAt(str, pos)
    pos += size(prev)
    while pos < str.count {
      let next = codePointAt(str, pos)
      if prev == 0x200D || next == 0x200D || (includeExtending && isExtendingChar(next)) {
        pos += size(next)
        prev = next
      } else if isRegionalIndicator(next) {
        var countBefore = 0
        var i = pos - 2
        while i >= 0, isRegionalIndicator(codePointAt(str, i)) {
          countBefore += 1
          i -= 2
        }
        if countBefore % 2 == 0 { break } else { pos += 2 }
      } else {
        break
      }
    }
    return pos
  }

  private static func prev(_ str: [UInt16], _ start: Int, _ includeExtending: Bool) -> Int {
    var pos = start
    while pos > 1 {
      let found = next(str, pos - 2, includeExtending)
      if found < pos { return found }
      pos -= 1
    }
    return 0
  }
}

/// The grapheme boundary before (or after) `offset` in `text`, with extended grapheme clusters
/// (Swift's `Character`, like the `Intl.Segmenter` the vector harness uses for native Backspace and
/// Delete). A lone surrogate reads as U+FFFD, which keeps UTF-16 offsets.
func graphemeBoundary(_ text: VimText, _ offset: Int, forward: Bool) -> Int {
  let string = String(decoding: text.units, as: UTF16.self)
  var previous = 0
  var index = 0
  for character in string {
    let end = index + character.utf16.count
    if !forward {
      if end >= offset { return index < offset ? index : previous }
      previous = index
    } else if index >= offset {
      return end
    }
    index = end
  }
  return forward ? text.length : previous
}

/// `countColumn(string, tabSize, to)` of @codemirror/state: tabs advance to the next tab stop,
/// every other grapheme cluster counts one.
func countColumn(_ text: VimText, tabSize: Int, to: Int? = nil) -> Int {
  let end = min(to ?? text.length, text.length)
  var n = 0
  var i = 0
  while i < end {
    if text[i] == 0x09 {
      n += tabSize - (n % tabSize)
      i += 1
    } else {
      n += 1
      i = ClusterBreak.find(text.units, i)
    }
  }
  return n
}
