/// Parses JavaScript regular expression syntax (ES2025, with Annex B rules when the `u` flag is
/// off) into a `RegexNode` tree, rejecting what V8 rejects with V8's messages.
struct JSRegexParser {
  private let p: [UInt16]
  private let unicode: Bool
  private let pattern: VimText
  private let flags: String
  private var i = 0
  private var captureIndex = 0
  /// Every capture group of the pattern, scanned up front (like V8) so that `\N` and `\k<name>`
  /// can refer forward.
  private let totalCaptures: Int
  private let namedCaptures: [String: [Int]]
  private var activeNames = Set<String>()
  private var unresolvedNames: [String] = []

  private(set) var groupNames: [String: [Int]] = [:]
  private(set) var groupCount = 0

  init(pattern: VimText, flags: JSRegexFlags) {
    self.p = pattern.units
    self.pattern = pattern
    self.flags = flags.string
    self.unicode = flags.unicode
    let scan = Self.scanCaptures(pattern.units)
    totalCaptures = scan.count
    namedCaptures = scan.names
  }

  private func error(_ reason: String) -> JSRegexSyntaxError {
    JSRegexSyntaxError(reason: reason, pattern: pattern, flags: flags)
  }

  mutating func parse() throws(JSRegexSyntaxError) -> RegexNode {
    let node = try parseDisjunction()
    if i < p.count {
      // Only a ')' can stop a disjunction early.
      throw error("Unmatched ')'")
    }
    for name in unresolvedNames where groupNames[name] == nil {
      throw error("Invalid named capture referenced")
    }
    groupCount = captureIndex
    return node
  }

  // MARK: Structure

  private var atEnd: Bool { i >= p.count }

  private func peek(_ offset: Int = 0) -> UInt16? {
    i + offset < p.count ? p[i + offset] : nil
  }

  private func peekIs(_ c: Unicode.Scalar, _ offset: Int = 0) -> Bool {
    peek(offset) == UInt16(c.value)
  }

  private mutating func parseDisjunction() throws(JSRegexSyntaxError) -> RegexNode {
    let base = activeNames
    var alternatives: [RegexNode] = []
    var merged = base
    while true {
      activeNames = base
      alternatives.append(try parseAlternative())
      merged.formUnion(activeNames)
      if peekIs("|") {
        i += 1
        continue
      }
      break
    }
    activeNames = merged
    return alternatives.count == 1 ? alternatives[0] : .alternation(alternatives)
  }

  private mutating func parseAlternative() throws(JSRegexSyntaxError) -> RegexNode {
    var terms: [RegexNode] = []
    while let c = peek(), c != 0x7C, c != 0x29 {  // | )
      try parseTerm(into: &terms)
    }
    return terms.count == 1 ? terms[0] : terms.isEmpty ? .empty : .sequence(terms)
  }

  private mutating func parseTerm(into terms: inout [RegexNode]) throws(JSRegexSyntaxError) {
    let c = p[i]
    var atom: RegexNode
    var quantifiable = true
    switch c {
    case 0x5E:  // ^
      i += 1
      terms.append(.lineStart)
      return
    case 0x24:  // $
      i += 1
      terms.append(.lineEnd)
      return
    case 0x5C:  // backslash
      if peekIs("b", 1) || peekIs("B", 1) {
        terms.append(.wordBoundary(peekIs("b", 1)))
        i += 2
        return
      }
      if peekIs("c", 1), !unicode, !(peek(2).map(isASCIILetter) ?? false) {
        // Annex B: "\c" without a control letter is a literal backslash.
        i += 1
        atom = .char(0x5C)
      } else {
        atom = try parseAtomEscape()
      }
    case 0x28:  // (
      (atom, quantifiable) = try parseGroup()
    case 0x2E:  // .
      i += 1
      atom = .any
    case 0x5B:  // [
      atom = .set(try parseClass())
    case 0x2A, 0x2B, 0x3F:  // * + ?
      throw error("Nothing to repeat")
    case 0x7B:  // {
      let start = i
      if parseInterval() != nil { throw error("Nothing to repeat") }
      i = start
      if unicode { throw error("Lone quantifier brackets") }
      i += 1
      atom = .char(0x7B)
    case 0x7D, 0x5D:  // } ]
      if unicode { throw error("Lone quantifier brackets") }
      i += 1
      atom = .char(UInt32(c))
    default:
      atom = .char(readSourceCharacter())
    }
    terms.append(try parseQuantifier(atom, quantifiable: quantifiable))
  }

