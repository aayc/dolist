import DailyDoListModels
import Foundation

/// A task with a stable identity. Identity survives edits, reordering and status changes so that
/// agent threads stay attached to "the same" to-do item while the user rewrites it.
public struct TrackedTask: Hashable, Sendable, Codable, Identifiable {
  public var id: String
  public var text: String
  public var status: TaskStatus
  public var line: Int
  public var depth: Int
  public var parentId: String?
  public var notes: [String]
  /// Epoch ms when the task was first observed.
  public var firstSeenAt: EpochMillis
  /// Epoch ms of the last text/notes/status change.
  public var updatedAt: EpochMillis
  /// The agent wrote this task (see `ParsedTask.agent`).
  public var agent: Bool

  public init(
    id: String, text: String, status: TaskStatus, line: Int, depth: Int, parentId: String?,
    notes: [String], firstSeenAt: EpochMillis, updatedAt: EpochMillis, agent: Bool = false
  ) {
    self.id = id
    self.text = text
    self.status = status
    self.line = line
    self.depth = depth
    self.parentId = parentId
    self.notes = notes
    self.firstSeenAt = firstSeenAt
    self.updatedAt = updatedAt
    self.agent = agent
  }
}

public enum TaskChangeKind: String, Sendable, Hashable, Codable {
  case text, notes
}

/// What changed between two tracking passes.
public struct TaskDiff: Hashable, Sendable {
  public struct Update: Hashable, Sendable {
    public var task: TrackedTask
    public var previous: TrackedTask
    /// Text and/or notes, in that order.
    public var changes: [TaskChangeKind]
  }

  public struct StatusChange: Hashable, Sendable {
    public var task: TrackedTask
    public var previous: TrackedTask
  }

  /// New tasks, in document order.
  public var added: [TrackedTask] = []
  /// Tasks whose text and/or notes changed, in document order.
  public var updated: [Update] = []
  public var statusChanged: [StatusChange] = []
  /// Previous tasks that are gone, in their previous order.
  public var removed: [TrackedTask] = []

  public init() {}

  /// `isEmptyDiff`.
  public var isEmpty: Bool {
    added.isEmpty && updated.isEmpty && statusChanged.isEmpty && removed.isEmpty
  }
}

public struct TaskTrackingResult: Hashable, Sendable {
  /// One tracked task per parsed task, in document order.
  public var tasks: [TrackedTask]
  public var diff: TaskDiff
}

/// Task identity across edits, port of @ddl/core `markdown/task-tracker.ts`.
public enum TaskTracker {
  public static let defaultSimilarityThreshold = 0.5

  /// `trackTasks`: matches freshly parsed tasks against previously tracked ones. Passes, in order:
  /// 1. identical normalized text; a text found once on each side is an anchor, duplicates are
  ///    aligned in order, preferring the lines the anchors predict;
  /// 2. fuzzy: prefix extension (still typing, counts as 0.9) or Dice similarity ≥ threshold,
  ///    minus 0.01 per line moved (at most 0.2), assigned greedily by best score;
  /// 3. same line with weak similarity (≥ 0.3): an in-place rewrite.
  /// Unmatched parsed tasks get ids from `idFactory` (called in document order) and are `added`;
  /// unmatched previous tasks are `removed`.
  public static func track(
    previous: [TrackedTask],
    parsed: [ParsedTask],
    now: EpochMillis = currentMillis(),
    similarityThreshold: Double = defaultSimilarityThreshold,
    idFactory: () -> String = { TaskTracker.makeID() }
  ) -> TaskTrackingResult {
    let matchOf = TaskMatcher(
      previous: previous.map { ($0.text, $0.line) }, parsed: parsed.map { ($0.text, $0.line) },
      threshold: similarityThreshold
    ).match()

    var tasks: [TrackedTask] = []
    tasks.reserveCapacity(parsed.count)
    var usedPrevious = [Bool](repeating: false, count: previous.count)
    // Per parsed task: nil when added, else which of text / notes / status changed.
    var changes: [(text: Bool, notes: Bool, status: Bool)?] = []
    changes.reserveCapacity(parsed.count)
    for (pi, p) in parsed.enumerated() {
      let ci = matchOf[pi]
      guard ci >= 0 else {
        tasks.append(
          TrackedTask(
            id: idFactory(), text: p.text, status: p.status, line: p.line, depth: p.depth,
            parentId: nil,
            notes: p.notes, firstSeenAt: now, updatedAt: now, agent: p.agent))
        changes.append(nil)
        continue
      }
      let prev = previous[ci]
      usedPrevious[ci] = true
      let change = (
        text: !prev.text.jsEquals(p.text), notes: !sameNotes(prev.notes, p.notes),
        status: prev.status != p.status
      )
      tasks.append(
        TrackedTask(
          id: prev.id, text: p.text, status: p.status, line: p.line, depth: p.depth, parentId: nil,
          notes: p.notes, firstSeenAt: prev.firstSeenAt,
          updatedAt: change.text || change.notes || change.status ? now : prev.updatedAt,
          agent: p.agent))
      changes.append(change)
    }
    let taskAtLine = lineLookup(parsed)
    for (pi, p) in parsed.enumerated() {
      if let line = p.parentLine, let parent = taskAtLine(line) {
        tasks[pi].parentId = tasks[parent].id
      }
    }

    var diff = TaskDiff()
    for (pi, task) in tasks.enumerated() {
      guard let change = changes[pi] else {
        diff.added.append(task)
        continue
      }
      let prev = previous[matchOf[pi]]
      var kinds: [TaskChangeKind] = []
      if change.text { kinds.append(.text) }
      if change.notes { kinds.append(.notes) }
      if !kinds.isEmpty { diff.updated.append(.init(task: task, previous: prev, changes: kinds)) }
      if change.status { diff.statusChanged.append(.init(task: task, previous: prev)) }
    }
    for (ci, prev) in previous.enumerated() where !usedPrevious[ci] { diff.removed.append(prev) }
    return TaskTrackingResult(tasks: tasks, diff: diff)
  }

