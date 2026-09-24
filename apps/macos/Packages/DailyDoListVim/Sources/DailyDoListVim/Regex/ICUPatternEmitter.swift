/// Writes a parsed JavaScript regular expression as an ICU (`NSRegularExpression`) pattern with the
/// same meaning:
///
/// - every literal becomes `\x{…}`, so ICU-only syntax (`&&`, `--`, `[:alpha:]`, `#`) never
///   applies;
/// - `\d`, `\w`, `\s`, `\b` and `.` get their JavaScript definitions (ASCII word characters,
///   JavaScript whitespace, four line terminators), shielded from ICU's case closure;
/// - `^` and `$` become look-arounds, following the `m` flag in scope (so matching needs
///   transparent bounds and no anchoring bounds);
/// - named groups become plain groups (JavaScript names aren't restricted like ICU's).
struct ICUPatternEmitter {
  struct Scope {
    var ignoreCase: Bool
    var multiline: Bool
    var dotAll: Bool
  }

  let unicode: Bool
  let groupNames: [String: [Int]]
  /// Subtracted from capture numbers (for a sub-pattern compiled on its own).
  var groupOffset = 0

  func emit(_ node: RegexNode, _ scope: Scope) -> String {
    var out = ""
    write(node, scope, into: &out)
    return out
  }

  private static let lineTerminators = "\\x{A}\\x{D}\\x{2028}\\x{2029}"
  private static let anyCodePoint = "[\\x{0}-\\x{10FFFF}]"

  private func wordChars(_ scope: Scope) -> String {
    "\\x{30}-\\x{39}\\x{41}-\\x{5A}\\x{5F}\\x{61}-\\x{7A}"
      + (unicode && scope.ignoreCase ? "\\x{17F}\\x{212A}" : "")
  }

  private static let spaceChars =
    "\\x{9}-\\x{D}\\x{20}\\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}"

  private static func hasMultiCharCaseMapping(_ value: UInt32) -> Bool {
    guard let scalar = Unicode.Scalar(value) else { return false }
    let properties = scalar.properties
    return properties.uppercaseMapping.unicodeScalars.count > 1
      || properties.lowercaseMapping.unicodeScalars.count > 1
  }

  private static func hex(_ value: UInt32) -> String {
    "\\x{" + String(value, radix: 16, uppercase: true) + "}"
  }

  private func write(_ node: RegexNode, _ scope: Scope, into out: inout String) {
    switch node {
    case .empty:
      break
    case .char(let c):
      // ICU folds literals with full case folding ("ß" matches "SS"); inside a set it uses simple
      // folding, which is closer to JavaScript's canonicalization.
      out +=
        scope.ignoreCase && Self.hasMultiCharCaseMapping(c) ? "[" + Self.hex(c) + "]" : Self.hex(c)
    case .any:
      out += scope.dotAll ? Self.anyCodePoint : "[^" + Self.lineTerminators + "]"
    case .set(let set):
      writeSet(set, scope, into: &out)
    case .lineStart:
      out +=
        scope.multiline ? "(?<![^" + Self.lineTerminators + "])" : "(?<!" + Self.anyCodePoint + ")"
    case .lineEnd:
      out +=
        scope.multiline ? "(?![^" + Self.lineTerminators + "])" : "(?!" + Self.anyCodePoint + ")"
    case .wordBoundary(let isBoundary):
      let w = "[" + wordChars(scope) + "]"
      out +=
        isBoundary
        ? "(?-i:(?<=\(w))(?!\(w))|(?<!\(w))(?=\(w)))"
        : "(?-i:(?<=\(w))(?=\(w))|(?<!\(w))(?!\(w)))"
    case .group(let body, let capture):
      out += capture == nil ? "(?:" : "("
      write(body, scope, into: &out)
      out += ")"
    case .look(let body, let ahead, let negated):
      out += "(?" + (ahead ? "" : "<") + (negated ? "!" : "=")
      write(body, scope, into: &out)
      out += ")"
    case .backref(let index):
      out += "\\" + String(index - groupOffset)
    case .namedBackref(let name):
      // A reference to duplicate names (in different alternatives) matches whichever took part.
      let indices = groupNames[name] ?? []
      if indices.count == 1 {
        out += "\\" + String(indices[0] - groupOffset)
      } else {
        out += "(?:" + indices.map { "\\" + String($0 - groupOffset) }.joined(separator: "|") + ")"
      }
    case .quantified(let atom, let min, let max, let greedy):
      out += "(?:"
      write(atom, scope, into: &out)
      out += ")"
      switch (min, max) {
      case (0, nil): out += "*"
      case (1, nil): out += "+"
      case (0, 1?): out += "?"
      case (let lo, nil): out += "{\(lo),}"
      case (let lo, let hi?) where lo == hi: out += "{\(lo)}"
      case (let lo, let hi?): out += "{\(lo),\(hi)}"
      }
      if !greedy { out += "?" }
    case .sequence(let nodes):
      for node in nodes {
        if case .alternation = node {
          out += "(?:"
          write(node, scope, into: &out)
          out += ")"
        } else {
          write(node, scope, into: &out)
        }
      }
    case .alternation(let nodes):
      for (index, node) in nodes.enumerated() {
        if index > 0 { out += "|" }
        write(node, scope, into: &out)
      }
    case .modifiers(let body, let add, let remove):
      var inner = scope
      if add.ignoreCase { inner.ignoreCase = true }
      if remove.ignoreCase { inner.ignoreCase = false }
      if add.multiline { inner.multiline = true }
      if remove.multiline { inner.multiline = false }
      if add.dotAll { inner.dotAll = true }
      if remove.dotAll { inner.dotAll = false }
      out += inner.ignoreCase == scope.ignoreCase ? "(?:" : inner.ignoreCase ? "(?i:" : "(?-i:"
      write(body, inner, into: &out)
      out += ")"
    }
  }