  /// One pattern character: a code point with the `u` flag, else a code unit.
  private mutating func readSourceCharacter() -> UInt32 {
    let c = p[i]
    i += 1
    if unicode, isHighSurrogate(c), let next = peek(), isLowSurrogate(next) {
      i += 1
      return 0x10000 + ((UInt32(c) - 0xD800) << 10) + (UInt32(next) - 0xDC00)
    }
    return UInt32(c)
  }

  private mutating func parseQuantifier(_ atom: RegexNode, quantifiable: Bool) throws(JSRegexSyntaxError) -> RegexNode {
    guard let c = peek() else { return atom }
    var min = 0
    var max: Int?
    switch c {
    case 0x2A:
      i += 1
    case 0x2B:
      min = 1
      i += 1
    case 0x3F:
      max = 1
      i += 1
    case 0x7B:
      let start = i
      if let (lo, hi) = parseInterval() {
        min = lo
        max = hi
        if let hi, hi < lo { throw error("numbers out of order in {} quantifier") }
      } else {
        i = start
        if unicode { throw error("Incomplete quantifier") }
        return atom
      }
    default:
      return atom
    }
    guard quantifiable else { throw error("Invalid quantifier") }
    var greedy = true
    if peekIs("?") {
      greedy = false
      i += 1
    }
    return .quantified(atom, min: min, max: max, greedy: greedy)
  }

  /// `{n}`, `{n,}` or `{n,m}` at `i` (consumed when valid). Large numbers saturate.
  private mutating func parseInterval() -> (Int, Int?)? {
    guard peekIs("{") else { return nil }
    var j = i + 1
    func number(_ j: inout Int) -> Int? {
      let start = j
      var value = 0
      while j < p.count, isASCIIDigit(p[j]) {
        value = value > Int(Int32.max) ? value : value * 10 + Int(p[j] - 0x30)
        j += 1
      }
      return j > start ? min(value, Int(Int32.max)) : nil
    }
    guard let lo = number(&j) else { return nil }
    var hi: Int? = lo
    if j < p.count, p[j] == 0x2C {
      j += 1
      hi = number(&j)
      if hi == nil { hi = Int?.none }
    }
    guard j < p.count, p[j] == 0x7D else { return nil }
    i = j + 1
    return (lo, hi)
  }

  private mutating func parseGroup() throws(JSRegexSyntaxError) -> (RegexNode, Bool) {
    i += 1  // (
    if peekIs("?") {
      guard let kind = peek(1) else { throw error("Invalid group") }
      switch kind {
      case 0x3A:  // (?:
        i += 2
        let body = try parseDisjunction()
        try expectCloseParen()
        return (.group(body, capture: nil), true)
      case 0x3D, 0x21:  // (?= (?!
        i += 2
        let body = try parseDisjunction()
        try expectCloseParen()
        return (.look(body, ahead: true, negated: kind == 0x21), !unicode)
      case 0x3C:  // (?<
        if peekIs("=", 2) || peekIs("!", 2) {
          let negated = peekIs("!", 2)
          i += 3
          let body = try parseDisjunction()
          try expectCloseParen()
          return (.look(body, ahead: false, negated: negated), false)
        }
        i += 2
        let name = try parseGroupName()
        if activeNames.contains(name) { throw error("Duplicate capture group name") }
        activeNames.insert(name)
        captureIndex += 1
        let index = captureIndex
        groupNames[name, default: []].append(index)
        let body = try parseDisjunction()
        try expectCloseParen()
        return (.group(body, capture: index), true)
      default:
        return (try parseModifierGroup(), true)
      }
    }
    captureIndex += 1
    let index = captureIndex
    let body = try parseDisjunction()
    try expectCloseParen()
    return (.group(body, capture: index), true)
  }

  private mutating func expectCloseParen() throws(JSRegexSyntaxError) {
    guard peekIs(")") else { throw error("Unterminated group") }
    i += 1
  }

