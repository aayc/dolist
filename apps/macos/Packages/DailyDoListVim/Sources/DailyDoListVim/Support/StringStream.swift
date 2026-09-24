// Ported from `StringStream` of @codemirror/language 6.12.4 (MIT, © Marijn Haverbeke and others),
// which vim.js uses (as `CodeMirror.StringStream`) to parse ex commands.

/// A cursor over one line of text, CodeMirror's tokenizer stream.
struct StringStream {
  var string: VimText
  var pos = 0
  var start = 0

  init(_ string: VimText) {
    self.string = string
  }

  func eol() -> Bool { pos >= string.length }

  func sol() -> Bool { pos == 0 }

  /// The next code unit, nil at the end. (vim.js can back the position up to -1.)
  func peek() -> VimText? { string.code(at: pos) != nil ? string.charAt(pos) : nil }

  /// `next()`: JavaScript's `charAt(pos++)` while `pos < length`.
  mutating func next() -> VimText? {
    guard pos < string.length else { return nil }
    defer { pos += 1 }
    return string.charAt(pos)
  }

  /// Consumes the next code unit if it equals `ch`.
  @discardableResult
  mutating func eat(_ ch: String) -> VimText? {
    guard string.code(at: pos) != nil else { return nil }
    let c = string.charAt(pos)
    guard c == ch else { return nil }
    pos += 1
    return c
  }

  /// Consumes the next code unit if it satisfies `test`.
  @discardableResult
  mutating func eat(where test: (UInt16) -> Bool) -> VimText? {
    guard let c = string.code(at: pos), test(c) else { return nil }
    pos += 1
    return string.charAt(pos - 1)
  }

  @discardableResult
  mutating func eatWhile(_ ch: String) -> Bool {
    let from = pos
    while eat(ch) != nil {}
    return pos > from
  }

  /// `eatSpace()`: consumes `/[\s\u00a0]/`.
  @discardableResult
  mutating func eatSpace() -> Bool {
    let from = pos
    while let c = string.code(at: pos), isJSWhitespace(c) { pos += 1 }
    return pos > from
  }

  mutating func skipToEnd() { pos = string.length }

  mutating func backUp(_ n: Int) { pos -= n }

  /// `match(string, consume, caseInsensitive)`.
  @discardableResult
  mutating func match(_ pattern: String, consume: Bool = true, caseInsensitive: Bool = false)
    -> Bool
  {
    let p = VimText(pattern)
    var sub = string.substr(pos, p.length)
    var target = p
    if caseInsensitive {
      sub = sub.toLowerCase()
      target = p.toLowerCase()
    }
    guard sub == target else { return false }
    if consume { pos += p.length }
    return true
  }

  /// `match(regexp, consume)`: the regexp must match at the current position.
  @discardableResult
  mutating func match(_ regex: JSRegExp, consume: Bool = true) -> JSMatch? {
    let rest = string.slice(pos)
    guard let m = regex.firstMatch(in: rest), m.index == 0 else { return nil }
    if consume { pos += m.length }
    return m
  }

  /// Consumes and returns the rest of the line (`match(/.*/)[0]`, which stops at a line
  /// terminator).
  mutating func matchRestOfLine() -> VimText {
    let rest = string.slice(pos)
    let end = rest.units.firstIndex(where: isJSLineTerminator) ?? rest.length
    pos += end
    return rest.slice(0, end)
  }
}
