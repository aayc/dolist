// Ported from `ChangeDesc` / `ChangeSet` of @codemirror/state 6.7.6 (MIT, © Marijn Haverbeke and
// others), used by @replit/codemirror-vim 6.4.0 through CodeMirror 6 transactions. Positions are
// UTF-16 offsets into the document, whose lines are joined with "\n".

/// How positions are mapped through changes (`MapMode`).
enum MapMode {
  case simple
  /// Return nil if deletion happens across the position.
  case trackDel
  /// Return nil if the character before the position is deleted.
  case trackBefore
  /// Return nil if the character after the position is deleted.
  case trackAfter
}

/// A set of document changes: sections of (length, -1) for unchanged text and (length, inserted
/// length) for replaced text, plus the inserted texts.
struct ChangeSet {
  var sections: [Int]
  var inserted: [VimText]

  /// The length of the document before the change.
  var length: Int {
    var result = 0
    var i = 0
    while i < sections.count {
      result += sections[i]
      i += 2
    }
    return result
  }

  /// The length of the document after the change.
  var newLength: Int {
    var result = 0
    var i = 0
    while i < sections.count {
      let ins = sections[i + 1]
      result += ins < 0 ? sections[i] : ins
      i += 2
    }
    return result
  }

  var isEmpty: Bool { sections.isEmpty || (sections.count == 2 && sections[1] < 0) }

  static func empty(_ length: Int) -> ChangeSet {
    ChangeSet(sections: length > 0 ? [length, -1] : [], inserted: [])
  }

  /// Calls `f(fromA, toA, fromB, toB, text)` for every changed range.
  func iterChanges(individual: Bool = false, _ f: (Int, Int, Int, Int, VimText) -> Void) {
    var posA = 0, posB = 0, i = 0
    while i < sections.count {
      var len = sections[i], ins = sections[i + 1]
      i += 2
      if ins < 0 {
        posA += len
        posB += len
      } else {
        var endA = posA, endB = posB
        var text = VimText()
        while true {
          endA += len
          endB += ins
          if ins > 0 { text += textAt((i - 2) >> 1) }
          if individual || i == sections.count || sections[i + 1] < 0 { break }
          len = sections[i]
          ins = sections[i + 1]
          i += 2
        }
        f(posA, endA, posB, endB, text)
        posA = endA
        posB = endB
      }
    }
  }

  /// `iterChangedRanges(f, individual)`.
  func iterChangedRanges(individual: Bool = false, _ f: (Int, Int, Int, Int) -> Void) {
    iterChanges(individual: individual) { fromA, toA, fromB, toB, _ in f(fromA, toA, fromB, toB) }
  }

  func iterGaps(_ f: (Int, Int, Int) -> Void) {
    var posA = 0, posB = 0, i = 0
    while i < sections.count {
      let len = sections[i], ins = sections[i + 1]
      i += 2
      if ins < 0 {
        f(posA, posB, len)
        posB += len
      } else {
        posB += ins
      }
      posA += len
    }
  }

  private func textAt(_ index: Int) -> VimText {
    index < inserted.count ? inserted[index] : VimText()
  }

  /// `invertedDesc`: the inverse without texts.
  var invertedDesc: ChangeSet {
    var result: [Int] = []
    var i = 0
    while i < sections.count {
      let len = sections[i], ins = sections[i + 1]
      if ins < 0 { result += [len, ins] } else { result += [ins, len] }
      i += 2
    }
    return ChangeSet(sections: result, inserted: [])
  }

  /// `invert(doc)`: `slice(from, to)` reads the document before the changes.
  func invert(_ slice: (Int, Int) -> VimText) -> ChangeSet {
    var result = sections
    var texts: [VimText] = []
    var pos = 0
    var i = 0
    while i < result.count {
      let len = result[i], ins = result[i + 1]
      if ins >= 0 {
        result[i] = ins
        result[i + 1] = len
        let index = i >> 1
        while texts.count < index { texts.append(VimText()) }
        texts.append(len > 0 ? slice(pos, pos + len) : VimText())
      }
      pos += len
      i += 2
    }
    return ChangeSet(sections: result, inserted: texts)
  }

  /// `compose(other)`: this followed by `other`.
  func compose(_ other: ChangeSet) -> ChangeSet {
    isEmpty ? other : other.isEmpty ? self : composeSets(self, other, mkSet: true)
  }

  func composeDesc(_ other: ChangeSet) -> ChangeSet {
    isEmpty ? other : other.isEmpty ? self : composeSets(self, other, mkSet: false)
  }

  /// `map(other, before)`: this change set rebased over `other` (both start in the same document).
  func map(_ other: ChangeSet, before: Bool = false) -> ChangeSet {
    other.isEmpty ? self : mapSet(self, other, before: before, mkSet: true)
  }