  private func writeSet(_ set: RegexSet, _ scope: Scope, into out: inout String) {
    if set.items.isEmpty {
      out += set.negated ? Self.anyCodePoint : "(?!)"
      return
    }
    // A lone class escape is shielded from ICU's case closure (JavaScript's \w never matches the
    // long s or the Kelvin sign without the u flag).
    if set.items.count == 1, !set.negated {
      switch set.items[0] {
      case .word(let negated):
        out += "(?-i:[" + (negated ? "^" : "") + wordChars(scope) + "])"
        return
      case .digit(let negated):
        out += "[" + (negated ? "^" : "") + "\\x{30}-\\x{39}]"
        return
      case .space(let negated):
        out += "[" + (negated ? "^" : "") + Self.spaceChars + "]"
        return
      default:
        break
      }
    }
    out += set.negated ? "[^" : "["
    for item in set.items {
      switch item {
      case .char(let c):
        out += Self.hex(c)
      case .range(let a, let b):
        out += Self.hex(a) + "-" + Self.hex(b)
      case .digit(let negated):
        out += negated ? "[^\\x{30}-\\x{39}]" : "\\x{30}-\\x{39}"
      case .word(let negated):
        out += negated ? "[^" + wordChars(scope) + "]" : wordChars(scope)
      case .space(let negated):
        out += negated ? "[^" + Self.spaceChars + "]" : Self.spaceChars
      case .property(let name, let negated):
        out += (negated ? "\\P{" : "\\p{") + name + "}"
      }
    }
    out += "]"
  }

  // MARK: Look-behind bounds

  /// Whether `node` can match strings of unbounded length (ICU refuses such look-behinds).
  static func isUnbounded(_ node: RegexNode) -> Bool {
    switch node {
    case .empty, .char, .any, .set, .lineStart, .lineEnd, .wordBoundary, .look:
      return false
    case .backref, .namedBackref:
      return true
    case .group(let body, _), .modifiers(let body, _, _):
      return isUnbounded(body)
    case .quantified(let atom, _, let max, _):
      return max == nil ? !isZeroWidth(atom) : isUnbounded(atom)
    case .sequence(let nodes), .alternation(let nodes):
      return nodes.contains(where: isUnbounded)
    }
  }

  private static func isZeroWidth(_ node: RegexNode) -> Bool {
    switch node {
    case .empty, .lineStart, .lineEnd, .wordBoundary, .look: return true
    case .group(let body, _), .modifiers(let body, _, _): return isZeroWidth(body)
    case .sequence(let nodes): return nodes.allSatisfy(isZeroWidth)
    default: return false
    }
  }

  /// Whether a look-behind anywhere in `node` has an unbounded body.
  static func containsUnboundedLookbehind(_ node: RegexNode) -> Bool {
    switch node {
    case .look(let body, let ahead, _):
      return (!ahead && isUnbounded(body)) || containsUnboundedLookbehind(body)
    case .group(let body, _), .modifiers(let body, _, _), .quantified(let body, _, _, _):
      return containsUnboundedLookbehind(body)
    case .sequence(let nodes), .alternation(let nodes):
      return nodes.contains(where: containsUnboundedLookbehind)
    default:
      return false
    }
  }

  /// The number of capture groups inside `node`.
  static func captureCount(_ node: RegexNode) -> Int {
    switch node {
    case .group(let body, let capture): return (capture == nil ? 0 : 1) + captureCount(body)
    case .look(let body, _, _), .modifiers(let body, _, _), .quantified(let body, _, _, _):
      return captureCount(body)
    case .sequence(let nodes), .alternation(let nodes):
      return nodes.reduce(0) { $0 + captureCount($1) }
    default: return 0
    }
  }

  static func containsBackref(_ node: RegexNode) -> Bool {
    switch node {
    case .backref, .namedBackref: return true
    case .group(let body, _), .look(let body, _, _), .modifiers(let body, _, _),
      .quantified(let body, _, _, _):
      return containsBackref(body)
    case .sequence(let nodes), .alternation(let nodes):
      return nodes.contains(where: containsBackref)
    default: return false
    }
  }
}