  /// The index of the last parsed task on a line (the core's `idByLine` map): a binary search
  /// when lines increase, as they do coming from the parser.
  private static func lineLookup(_ parsed: [ParsedTask]) -> (Int) -> Int? {
    let lines = parsed.map(\.line)
    if zip(lines, lines.dropFirst()).allSatisfy({ $0 < $1 }) {
      return { line in
        let index = TaskMatcher.lowerBound(lines, line)
        return index < lines.count && lines[index] == line ? index : nil
      }
    }
    var byLine: [Int: Int] = [:]
    for (index, line) in lines.enumerated() { byLine[line] = index }
    return { byLine[$0] }
  }

  /// `track` on a document's text.
  public static func track(
    previous: [TrackedTask], markdown: String, now: EpochMillis = currentMillis(),
    similarityThreshold: Double = defaultSimilarityThreshold,
    idFactory: () -> String = { TaskTracker.makeID() }
  ) -> TaskTrackingResult {
    track(
      previous: previous, parsed: TaskParser.parse(markdown), now: now,
      similarityThreshold: similarityThreshold, idFactory: idFactory)
  }

  /// The core's default id: `tsk_` and 10 random base-36 characters.
  public static func makeID() -> String {
    let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz".utf8)
    var generator = SystemRandomNumberGenerator()
    let body = (0..<10).map { _ in alphabet[Int(UInt8.random(in: 0...255, using: &generator)) % 36]
    }
    return "tsk_" + String(decoding: body, as: UTF8.self)
  }

  /// Whole milliseconds since the epoch, like `Date.now()`.
  public static func currentMillis() -> EpochMillis {
    (Date().timeIntervalSince1970 * 1000).rounded(.down)
  }

  private static func sameNotes(_ a: [String], _ b: [String]) -> Bool {
    a.count == b.count && zip(a, b).allSatisfy { $0.jsEquals($1) }
  }
}

/// The three matching passes of `trackTasks`.
struct TaskMatcher {
  /// Above this many candidate pairs, the fuzzy pass only compares tasks on nearby lines.
  static let fuzzyPairBudget = 40_000
  static let minFuzzyWindow = 20
  /// Duplicate groups bigger than this (parsed × previous) are aligned greedily, not optimally.
  static let alignCellBudget = 250_000
  /// Weight of the displacement cost over the raw line distance used to break its ties.
  static let tieScale = 1 << 20

  let previousLines: [Int]
  let parsedLines: [Int]
  let previousText: [TextFeatures]
  let parsedText: [TextFeatures]
  let threshold: Double

  init(
    previous: [(text: String, line: Int)], parsed: [(text: String, line: Int)], threshold: Double
  ) {
    previousLines = previous.map(\.line)
    parsedLines = parsed.map(\.line)
    previousText = previous.map { TextFeatures($0.text) }
    parsedText = parsed.map { TextFeatures($0.text) }
    self.threshold = threshold
  }