  func mapDesc(_ other: ChangeSet, before: Bool = false) -> ChangeSet {
    other.isEmpty ? self : mapSet(self, other, before: before, mkSet: false)
  }

  /// `mapPos(pos, assoc, mode)`; nil when `mode` tracks a deletion.
  func mapPos(_ pos: Int, assoc: Int = -1, mode: MapMode = .simple) -> Int? {
    var posA = 0, posB = 0, i = 0
    while i < sections.count {
      let len = sections[i], ins = sections[i + 1]
      i += 2
      let endA = posA + len
      if ins < 0 {
        if endA > pos { return posB + (pos - posA) }
        posB += len
      } else {
        if mode != .simple && endA >= pos
          && ((mode == .trackDel && posA < pos && endA > pos) || (mode == .trackBefore && posA < pos)
            || (mode == .trackAfter && endA > pos))
        {
          return nil
        }
        if endA > pos || (endA == pos && assoc < 0 && len == 0) {
          return pos == posA || assoc < 0 ? posB : posB + ins
        }
        posB += ins
      }
      posA = endA
    }
    return posB
  }

  /// `mapPos` in simple mode (never nil).
  func map(_ pos: Int, assoc: Int = -1) -> Int { mapPos(pos, assoc: assoc)! }

  /// `touchesRange(from, to)`: false, true, or "cover" (`.cover`).
  func touchesRange(_ from: Int, _ to: Int) -> Bool {
    var pos = 0, i = 0
    while i < sections.count && pos <= to {
      let len = sections[i], ins = sections[i + 1]
      i += 2
      let end = pos + len
      if ins >= 0 && pos <= to && end >= from { return true }
      pos = end
    }
    return false
  }

  /// A change spec: replace `from..<to` (offsets in the start document) with `insert`.
  struct Spec {
    var from: Int
    var to: Int
    var insert: VimText

    init(from: Int, to: Int? = nil, insert: VimText = VimText()) {
      self.from = from
      self.to = to ?? from
      self.insert = insert
    }
  }

  /// `ChangeSet.of(specs, length)`: specs are in start-document offsets, in any order. Inserted
  /// text has its line breaks normalized ("\r\n" and "\r" become "\n", like CodeMirror's
  /// `DefaultSplit`).
  static func of(_ specs: [Spec], length: Int, normalizingLineBreaks: Bool = true) throws -> ChangeSet {
    var sections: [Int] = []
    var inserted: [VimText] = []
    var pos = 0
    var total: ChangeSet?
    func flush(_ force: Bool = false) {
      if !force && sections.isEmpty { return }
      if pos < length { addSection(&sections, length - pos, -1) }
      let set = ChangeSet(sections: sections, inserted: inserted)
      total = total.map { $0.compose(set.map($0)) } ?? set
      sections = []
      inserted = []
      pos = 0
    }
    for spec in specs {
      guard spec.from <= spec.to && spec.from >= 0 && spec.to <= length else {
        throw JSException.rangeError("Invalid change range \(spec.from) to \(spec.to) (in doc of length \(length))")
      }
      let text = normalizingLineBreaks ? normalizeLineBreaks(spec.insert) : spec.insert
      if spec.from == spec.to && text.isEmpty { continue }
      if spec.from < pos { flush() }
      if spec.from > pos { addSection(&sections, spec.from - pos, -1) }
      addSection(&sections, spec.to - spec.from, text.length)
      addInsert(&inserted, sections, text)
      pos = spec.to
    }
    flush(total == nil)
    return total!
  }

  /// "\r\n" and "\r" as "\n".
  static func normalizeLineBreaks(_ text: VimText) -> VimText {
    guard text.contains(unit: 0x0D) else { return text }
    var out: [UInt16] = []
    out.reserveCapacity(text.length)
    var i = 0
    let u = text.units
    while i < u.count {
      if u[i] == 0x0D {
        out.append(0x0A)
        if i + 1 < u.count && u[i + 1] == 0x0A { i += 1 }
      } else {
        out.append(u[i])
      }
      i += 1
    }
    return VimText(units: out)
  }
}

private func addSection(_ sections: inout [Int], _ len: Int, _ ins: Int, forceJoin: Bool = false) {
  if len == 0 && ins <= 0 { return }
  let last = sections.count - 2
  if last >= 0 && ins <= 0 && ins == sections[last + 1] {
    sections[last] += len
  } else if last >= 0 && len == 0 && sections[last] == 0 {
    sections[last + 1] += ins
  } else if forceJoin {
    sections[last] += len
    sections[last + 1] += ins
  } else {
    sections.append(len)
    sections.append(ins)
  }
}

private func addInsert(_ values: inout [VimText], _ sections: [Int], _ value: VimText) {
  if value.isEmpty { return }
  let index = (sections.count - 2) >> 1
  if index < values.count {
    values[values.count - 1] += value
  } else {
    while values.count < index { values.append(VimText()) }
    values.append(value)
  }
}

