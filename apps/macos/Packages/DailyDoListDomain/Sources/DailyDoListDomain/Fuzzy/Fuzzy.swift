/// A fuzzy match of a query in a candidate.
public struct FuzzyMatch: Hashable, Sendable {
  /// Higher is better.
  public var score: Double
  /// Matched character offsets in the candidate (UTF-16), for highlighting.
  public var matchedOffsets: [Int]

  public init(score: Double, matchedOffsets: [Int]) {
    self.score = score
    self.matchedOffsets = matchedOffsets
  }
}

/// A ranked candidate: which element matched, where it was in the input, and how well.
public struct FuzzyResult<Element> {
  public var element: Element
  /// Position of `element` in the candidates passed to `rank`.
  public var index: Int
  public var match: FuzzyMatch
}

extension FuzzyResult: Sendable where Element: Sendable {}
extension FuzzyResult: Equatable where Element: Equatable {}
extension FuzzyResult: Hashable where Element: Hashable {}

/// Quick-switcher / command-palette matching. A case-insensitive subsequence match (whitespace in
/// the query is ignored) scored like the web app's `fuzzyMatch`: every matched character counts,
/// word starts (after space / \ - _ . : ( [ { #, camelCase humps, digits after letters) and the
/// very first character score extra, contiguous runs build a streak bonus (a larger one when the
/// run starts at a word start), gaps cost a little,
/// and exact case breaks ties. For paths, the file name matters most: characters matched in the
/// last path component score extra, and its first character counts like the very first one, so a
/// file named after the query beats the same letters spread over folder names. Linear in the
/// candidate length: a handful of alignments is scored instead of a full DP.
public enum Fuzzy {
  /// Subsequence match of `query` in `candidate`; nil when it doesn't match. An empty (or blank)
  /// query matches everything with score 0.
  public static func match(_ query: String, in candidate: String) -> FuzzyMatch? {
    let q = queryUnits(query)
    if q.original.isEmpty { return FuzzyMatch(score: 0, matchedOffsets: []) }
    return UTF16Buffer(candidate).withPointer { p, n in match(q, p, n) }
  }

  /// Matches and ranks `candidates`: best score first, then the shorter candidate, then input
  /// order (so equal candidates keep their order). At most `limit` results.
  public static func rank(query: String, candidates: [String], limit: Int = 50) -> [FuzzyResult<
    String
  >] {
    rank(query: query, in: candidates, limit: limit) { $0 }
  }

  /// Ranks arbitrary elements by the string `key` returns.
  public static func rank<Element>(
    query: String, in elements: [Element], limit: Int = 50, key: (Element) -> String
  ) -> [FuzzyResult<Element>] {
    let q = queryUnits(query)
    var results: [(result: FuzzyResult<Element>, length: Int)] = []
    for (index, element) in elements.enumerated() {
      let text = UTF16Buffer(key(element))
      let found: FuzzyMatch?
      if q.original.isEmpty {
        found = FuzzyMatch(score: 0, matchedOffsets: [])
      } else {
        found = text.withPointer { p, n in match(q, p, n) }
      }
      if let found {
        results.append((FuzzyResult(element: element, index: index, match: found), text.count))
      }
    }
    results.sort { a, b in
      if a.result.match.score != b.result.match.score {
        return a.result.match.score > b.result.match.score
      }
      if a.length != b.length { return a.length < b.length }
      return a.result.index < b.result.index
    }
    return results.prefix(max(0, limit)).map(\.result)
  }

  // MARK: - Matching

  private struct Query {
    /// Without whitespace.
    var original: [UInt16]
    /// Case-folded, one unit per unit.
    var folded: [UInt16]
  }

  private static func queryUnits(_ query: String) -> Query {
    let units = query.utf16.filter { !isJSWhitespace($0) }
    let folded = units.withUnsafeBufferPointer { buffer in
      buffer.isEmpty ? [] : JSCase.foldOneToOne(buffer.baseAddress!, buffer.count)
    }
    return Query(original: units, folded: folded)
  }

