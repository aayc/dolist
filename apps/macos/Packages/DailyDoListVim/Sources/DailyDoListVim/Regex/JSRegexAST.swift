/// The flags of a JavaScript regular expression.
struct JSRegexFlags: Equatable, Sendable {
  var global = false
  var ignoreCase = false
  var multiline = false
  var dotAll = false
  var unicode = false
  var sticky = false
  var hasIndices = false

  /// Parses a flags string ("gimsuyd"); nil for an invalid or repeated flag.
  init?(_ text: String) {
    for ch in text {
      switch ch {
      case "g" where !global: global = true
      case "i" where !ignoreCase: ignoreCase = true
      case "m" where !multiline: multiline = true
      case "s" where !dotAll: dotAll = true
      case "u" where !unicode: unicode = true
      case "y" where !sticky: sticky = true
      case "d" where !hasIndices: hasIndices = true
      default: return nil
      }
    }
  }

  /// `RegExp.prototype.flags`: canonical order "dgimsuy".
  var string: String {
    (hasIndices ? "d" : "") + (global ? "g" : "") + (ignoreCase ? "i" : "") + (multiline ? "m" : "")
      + (dotAll ? "s" : "") + (unicode ? "u" : "") + (sticky ? "y" : "")
  }
}

/// A node of a parsed JavaScript regular expression.
indirect enum RegexNode {
  case empty
  /// A literal code point (a code unit without the `u` flag).
  case char(UInt32)
  /// `.`
  case any
  case set(RegexSet)
  /// `^`
  case lineStart
  /// `$`
  case lineEnd
  /// `\b` (true) or `\B` (false).
  case wordBoundary(Bool)
  /// A group; `capture` is the capture index (1-based) or nil for `(?:...)`.
  case group(RegexNode, capture: Int?)
  case look(RegexNode, ahead: Bool, negated: Bool)
  /// A numbered backreference.
  case backref(Int)
  /// `\k<name>` (resolved against the parsed group names when emitting).
  case namedBackref(String)
  case quantified(RegexNode, min: Int, max: Int?, greedy: Bool)
  case sequence([RegexNode])
  case alternation([RegexNode])
  /// `(?ims-ims:...)`
  case modifiers(RegexNode, add: ModifierFlags, remove: ModifierFlags)
}

struct ModifierFlags: Equatable {
  var ignoreCase = false
  var multiline = false
  var dotAll = false

  var isEmpty: Bool { !ignoreCase && !multiline && !dotAll }
}

/// A character class: `[...]` or a class escape.
struct RegexSet {
  var negated = false
  var items: [RegexSetItem] = []
}

enum RegexSetItem {
  case char(UInt32)
  case range(UInt32, UInt32)
  /// `\d` / `\D`
  case digit(negated: Bool)
  /// `\w` / `\W`
  case word(negated: Bool)
  /// `\s` / `\S`
  case space(negated: Bool)
  /// `\p{...}` / `\P{...}` (the raw property text between the braces).
  case property(String, negated: Bool)

  var isClassEscape: Bool {
    if case .char = self { return false }
    if case .range = self { return false }
    return true
  }
}

/// A `SyntaxError` of the JavaScript `RegExp` constructor, with V8's message.
struct JSRegexSyntaxError: Error, Equatable, Sendable {
  /// V8's reason, e.g. "Unterminated group".
  let reason: String
  let pattern: VimText
  let flags: String

  /// `e.message`: "Invalid regular expression: /(/: Unterminated group".
  var message: String {
    reason == "Invalid flags"
      ? "Invalid flags supplied to RegExp constructor '\(flags)'"
      : "Invalid regular expression: /\(pattern.string)/\(flags): \(reason)"
  }
}
