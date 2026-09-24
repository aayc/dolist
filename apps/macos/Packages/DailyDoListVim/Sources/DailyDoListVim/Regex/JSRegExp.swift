import Foundation

/// A JavaScript `RegExp`, compiled to `NSRegularExpression`.
///
/// Syntax and errors follow V8 (see `JSRegexParser`); matching follows JavaScript as far as ICU
/// allows (see `ICUPatternEmitter` and the package README for the few corners that differ).
/// Instances are immutable; callers pass the start index (`lastIndex`) explicitly.
final class JSRegExp: @unchecked Sendable, CustomStringConvertible {
  /// The pattern as given to the constructor.
  let pattern: VimText
  /// `RegExp.prototype.source`: the pattern with `/` and line terminators escaped.
  let source: VimText
  let flags: JSRegexFlags
  /// The number of capture groups.
  let groupCount: Int
  let groupNames: [String: [Int]]

  private let regex: NSRegularExpression
  private let emulation: LookbehindEmulation?

  /// `(?<=X)Y` / `(?<!X)Y` with an unbounded X, which ICU can't compile: Y is searched and X is
  /// tested to end where Y starts.
  private struct LookbehindEmulation {
    let behind: NSRegularExpression
    let negated: Bool
    let behindGroups: Int
  }

  /// `new RegExp(pattern, flags)`.
  init(_ pattern: VimText, flags flagText: String = "") throws(JSRegexSyntaxError) {
    guard let flags = JSRegexFlags(flagText) else {
      throw JSRegexSyntaxError(reason: "Invalid flags", pattern: pattern, flags: flagText)
    }
    self.pattern = pattern
    self.flags = flags
    self.source = JSRegExp.escapeSource(pattern)
    var parser = JSRegexParser(pattern: pattern, flags: flags)
    let tree = try parser.parse()
    groupCount = parser.groupCount
    groupNames = parser.groupNames
    let emitter = ICUPatternEmitter(unicode: flags.unicode, groupNames: parser.groupNames)
    let scope = ICUPatternEmitter.Scope(
      ignoreCase: flags.ignoreCase, multiline: flags.multiline, dotAll: flags.dotAll)
    let options: NSRegularExpression.Options = flags.ignoreCase ? [.caseInsensitive] : []

    if ICUPatternEmitter.containsUnboundedLookbehind(tree),
      let (behind, negated, rest) = Self.leadingLookbehind(tree),
      !ICUPatternEmitter.containsUnboundedLookbehind(behind),
      !ICUPatternEmitter.containsUnboundedLookbehind(rest),
      !ICUPatternEmitter.containsBackref(rest)
    {
      let behindGroups = ICUPatternEmitter.captureCount(behind)
      var restEmitter = emitter
      restEmitter.groupOffset = behindGroups
      let behindPattern = "(?:" + emitter.emit(behind, scope) + ")\\z"
      regex = try Self.compile(restEmitter.emit(rest, scope), options, pattern, flags)
      emulation = LookbehindEmulation(
        behind: try Self.compile(behindPattern, options, pattern, flags), negated: negated,
        behindGroups: behindGroups)
    } else {
      regex = try Self.compile(emitter.emit(tree, scope), options, pattern, flags)
      emulation = nil
    }
  }

  private static func compile(
    _ icu: String, _ options: NSRegularExpression.Options, _ pattern: VimText, _ flags: JSRegexFlags
  ) throws(JSRegexSyntaxError) -> NSRegularExpression {
    do {
      return try NSRegularExpression(pattern: icu.isEmpty ? "(?:)" : icu, options: options)
    } catch {
      // Valid JavaScript that ICU can't run (an unbounded look-behind that isn't leading).
      throw JSRegexSyntaxError(
        reason: "Unsupported by this engine", pattern: pattern, flags: flags.string)
    }
  }

  /// The leading look-behind of a top-level sequence and the rest of the sequence.
  private static func leadingLookbehind(_ tree: RegexNode) -> (RegexNode, Bool, RegexNode)? {
    guard case .sequence(let nodes) = tree, let first = nodes.first,
      case .look(let body, ahead: false, let negated) = first
    else {
      if case .look(let body, ahead: false, let negated) = tree { return (body, negated, .empty) }
      return nil
    }
    let rest = Array(nodes.dropFirst())
    return (body, negated, rest.count == 1 ? rest[0] : .sequence(rest))
  }

  var ignoreCase: Bool { flags.ignoreCase }
  var multiline: Bool { flags.multiline }
  var unicode: Bool { flags.unicode }

  /// `String(regexp)`: "/source/flags".
  var description: String { "/" + source.string + "/" + flags.string }

  var text: VimText { VimText(description) }

  /// Two regexps with the same source and flags (vim.js's `regexEqual`).
  func isEquivalent(to other: JSRegExp?) -> Bool {
    guard let other else { return false }
    return source == other.source && flags == other.flags
  }