  /// Group numbers of identical normalized texts, numbered in first-seen order (open addressing
  /// on the text hash; a flat table stays fast in unoptimized builds, unlike `Dictionary`).
  static func groups(_ features: [TextFeatures]) -> (groupOf: [Int], count: Int) {
    var capacity = 16
    while capacity < features.count * 2 { capacity <<= 1 }
    let mask = capacity - 1
    var slots = [Int](repeating: -1, count: capacity)  // index of the group's first text
    var groupOf = [Int](repeating: 0, count: features.count)
    var count = 0
    slots.withUnsafeMutableBufferPointer { slotBuffer in
      groupOf.withUnsafeMutableBufferPointer { groupBuffer in
        let s = slotBuffer.baseAddress!
        for (index, text) in features.enumerated() {
          var slot =
            Int(
              truncatingIfNeeded: UInt64(bitPattern: Int64(text.hash)) &* 0x9E37_79B9_7F4A_7C15
                >> 32) & mask
          while true {
            let first = s[slot]
            if first < 0 {
              s[slot] = index
              groupBuffer[index] = count
              count += 1
              break
            }
            if features[first].isEqual(to: text) {
              groupBuffer[index] = groupBuffer[first]
              break
            }
            slot = (slot + 1) & mask
          }
        }
      }
    }
    return (groupOf, count)
  }

  /// For each parsed task, the index of the previous task it continues, or -1.
  func match() -> [Int] {
    var matchOf = [Int](repeating: -1, count: parsedLines.count)
    var usedPrevious = [Bool](repeating: false, count: previousLines.count)
    func link(_ pi: Int, _ ci: Int) {
      matchOf[pi] = ci
      usedPrevious[ci] = true
    }

    // Pass 1: identical normalized text, grouped in first-seen order (previous tasks first).
    let (groupOf, groupCount) = Self.groups(previousText + parsedText)
    var groupPrevious = [[Int]](repeating: [], count: groupCount)
    var groupParsed = [[Int]](repeating: [], count: groupCount)
    for ci in previousText.indices { groupPrevious[groupOf[ci]].append(ci) }
    for pi in parsedText.indices { groupParsed[groupOf[previousText.count + pi]].append(pi) }

    var anchors: [(line: Int, shift: Int, order: Int)] = []
    for g in groupPrevious.indices where groupPrevious[g].count == 1 && groupParsed[g].count == 1 {
      let pi = groupParsed[g][0]
      let ci = groupPrevious[g][0]
      link(pi, ci)
      anchors.append((parsedLines[pi], parsedLines[pi] - previousLines[ci], anchors.count))
    }
    anchors.sort { ($0.line, $0.order) < ($1.line, $1.order) }
    /// Where a parsed line sat before the edit, judging by the nearest anchor (above first).
    func expectedLine(_ line: Int) -> Int {
      var lo = 0
      var hi = anchors.count
      while lo < hi {
        let mid = (lo + hi) >> 1
        if anchors[mid].line <= line { lo = mid + 1 } else { hi = mid }
      }
      let anchor = lo > 0 ? anchors[lo - 1] : anchors.first
      return line - (anchor?.shift ?? 0)
    }

    var expected = [Int?](repeating: nil, count: parsedLines.count)
    func duplicateCost(_ pi: Int, _ ci: Int) -> Double {
      let p = parsedLines[pi]
      let c = previousLines[ci]
      let e: Int
      if let cached = expected[pi] {
        e = cached
      } else {
        e = expectedLine(p)
        expected[pi] = e
      }
      return Double(abs(e - c)) * Double(Self.tieScale) + Double(min(abs(p - c), Self.tieScale - 1))
    }
    for g in groupPrevious.indices {
      let prev = groupPrevious[g]
      let next = groupParsed[g]
      if prev.isEmpty || next.isEmpty || (prev.count == 1 && next.count == 1) { continue }
      Self.alignDuplicates(
        next: next.sorted { (parsedLines[$0], $0) < (parsedLines[$1], $1) },
        previous: prev.sorted { (previousLines[$0], $0) < (previousLines[$1], $1) },
        cost: duplicateCost, link: link)
    }

    // Pass 2: fuzzy matching among the leftovers.
    let openParsed = parsedLines.indices.filter { matchOf[$0] < 0 }
    let openPrevious = previousLines.indices.filter { !usedPrevious[$0] }
    var pairs: [(pi: Int, ci: Int, score: Double, order: Int)] = []
    func consider(_ pi: Int, _ ci: Int) {
      let a = parsedText[pi]
      let b = previousText[ci]
      let extends = a.extends(b)
      // Dice can't beat its bound: skipping those pairs changes nothing but saves the bigrams.
      if !extends, a.count >= 2, b.count >= 2, a.similarityBound(b) < threshold { return }
      var similarity = a.similarity(b)
      if extends { similarity = max(similarity, 0.9) }
      if similarity < threshold { return }
      let penalty = Double(min(abs(previousLines[ci] - parsedLines[pi]), 20)) * 0.01
      pairs.append((pi, ci, similarity - penalty, pairs.count))
    }
    if openParsed.count * openPrevious.count <= Self.fuzzyPairBudget {
      for pi in openParsed {
        for ci in openPrevious { consider(pi, ci) }
      }
    } else {
      // A mass rewrite: only nearby lines can plausibly be the same task.
      let window = max(Self.minFuzzyWindow, Self.fuzzyPairBudget / (2 * openParsed.count))
      let sorted = openPrevious.sorted { (previousLines[$0], $0) < (previousLines[$1], $1) }
      let lines = sorted.map { previousLines[$0] }
      for pi in openParsed {
        let center = expectedLine(parsedLines[pi])
        var k = Self.lowerBound(lines, center - window)
        while k < sorted.count && lines[k] <= center + window {
          consider(pi, sorted[k])
          k += 1
        }
      }
    }
    pairs.sort { $0.score != $1.score ? $0.score > $1.score : $0.order < $1.order }
    for pair in pairs where matchOf[pair.pi] < 0 && !usedPrevious[pair.ci] {
      link(pair.pi, pair.ci)
    }

    // Pass 3: in-place rewrite on the same line.
    var openByLine: [Int: [Int]] = [:]
    for ci in previousLines.indices where !usedPrevious[ci] {
      openByLine[previousLines[ci], default: []].append(ci)
    }
    for pi in parsedLines.indices where matchOf[pi] < 0 {
      guard let ci = openByLine[parsedLines[pi]]?.first(where: { !usedPrevious[$0] }) else {
        continue
      }
      if parsedText[pi].similarity(previousText[ci]) >= 0.3 { link(pi, ci) }
    }
    return matchOf
  }