  /// `(?ims-ims:...)` at `i` (pointing at "?").
  private mutating func parseModifierGroup() throws(JSRegexSyntaxError) -> RegexNode {
    var j = i + 1
    var add = ModifierFlags()
    var remove = ModifierFlags()
    var sawDash = false
    var seen = Set<UInt16>()
    while j < p.count {
      let c = p[j]
      if c == 0x2D {
        if sawDash { throw error("Multiple dashes in flag group") }
        sawDash = true
      } else if c == 0x69 || c == 0x6D || c == 0x73 {  // i m s
        if seen.contains(c) { throw error("Repeated flag in flag group") }
        seen.insert(c)
        switch (c, sawDash) {
        case (0x69, false): add.ignoreCase = true
        case (0x69, true): remove.ignoreCase = true
        case (0x6D, false): add.multiline = true
        case (0x6D, true): remove.multiline = true
        case (0x73, false): add.dotAll = true
        default: remove.dotAll = true
        }
      } else if c == 0x3A {
        break
      } else {
        throw error("Invalid group")
      }
      j += 1
    }
    guard j < p.count, p[j] == 0x3A else { throw error("Invalid group") }
    if add.isEmpty && remove.isEmpty && sawDash { throw error("Invalid flag group") }
    i = j + 1
    let body = try parseDisjunction()
    try expectCloseParen()
    return .modifiers(body, add: add, remove: remove)
  }

  /// A capture group name up to and including ">".
  private mutating func parseGroupName() throws(JSRegexSyntaxError) -> String {
    var scalars = String.UnicodeScalarView()
    var first = true
    while true {
      guard let c = peek() else { throw error("Invalid capture group name") }
      if c == 0x3E {  // >
        i += 1
        break
      }
      var value: UInt32
      if c == 0x5C {  // \u escape
        i += 1
        guard peekIs("u") else { throw error("Invalid capture group name") }
        i += 1
        guard let v = parseUnicodeEscapeBody(allowBraces: true) else { throw error("Invalid capture group name") }
        value = v
      } else {
        i += 1
        value = UInt32(c)
        if isHighSurrogate(c), let next = peek(), isLowSurrogate(next) {
          i += 1
          value = 0x10000 + ((UInt32(c) - 0xD800) << 10) + (UInt32(next) - 0xDC00)
        }
      }
      guard let scalar = Unicode.Scalar(value) else { throw error("Invalid capture group name") }
      let ok = value == 0x24 || value == 0x5F
        || (first ? scalar.properties.isIDStart : scalar.properties.isIDContinue || value == 0x200C || value == 0x200D)
      guard ok else { throw error("Invalid capture group name") }
      scalars.append(scalar)
      first = false
    }
    if scalars.isEmpty { throw error("Invalid capture group name") }
    return String(scalars)
  }

  // MARK: Escapes

  private mutating func parseAtomEscape() throws(JSRegexSyntaxError) -> RegexNode {
    i += 1  // backslash
    guard let c = peek() else { throw error("\\ at end of pattern") }
    switch c {
    case 0x64, 0x44: i += 1; return .set(RegexSet(items: [.digit(negated: c == 0x44)]))
    case 0x73, 0x53: i += 1; return .set(RegexSet(items: [.space(negated: c == 0x53)]))
    case 0x77, 0x57: i += 1; return .set(RegexSet(items: [.word(negated: c == 0x57)]))
    case 0x70 where unicode, 0x50 where unicode:
      i += 1
      return .set(RegexSet(items: [try parseProperty(negated: c == 0x50)]))
    case 0x31...0x39:
      let start = i
      var n = 0
      while let d = peek(), isASCIIDigit(d) {
        n = n > totalCaptures ? n : n * 10 + Int(d - 0x30)
        i += 1
      }
      if n <= totalCaptures { return .backref(n) }
      i = start
      if unicode { throw error("Invalid escape") }
      if c == 0x38 || c == 0x39 {
        i += 1
        return .char(UInt32(c))
      }
      return .char(parseOctal())
    case 0x30:
      i += 1
      if let d = peek(), isASCIIDigit(d) {
        if unicode { throw error("Invalid decimal escape") }
        i -= 1
        return .char(parseOctal())
      }
      return .char(0)
    case 0x6B:  // k
      if unicode || !namedCaptures.isEmpty {
        i += 1
        guard peekIs("<") else { throw error("Invalid named reference") }
        i += 1
        let name = try parseGroupName()
        unresolvedNames.append(name)
        return .namedBackref(name)
      }
      i += 1
      return .char(UInt32(c))
    default:
      return .char(try parseCharacterEscape(inClass: false))
    }
  }

