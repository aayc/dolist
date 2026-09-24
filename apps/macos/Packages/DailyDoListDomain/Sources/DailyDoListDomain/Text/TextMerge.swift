/// Replaces the lines `start..<end` of the old text with `lines`.
public struct LineHunk: Hashable, Sendable {
  public var start: Int
  public var end: Int
  public var lines: [String]

  public init(start: Int, end: Int, lines: [String]) {
    self.start = start
    self.end = end
    self.lines = lines
  }
}

public struct MergeResult: Hashable, Sendable {
  public var text: String
  /// Both sides changed the same lines; `text` then keeps the local version of those lines.
  public var conflict: Bool

  public init(text: String, conflict: Bool) {
    self.text = text
    self.conflict = conflict
  }
}

/// Line-based three-way merge (port of @ddl/core `merge.ts`), for a note changed by the user
/// (local) and by someone else (remote, e.g. the agent) since the version both started from
/// (base). Edits to different lines merge; both sides inserting at the same place keep both (local
/// first); only changes to the same lines are a conflict.
///
/// Lines split on `\n` only and compare by UTF-16 code units, like JavaScript's `===` (Swift's
/// `==` would equate NFC and NFD spellings).
public enum TextMerge {
  /// Past this many edit steps the middle of two texts is treated as one replaced block.
  public static let maxEditDistance = 2_000

  /// `diffLines`: the hunks that turn `a` into `b` (Myers' O((N+M)·D) diff after trimming common
  /// ends).
  public static func diffLines(_ a: [String], _ b: [String]) -> [LineHunk] {
    var table = LineTable()
    let ids = (table.intern(a), table.intern(b))
    return diff(ids.0, ids.1).map { LineHunk(start: $0.start, end: $0.end, lines: Array(b[$0.lines])) }
  }

  /// `mergeText`.
  public static func merge(base: String, local: String, remote: String) -> MergeResult {
    if local.jsEquals(remote) || remote.jsEquals(base) { return MergeResult(text: local, conflict: false) }
    if local.jsEquals(base) { return MergeResult(text: remote, conflict: false) }
    var table = LineTable()
    let baseLines = table.intern(lines(base))
    let localLines = table.intern(lines(local))
    let remoteLines = table.intern(lines(remote))
    // JavaScript's sort is stable: at equal bounds local hunks (listed first) come first.
    let sides = (diff(baseLines, localLines).map { Side(hunk: $0, lines: localLines, isLocal: true) }
      + diff(baseLines, remoteLines).map { Side(hunk: $0, lines: remoteLines, isLocal: false) })
      .enumerated()
      .sorted { ($0.element.hunk.start, $0.element.hunk.end, $0.offset) < ($1.element.hunk.start, $1.element.hunk.end, $1.offset) }
      .map(\.element)

    var out: [Int] = []
    var conflict = false
    var position = 0
    var index = 0
    while index < sides.count {
      let first = sides[index]
      index += 1
      let start = first.hunk.start
      var end = first.hunk.end
      var cluster = [first]
      // A replaced range takes every hunk starting inside it; an insertion only other insertions
      // at the same place. Hunks that merely touch stay separate and apply one after the other.
      while index < sides.count {
        let next = sides[index].hunk
        let joins = end > start ? next.start < end : next.start == start && next.end == next.start
        if !joins { break }
        cluster.append(sides[index])
        index += 1
        end = max(end, next.end)
      }
      out += slice(baseLines, position, start)
      let mine = cluster.filter(\.isLocal)
      let theirs = cluster.filter { !$0.isLocal }
      let localVersion = apply(mine, to: baseLines, start, end)
      if theirs.isEmpty {
        out += localVersion
      } else {
        let remoteVersion = apply(theirs, to: baseLines, start, end)
        if mine.isEmpty || localVersion == remoteVersion {
          out += remoteVersion
        } else if start == end {
          out += localVersion + remoteVersion
        } else {
          conflict = true
          out += localVersion
        }
      }
      position = end
    }
    out += slice(baseLines, position, baseLines.count)
    return MergeResult(text: out.map { table.strings[$0] }.joined(separator: "\n"), conflict: conflict)
  }

  /// `text.split("\n")`: every line, empty ones included (a `\r` stays part of its line).
  public static func lines(_ text: String) -> [String] {
    UTF16Buffer(text).withPointer { p, n in
      var lines: [String] = []
      var start = 0
      var i = 0
      while i < n {
        if p[i] == 0x0A {
          lines.append(String(utf16: p, start..<i))
          start = i + 1
        }
        i += 1
      }
      lines.append(String(utf16: p, start..<n))
      return lines
    }
  }

  // MARK: - Implementation

  /// A hunk over line ids: `lines` indexes the new side.
  struct IDHunk: Equatable {
    var start: Int
    var end: Int
    var lines: Range<Int>
  }