  /// Pairs up tasks that share one text. Both lists are sorted by line; every task of the shorter
  /// list is matched, in order, to the task of the longer list that minimizes the total cost.
  static func alignDuplicates(
    next: [Int], previous: [Int], cost: (Int, Int) -> Double, link: (Int, Int) -> Void
  ) {
    let nextIsLong = next.count >= previous.count
    let long = nextIsLong ? next : previous
    let short = nextIsLong ? previous : next
    func pairCost(_ l: Int, _ s: Int) -> Double { nextIsLong ? cost(l, s) : cost(s, l) }
    func pair(_ l: Int, _ s: Int) { nextIsLong ? link(l, s) : link(s, l) }

    if long.count * short.count > alignCellBudget {
      var taken = [Bool](repeating: false, count: long.count)
      for s in short {
        var best = -1
        var bestCost = 0.0
        for i in long.indices where !taken[i] {
          let c = pairCost(long[i], s)
          if best == -1 || c < bestCost {
            best = i
            bestCost = c
          }
        }
        taken[best] = true
        pair(long[best], s)
      }
      return
    }

    // best[i][j]: cheapest way to match short[0..<j] to an increasing subsequence of long[0..<i].
    let cols = short.count + 1
    var best = [Double](repeating: .infinity, count: (long.count + 1) * cols)
    var took = [Bool](repeating: false, count: (long.count + 1) * cols)
    best.withUnsafeMutableBufferPointer { bestBuffer in
      took.withUnsafeMutableBufferPointer { tookBuffer in
        let b = bestBuffer.baseAddress!
        let t = tookBuffer.baseAddress!
        for i in 0...long.count { b[i * cols] = 0 }
        guard !long.isEmpty, !short.isEmpty else { return }
        for i in 1...long.count {
          for j in 1...min(i, short.count) {
            let skip = b[(i - 1) * cols + j]
            let take = b[(i - 1) * cols + j - 1] + pairCost(long[i - 1], short[j - 1])
            // Ties keep the earlier task of the longer list, like a nearest-line scan would.
            if take < skip {
              b[i * cols + j] = take
              t[i * cols + j] = true
            } else {
              b[i * cols + j] = skip
            }
          }
        }
      }
    }
    var i = long.count
    var j = short.count
    while j > 0 {
      if took[i * cols + j] {
        pair(long[i - 1], short[j - 1])
        j -= 1
      }
      i -= 1
    }
  }

  static func lowerBound(_ sorted: [Int], _ value: Int) -> Int {
    var lo = 0
    var hi = sorted.count
    while lo < hi {
      let mid = (lo + hi) >> 1
      if sorted[mid] < value { lo = mid + 1 } else { hi = mid }
    }
    return lo
  }
}