  /// `\p{...}` after the "p" (u-mode only).
  private mutating func parseProperty(negated: Bool) throws(JSRegexSyntaxError) -> RegexSetItem {
    guard peekIs("{") else { throw error("Invalid property name") }
    var j = i + 1
    var name = ""
    while j < p.count, p[j] != 0x7D {
      let c = p[j]
      guard isASCIILetter(c) || isASCIIDigit(c) || c == 0x5F || c == 0x3D else { throw error("Invalid property name") }
      name.append(Character(Unicode.Scalar(UInt8(c))))
      j += 1
    }
    guard j < p.count, !name.isEmpty, JSUnicodeProperties.isSupported(name) else { throw error("Invalid property name") }
    i = j + 1
    return .property(name, negated: negated)
  }

  /// A CharacterEscape (after the backslash); `i` points at the escaped character.
  private mutating func parseCharacterEscape(inClass: Bool) throws(JSRegexSyntaxError) -> UInt32 {
    let c = p[i]
    switch c {
    case 0x66: i += 1; return 0x0C  // f
    case 0x6E: i += 1; return 0x0A  // n
    case 0x72: i += 1; return 0x0D  // r
    case 0x74: i += 1; return 0x09  // t
    case 0x76: i += 1; return 0x0B  // v
    case 0x63:  // c
      if let letter = peek(1), isASCIILetter(letter) {
        i += 2
        return UInt32(letter % 32)
      }
      if unicode { throw error("Invalid Unicode escape") }
      if inClass, let d = peek(1), isASCIIDigit(d) || d == 0x5F {
        i += 2
        return UInt32(d % 32)
      }
      // A literal backslash; "c" is read again as a pattern character.
      return 0x5C
    case 0x78:  // x
      if let h1 = peek(1).flatMap(hexValue), let h2 = peek(2).flatMap(hexValue) {
        i += 3
        return UInt32(h1 * 16 + h2)
      }
      if unicode { throw error("Invalid escape") }
      i += 1
      return 0x78
    case 0x75:  // u
      let start = i
      i += 1
      if let value = parseUnicodeEscapeBody(allowBraces: unicode) { return value }
      i = start
      if unicode { throw error("Invalid Unicode escape") }
      i += 1
      return 0x75
    default:
      if unicode {
        let syntax: Set<UInt16> = [0x5E, 0x24, 0x5C, 0x2E, 0x2A, 0x2B, 0x3F, 0x28, 0x29, 0x5B, 0x5D, 0x7B, 0x7D, 0x7C, 0x2F]
        if syntax.contains(c) || (inClass && c == 0x2D) {
          i += 1
          return UInt32(c)
        }
        throw error("Invalid escape")
      }
      return readSourceCharacter()
    }
  }

  /// The hex digits of `\uXXXX` / `\u{X...}` (after the "u"). With the `u` flag a surrogate pair
  /// of escapes combines into one code point.
  private mutating func parseUnicodeEscapeBody(allowBraces: Bool) -> UInt32? {
    if allowBraces, peekIs("{") {
      var j = i + 1
      var value: UInt32 = 0
      var digits = 0
      while j < p.count, let h = hexValue(p[j]) {
        value = value > 0x10FFFF ? value : value * 16 + UInt32(h)
        digits += 1
        j += 1
      }
      guard digits > 0, j < p.count, p[j] == 0x7D, value <= 0x10FFFF else { return nil }
      i = j + 1
      return value
    }
    guard let value = hex4(at: i) else { return nil }
    i += 4
    if unicode, isHighSurrogate(UInt16(value)), peekIs("\\"), peekIs("u", 1), let low = hex4(at: i + 2),
      isLowSurrogate(UInt16(low))
    {
      i += 6
      return 0x10000 + ((value - 0xD800) << 10) + (low - 0xDC00)
    }
    return value
  }

  private func hex4(at j: Int) -> UInt32? {
    guard j + 4 <= p.count else { return nil }
    var value: UInt32 = 0
    for k in j..<(j + 4) {
      guard let h = hexValue(p[k]) else { return nil }
      value = value * 16 + UInt32(h)
    }
    return value
  }