  private struct Side {
    var hunk: IDHunk
    /// The side's lines (`hunk.lines` indexes them).
    var lines: [Int]
    var isLocal: Bool
  }

  /// Lines as small integers, equal exactly when the lines are equal code unit for code unit.
  private struct LineTable {
    var ids: [ExactString: Int] = [:]
    var strings: [String] = []

    mutating func intern(_ lines: [String]) -> [Int] {
      lines.map { line in
        let key = ExactString(line)
        if let id = ids[key] { return id }
        ids[key] = strings.count
        strings.append(line)
        return strings.count - 1
      }
    }
  }

  /// JavaScript's `lines.slice(from, to)`: empty when `from >= to`.
  private static func slice(_ lines: [Int], _ from: Int, _ to: Int) -> ArraySlice<Int> {
    let lower = max(0, min(from, lines.count))
    let upper = max(lower, min(to, lines.count))
    return lines[lower..<upper]
  }

  /// `applyHunks`: base lines `start..<end` with one side's hunks applied.
  private static func apply(_ sides: [Side], to base: [Int], _ start: Int, _ end: Int) -> [Int] {
    var out: [Int] = []
    var at = start
    for side in sides {
      out += slice(base, at, side.hunk.start)
      out += side.lines[side.hunk.lines]
      at = side.hunk.end
    }
    out += slice(base, at, end)
    return out
  }

  static func diff(_ a: [Int], _ b: [Int]) -> [IDHunk] {
    var prefix = 0
    while prefix < a.count && prefix < b.count && a[prefix] == b[prefix] { prefix += 1 }
    var suffix = 0
    while suffix < a.count - prefix && suffix < b.count - prefix && a[a.count - 1 - suffix] == b[b.count - 1 - suffix] {
      suffix += 1
    }
    let midA = Array(a[prefix..<(a.count - suffix)])
    let midB = Array(b[prefix..<(b.count - suffix)])
    if midA.isEmpty && midB.isEmpty { return [] }
    guard let pairs = commonPairs(midA, midB) else {
      return [IDHunk(start: prefix, end: a.count - suffix, lines: prefix..<(b.count - suffix))]
    }
    var hunks: [IDHunk] = []
    var i = 0
    var j = 0
    for (pi, pj) in pairs + [(midA.count, midB.count)] {
      if i < pi || j < pj {
        hunks.append(IDHunk(start: prefix + i, end: prefix + pi, lines: (prefix + j)..<(prefix + pj)))
      }
      i = pi + 1
      j = pj + 1
    }
    return hunks
  }

  /// Matching line pairs of a longest common subsequence, or nil past `maxEditDistance`.
  private static func commonPairs(_ a: [Int], _ b: [Int]) -> [(Int, Int)]? {
    let n = a.count
    let m = b.count
    if n == 0 || m == 0 { return [] }
    let maxD = n + m
    let offset = maxD + 1
    var v = [Int32](repeating: 0, count: 2 * maxD + 3)
    // trace[d] holds v[k] for k in -d...d after round d.
    var trace: [[Int32]] = []
    for d in 0...maxD {
      if d > maxEditDistance { return nil }
      var k = -d
      while k <= d {
        let down = k == -d || (k != d && v[offset + k - 1] < v[offset + k + 1])
        var x = Int(down ? v[offset + k + 1] : v[offset + k - 1] + 1)
        var y = x - k
        while x < n && y < m && a[x] == b[y] {
          x += 1
          y += 1
        }
        v[offset + k] = Int32(x)
        if x >= n && y >= m { return backtrack(trace, depth: d, n: n, m: m) }
        k += 2
      }
      trace.append(Array(v[(offset - d)...(offset + d)]))
    }
    return nil
  }

  private static func backtrack(_ trace: [[Int32]], depth: Int, n: Int, m: Int) -> [(Int, Int)] {
    var pairs: [(Int, Int)] = []
    func at(_ d: Int, _ k: Int) -> Int { Int(trace[d][k + d]) }
    var x = n
    var y = m
    var d = depth
    while d > 0 {
      let k = x - y
      let down = k == -d || (k != d && at(d - 1, k - 1) < at(d - 1, k + 1))
      let prevK = down ? k + 1 : k - 1
      let prevX = at(d - 1, prevK)
      let prevY = prevX - prevK
      let midX = down ? prevX : prevX + 1
      let midY = midX - k
      while x > midX && y > midY {
        x -= 1
        y -= 1
        pairs.append((x, y))
      }
      x = prevX
      y = prevY
      d -= 1
    }
    while x > 0 && y > 0 {
      x -= 1
      y -= 1
      pairs.append((x, y))
    }
    return pairs.reversed()
  }
}