  // MARK: Matching

  /// The first match starting at or after `from` (JavaScript's `exec` with `lastIndex = from`).
  func exec(_ subject: JSSubject, from: Int = 0) -> JSMatch? {
    guard from <= subject.length else { return nil }
    let options: NSRegularExpression.MatchingOptions = [
      .withTransparentBounds, .withoutAnchoringBounds,
    ]
    if let emulation {
      var q = from
      while q <= subject.length {
        guard
          let m = regex.firstMatch(
            in: subject.string, options: options,
            range: NSRange(location: q, length: subject.length - q))
        else { return nil }
        let start = m.range.location
        let behind = emulation.behind.firstMatch(
          in: subject.string, options: [.withTransparentBounds],
          range: NSRange(location: 0, length: start))
        if (behind != nil) != emulation.negated {
          var captures: [NSRange] = [m.range]
          for g in 0..<emulation.behindGroups {
            captures.append(
              behind.map { $0.range(at: g + 1) } ?? NSRange(location: NSNotFound, length: 0))
          }
          for g in 1..<m.numberOfRanges { captures.append(m.range(at: g)) }
          return JSMatch(subject: subject, ranges: captures, groupNames: groupNames)
        }
        q = start + 1
      }
      return nil
    }
    guard
      let m = regex.firstMatch(
        in: subject.string, options: options,
        range: NSRange(location: from, length: subject.length - from))
    else { return nil }
    return JSMatch(
      subject: subject, ranges: (0..<m.numberOfRanges).map { m.range(at: $0) },
      groupNames: groupNames)
  }

  /// A match starting exactly at `index` (the `y` flag), used by `split`.
  func execAnchored(_ subject: JSSubject, at index: Int) -> JSMatch? {
    guard index <= subject.length, emulation == nil else {
      if let m = exec(subject, from: index), m.index == index { return m }
      return nil
    }
    let options: NSRegularExpression.MatchingOptions = [
      .withTransparentBounds, .withoutAnchoringBounds, .anchored,
    ]
    guard
      let m = regex.firstMatch(
        in: subject.string, options: options,
        range: NSRange(location: index, length: subject.length - index))
    else { return nil }
    return JSMatch(
      subject: subject, ranges: (0..<m.numberOfRanges).map { m.range(at: $0) },
      groupNames: groupNames)
  }

  /// The first match in `text` (`text.match(regexp)` without the `g` flag).
  func firstMatch(in text: VimText, from: Int = 0) -> JSMatch? {
    exec(JSSubject(text), from: from)
  }

  /// `regexp.test(text)` (from index 0).
  func test(_ text: VimText) -> Bool {
    exec(JSSubject(text), from: 0) != nil
  }

  // MARK: Source escaping

  /// V8's EscapeRegExpSource: "(?:)" for an empty pattern; `/` outside character classes and line
  /// terminators are escaped.
  static func escapeSource(_ pattern: VimText) -> VimText {
    if pattern.isEmpty { return "(?:)" }
    var out: [UInt16] = []
    out.reserveCapacity(pattern.length)
    var inClass = false
    var i = 0
    let p = pattern.units
    while i < p.count {
      let c = p[i]
      if c == 0x5C, i + 1 < p.count {
        let next = p[i + 1]
        if isJSLineTerminator(next) {
          // The backslash is dropped: the line terminator gets escaped on its own.
          i += 1
        } else {
          out.append(c)
          out.append(next)
          i += 2
        }
        continue
      }
      if c == 0x2F, !inClass {
        out.append(0x5C)
        out.append(c)
      } else if isJSLineTerminator(c) {
        out.append(contentsOf: lineTerminatorEscape(c))
      } else {
        if c == 0x5B { inClass = true } else if c == 0x5D { inClass = false }
        out.append(c)
      }
      i += 1
    }
    return VimText(units: out)
  }

  private static func lineTerminatorEscape(_ c: UInt16) -> [UInt16] {
    switch c {
    case 0x0A: Array("\\n".utf16)
    case 0x0D: Array("\\r".utf16)
    case 0x2028: Array("\\u2028".utf16)
    default: Array("\\u2029".utf16)
    }
  }
}

/// A subject string prepared for matching (the `NSString` is created once).
struct JSSubject {
  let text: VimText
  let string: String

  init(_ text: VimText) {
    self.text = text
    self.string = text.nsString as String
  }

  var length: Int { text.length }
}

/// The result of `exec`: the match and its captures (nil when a group didn't take part).
struct JSMatch {
  let subject: JSSubject
  let ranges: [NSRange]
  let groupNames: [String: [Int]]

  /// `match.index`.
  var index: Int { ranges[0].location }
  var length: Int { ranges[0].length }
  var end: Int { index + length }