  private static func match(_ query: Query, _ target: UnsafePointer<UInt16>, _ n: Int)
    -> FuzzyMatch?
  {
    let q = query.folded
    guard q.count <= n else { return nil }
    let lower = JSCase.foldOneToOne(target, n)
    guard let last = latestPositions(lower, q, from: 0) else { return nil }

    var candidates = [
      greedy(lower, q, from: 0), boundaryPreferring(target, lower, q, last, from: 0),
    ]
    candidates += contiguous(lower, q, from: 0)
    // The file name of a path: align the query inside it too, when it fits there.
    let nameStart = (0..<n).last(where: { target[$0] == 0x2F }).map { $0 + 1 } ?? 0
    if nameStart > 0, let nameLast = latestPositions(lower, q, from: nameStart) {
      candidates.append(greedy(lower, q, from: nameStart))
      candidates.append(boundaryPreferring(target, lower, q, nameLast, from: nameStart))
      candidates += contiguous(lower, q, from: nameStart)
    }

    var best: FuzzyMatch?
    for indices in candidates where indices.count == q.count {
      let score = score(indices, target, n, query.original, nameStart: nameStart)
      if best.map({ score > $0.score }) ?? true {
        best = FuzzyMatch(score: score, matchedOffsets: indices)
      }
    }
    return best
  }

  private static let separators: Set<UInt16> = Set(" /\\-_.:([{#".utf16)

  private static func isBoundary(_ t: UnsafePointer<UInt16>, _ i: Int) -> Bool {
    if i == 0 { return true }
    let prev = t[i - 1]
    let cur = t[i]
    if separators.contains(prev) { return true }
    if prev >= 0x61 && prev <= 0x7A && cur >= 0x41 && cur <= 0x5A { return true }
    return isASCIIDigit(cur) && !isASCIIDigit(prev)
  }

  private static func score(
    _ indices: [Int], _ t: UnsafePointer<UInt16>, _ n: Int, _ query: [UInt16], nameStart: Int
  ) -> Double {
    var score = 0.0
    var prev = -2
    var streak = 0
    var runStartsWord = false
    for (k, i) in indices.enumerated() {
      let boundary = isBoundary(t, i)
      score += 1
      if i == 0 || (k == 0 && i == nameStart) {
        score += 8
      } else if boundary {
        score += 6
      }
      if i == prev + 1 {
        streak += 1
        score += 3 + Double(min(streak, 4))
        // A word prefix ("tod" in "today") beats the same letters scattered over word starts.
        if runStartsWord { score += 3 }
      } else {
        streak = 0
        runStartsWord = boundary
        if k > 0 { score -= Double(min(i - prev - 1, 6)) * 0.4 }
      }
      if t[i] == query[k] { score += 0.25 }
      // In a path, characters of the file name count double (folder acronyms count once).
      if nameStart > 0 && i >= nameStart { score += 2 }
      prev = i
    }
    return score - Double(n) * 0.01
  }

  /// Latest index at which q[k] may match while the rest of the query still fits after it.
  private static func latestPositions(_ lower: [UInt16], _ q: [UInt16], from start: Int) -> [Int]? {
    var last = [Int](repeating: 0, count: q.count)
    var k = q.count - 1
    var i = lower.count - 1
    while i >= start && k >= 0 {
      if lower[i] == q[k] {
        last[k] = i
        k -= 1
      }
      i -= 1
    }
    return k >= 0 ? nil : last
  }

  private static func greedy(_ lower: [UInt16], _ q: [UInt16], from start: Int) -> [Int] {
    var out: [Int] = []
    var k = 0
    var i = start
    while i < lower.count && k < q.count {
      if lower[i] == q[k] {
        out.append(i)
        k += 1
      }
      i += 1
    }
    return out
  }

  /// Prefers continuing a run, then a word start, else the earliest position that still leaves
  /// room for the rest of the query.
  private static func boundaryPreferring(
    _ t: UnsafePointer<UInt16>, _ lower: [UInt16], _ q: [UInt16], _ last: [Int], from start: Int
  ) -> [Int] {
    var out: [Int] = []
    var pos = start
    for k in q.indices {
      let ch = q[k]
      var chosen = -1
      if let prev = out.last, prev + 1 <= last[k], lower[prev + 1] == ch { chosen = prev + 1 }
      if chosen == -1 {
        var first = -1
        var i = pos
        while i <= last[k] {
          if lower[i] == ch {
            if first == -1 { first = i }
            if isBoundary(t, i) {
              chosen = i
              break
            }
          }
          i += 1
        }
        if chosen == -1 { chosen = first }
      }
      if chosen == -1 { return greedy(lower, q, from: start) }
      out.append(chosen)
      pos = chosen + 1
    }
    return out
  }

  /// Up to 8 places where the whole query appears as one run.
  private static func contiguous(_ lower: [UInt16], _ q: [UInt16], from start: Int) -> [[Int]] {
    var out: [[Int]] = []
    guard !q.isEmpty, lower.count >= q.count else { return out }
    var at = start
    while at + q.count <= lower.count && out.count < 8 {
      if lower[at] == q[0], lower[at..<(at + q.count)].elementsEqual(q) {
        out.append(Array(at..<(at + q.count)))
      }
      at += 1
    }
    return out
  }
}