private struct SectionIter {
  let set: ChangeSet
  var i = 0
  var len = 0
  var ins = 0
  var off = 0

  init(_ set: ChangeSet) {
    self.set = set
    next()
  }

  mutating func next() {
    if i < set.sections.count {
      len = set.sections[i]
      ins = set.sections[i + 1]
      i += 2
    } else {
      len = 0
      ins = -2
    }
    off = 0
  }

  var done: Bool { ins == -2 }
  var len2: Int { ins < 0 ? len : ins }

  var text: VimText {
    let index = (i - 2) >> 1
    return index >= set.inserted.count ? VimText() : set.inserted[index]
  }

  func textBit(_ n: Int?) -> VimText {
    let index = (i - 2) >> 1
    if index >= set.inserted.count && (n == nil || n == 0) { return VimText() }
    let t = index < set.inserted.count ? set.inserted[index] : VimText()
    return t.slice(off, n.map { off + $0 })
  }

  mutating func forward(_ n: Int) {
    if n == len {
      next()
    } else {
      len -= n
      off += n
    }
  }

  mutating func forward2(_ n: Int) {
    if ins == -1 {
      forward(n)
    } else if n == ins {
      next()
    } else {
      ins -= n
      off += n
    }
  }
}

private func mapSet(_ setA: ChangeSet, _ setB: ChangeSet, before: Bool, mkSet: Bool) -> ChangeSet {
  var sections: [Int] = []
  var insert: [VimText] = []
  var a = SectionIter(setA), b = SectionIter(setB)
  var inserted = -1
  while true {
    if (a.done && b.len != 0) || (b.done && a.len != 0) {
      preconditionFailure("Mismatched change set lengths")
    } else if a.ins == -1 && b.ins == -1 {
      let len = min(a.len, b.len)
      addSection(&sections, len, -1)
      a.forward(len)
      b.forward(len)
    } else if b.ins >= 0 && (a.ins < 0 || inserted == a.i || (a.off == 0 && (b.len < a.len || (b.len == a.len && !before)))) {
      var len = b.len
      addSection(&sections, b.ins, -1)
      while len > 0 {
        let piece = min(a.len, len)
        if a.ins >= 0 && inserted < a.i && a.len <= piece {
          addSection(&sections, 0, a.ins)
          if mkSet { addInsert(&insert, sections, a.text) }
          inserted = a.i
        }
        a.forward(piece)
        len -= piece
      }
      b.next()
    } else if a.ins >= 0 {
      var len = 0
      var left = a.len
      while left > 0 {
        if b.ins == -1 {
          let piece = min(left, b.len)
          len += piece
          left -= piece
          b.forward(piece)
        } else if b.ins == 0 && b.len < left {
          left -= b.len
          b.next()
        } else {
          break
        }
      }
      addSection(&sections, len, inserted < a.i ? a.ins : 0)
      if mkSet && inserted < a.i { addInsert(&insert, sections, a.text) }
      inserted = a.i
      a.forward(a.len - left)
    } else if a.done && b.done {
      return ChangeSet(sections: sections, inserted: insert)
    } else {
      preconditionFailure("Mismatched change set lengths")
    }
  }
}

private func composeSets(_ setA: ChangeSet, _ setB: ChangeSet, mkSet: Bool) -> ChangeSet {
  var sections: [Int] = []
  var insert: [VimText] = []
  var a = SectionIter(setA), b = SectionIter(setB)
  var open = false
  while true {
    if a.done && b.done {
      return ChangeSet(sections: sections, inserted: insert)
    } else if a.ins == 0 {
      addSection(&sections, a.len, 0, forceJoin: open)
      a.next()
    } else if b.len == 0 && !b.done {
      addSection(&sections, 0, b.ins, forceJoin: open)
      if mkSet { addInsert(&insert, sections, b.text) }
      b.next()
    } else if a.done || b.done {
      preconditionFailure("Mismatched change set lengths")
    } else {
      let len = min(a.len2, b.len)
      let sectionLen = sections.count
      if a.ins == -1 {
        let insB = b.ins == -1 ? -1 : b.off != 0 ? 0 : b.ins
        addSection(&sections, len, insB, forceJoin: open)
        if mkSet && insB != 0 && insB != -1 { addInsert(&insert, sections, b.text) }
      } else if b.ins == -1 {
        addSection(&sections, a.off != 0 ? 0 : a.len, len, forceJoin: open)
        if mkSet { addInsert(&insert, sections, a.textBit(len)) }
      } else {
        addSection(&sections, a.off != 0 ? 0 : a.len, b.off != 0 ? 0 : b.ins, forceJoin: open)
        if mkSet && b.off == 0 { addInsert(&insert, sections, b.text) }
      }
      open = (a.ins > len || (b.ins >= 0 && b.len > len)) && (open || sections.count > sectionLen)
      a.forward2(len)
      b.forward(len)
    }
  }
}