  /// A legacy octal escape (at most 0o377) starting at `i`.
  private mutating func parseOctal() -> UInt32 {
    var value = UInt32(p[i] - 0x30)
    i += 1
    if let d = peek(), d >= 0x30 && d <= 0x37 {
      value = value * 8 + UInt32(d - 0x30)
      i += 1
      if value < 32, let d2 = peek(), d2 >= 0x30 && d2 <= 0x37 {
        value = value * 8 + UInt32(d2 - 0x30)
        i += 1
      }
    }
    return value
  }

  // MARK: Character classes

  private mutating func parseClass() throws(JSRegexSyntaxError) -> RegexSet {
    i += 1  // [
    var set = RegexSet()
    if peekIs("^") {
      set.negated = true
      i += 1
    }
    while true {
      guard let c = peek() else { throw error("Unterminated character class") }
      if c == 0x5D {
        i += 1
        return set
      }
      let first = try parseClassAtom()
      if peekIs("-"), let after = peek(1), after != 0x5D {
        i += 1
        let second = try parseClassAtom()
        if first.isClassEscape || second.isClassEscape {
          if unicode { throw error("Invalid character class") }
          set.items.append(first)
          set.items.append(.char(0x2D))
          set.items.append(second)
          continue
        }
        guard case .char(let a) = first, case .char(let b) = second else { continue }
        if a > b { throw error("Range out of order in character class") }
        set.items.append(.range(a, b))
      } else {
        set.items.append(first)
      }
    }
  }

  private mutating func parseClassAtom() throws(JSRegexSyntaxError) -> RegexSetItem {
    let c = p[i]
    guard c == 0x5C else { return .char(readSourceCharacter()) }
    i += 1
    guard let e = peek() else { throw error("\\ at end of pattern") }
    switch e {
    case 0x62: i += 1; return .char(0x08)  // \b
    case 0x2D: i += 1; return .char(0x2D)  // \-
    case 0x64, 0x44: i += 1; return .digit(negated: e == 0x44)
    case 0x73, 0x53: i += 1; return .space(negated: e == 0x53)
    case 0x77, 0x57: i += 1; return .word(negated: e == 0x57)
    case 0x70 where unicode, 0x50 where unicode:
      i += 1
      return try parseProperty(negated: e == 0x50)
    case 0x30...0x39:
      if unicode {
        if e == 0x30, !(peek(1).map(isASCIIDigit) ?? false) {
          i += 1
          return .char(0)
        }
        throw error("Invalid decimal escape")
      }
      if e == 0x38 || e == 0x39 {
        i += 1
        return .char(UInt32(e))
      }
      return .char(parseOctal())
    case 0x6B where !unicode:  // \k is an identity escape in a class
      i += 1
      return .char(0x6B)
    default:
      let value = try parseCharacterEscape(inClass: true)
      if value == 0x5C, e == 0x63 { return .char(0x5C) }  // "\c" read as a backslash
      return .char(value)
    }
  }

  // MARK: Capture scan

  /// Counts capture groups and collects names, skipping escapes and character classes.
  private static func scanCaptures(_ p: [UInt16]) -> (count: Int, names: [String: [Int]]) {
    var count = 0
    var names: [String: [Int]] = [:]
    var i = 0
    var inClass = false
    while i < p.count {
      let c = p[i]
      if c == 0x5C {
        i += 2
        continue
      }
      if inClass {
        if c == 0x5D { inClass = false }
      } else if c == 0x5B {
        inClass = true
      } else if c == 0x28 {
        if i + 1 < p.count, p[i + 1] == 0x3F {
          if i + 2 < p.count, p[i + 2] == 0x3C, i + 3 < p.count, p[i + 3] != 0x3D, p[i + 3] != 0x21 {
            count += 1
            var j = i + 3
            var name = [UInt16]()
            while j < p.count, p[j] != 0x3E {
              name.append(p[j])
              j += 1
            }
            names[String(decoding: name, as: UTF16.self), default: []].append(count)
          }
        } else {
          count += 1
        }
      }
      i += 1
    }
    return (count, names)
  }
}

@inline(__always) private func isASCIILetter(_ u: UInt16) -> Bool {
  (u >= 0x41 && u <= 0x5A) || (u >= 0x61 && u <= 0x7A)
}

@inline(__always) private func hexValue(_ u: UInt16) -> Int? {
  switch u {
  case 0x30...0x39: Int(u - 0x30)
  case 0x41...0x46: Int(u - 0x41) + 10
  case 0x61...0x66: Int(u - 0x61) + 10
  default: nil
  }
}