  /// The number of entries of the match array (`match.length`: 1 + groups).
  var count: Int { ranges.count }

  /// `match[i]`: nil for a group that didn't participate.
  subscript(i: Int) -> VimText? {
    guard i < ranges.count, ranges[i].location != NSNotFound else { return nil }
    return subject.text.slice(ranges[i].location, ranges[i].location + ranges[i].length)
  }

  /// `match.groups[name]`.
  func group(named name: String) -> VimText? {
    for index in groupNames[name] ?? [] {
      if let value = self[index] { return value }
    }
    return nil
  }

  var hasNamedGroups: Bool { !groupNames.isEmpty }
}

/// The `\p{…}` names V8 accepts (General_Category and Script values are checked loosely).
enum JSUnicodeProperties {
  static func isSupported(_ name: String) -> Bool {
    if let eq = name.firstIndex(of: "=") {
      let key = name[..<eq]
      let value = name[name.index(after: eq)...]
      guard !value.isEmpty else { return false }
      switch key {
      case "General_Category", "gc": return generalCategories.contains(String(value))
      case "Script", "sc", "Script_Extensions", "scx":
        return value.allSatisfy { $0.isLetter || $0 == "_" }
      default: return false
      }
    }
    return generalCategories.contains(name) || binary.contains(name)
  }

  static let generalCategories: Set<String> = [
    "L", "Letter", "LC", "Cased_Letter", "Lu", "Uppercase_Letter", "Ll", "Lowercase_Letter", "Lt",
    "Titlecase_Letter", "Lm", "Modifier_Letter", "Lo", "Other_Letter", "M", "Mark",
    "Combining_Mark", "Mn",
    "Nonspacing_Mark", "Mc", "Spacing_Mark", "Me", "Enclosing_Mark", "N", "Number", "Nd",
    "Decimal_Number",
    "digit", "Nl", "Letter_Number", "No", "Other_Number", "P", "Punctuation", "punct", "Pc",
    "Connector_Punctuation", "Pd", "Dash_Punctuation", "Ps", "Open_Punctuation", "Pe",
    "Close_Punctuation", "Pi",
    "Initial_Punctuation", "Pf", "Final_Punctuation", "Po", "Other_Punctuation", "S", "Symbol",
    "Sm",
    "Math_Symbol", "Sc", "Currency_Symbol", "Sk", "Modifier_Symbol", "So", "Other_Symbol", "Z",
    "Separator",
    "Zs", "Space_Separator", "Zl", "Line_Separator", "Zp", "Paragraph_Separator", "C", "Other",
    "Cc", "Control",
    "cntrl", "Cf", "Format", "Cs", "Surrogate", "Co", "Private_Use", "Cn", "Unassigned",
  ]

  static let binary: Set<String> = [
    "ASCII", "ASCII_Hex_Digit", "AHex", "Alphabetic", "Alpha", "Any", "Assigned", "Bidi_Control",
    "Bidi_C",
    "Bidi_Mirrored", "Bidi_M", "Case_Ignorable", "CI", "Cased", "Changes_When_Casefolded", "CWCF",
    "Changes_When_Casemapped", "CWCM", "Changes_When_Lowercased", "CWL",
    "Changes_When_NFKC_Casefolded", "CWKCF",
    "Changes_When_Titlecased", "CWT", "Changes_When_Uppercased", "CWU", "Dash",
    "Default_Ignorable_Code_Point",
    "DI", "Deprecated", "Dep", "Diacritic", "Dia", "Emoji", "Emoji_Component", "EComp",
    "Emoji_Modifier", "EMod",
    "Emoji_Modifier_Base", "EBase", "Emoji_Presentation", "EPres", "Extended_Pictographic",
    "ExtPict", "Extender",
    "Ext", "Grapheme_Base", "Gr_Base", "Grapheme_Extend", "Gr_Ext", "Hex_Digit", "Hex",
    "IDS_Binary_Operator",
    "IDSB", "IDS_Trinary_Operator", "IDST", "ID_Continue", "IDC", "ID_Start", "IDS", "Ideographic",
    "Ideo",
    "Join_Control", "Join_C", "Logical_Order_Exception", "LOE", "Lowercase", "Lower", "Math",
    "Noncharacter_Code_Point", "NChar", "Pattern_Syntax", "Pat_Syn", "Pattern_White_Space",
    "Pat_WS",
    "Quotation_Mark", "QMark", "Radical", "Regional_Indicator", "RI", "Sentence_Terminal", "STerm",
    "Soft_Dotted",
    "SD", "Terminal_Punctuation", "Term", "Unified_Ideograph", "UIdeo", "Uppercase", "Upper",
    "Variation_Selector",
    "VS", "White_Space", "space", "XID_Continue", "XIDC", "XID_Start", "XIDS",
  ]
}
