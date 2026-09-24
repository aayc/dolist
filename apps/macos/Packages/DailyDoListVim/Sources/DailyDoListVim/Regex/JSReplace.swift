/// JavaScript's `String.prototype.replace` / `replaceAll` with a regular expression.
enum JSReplace {
  /// `subject.replace(regexp, replacement)`: every match with the `g` flag, else the first; the
  /// replacement string understands `$$`, `$&`, `` $` ``, `$'`, `$n`, `$nn` and `$<name>`.
  static func replace(_ subject: VimText, _ regex: JSRegExp, with replacement: VimText) -> VimText {
    replace(subject, regex) { match in substitution(match, replacement) }
  }

  /// `subject.replace(regexp, fn)`.
  static func replace(_ subject: VimText, _ regex: JSRegExp, _ fn: (JSMatch) -> VimText) -> VimText
  {
    let prepared = JSSubject(subject)
    var out: [UInt16] = []
    var last = 0
    var from = 0
    while from <= subject.length, let match = regex.exec(prepared, from: from) {
      out.append(contentsOf: subject.units[last..<match.index])
      out.append(contentsOf: fn(match).units)
      last = match.end
      if !regex.flags.global { break }
      from = match.length == 0 ? advance(subject, match.end, regex.unicode) : match.end
    }
    out.append(contentsOf: subject.units[min(last, subject.length)...])
    return VimText(units: out)
  }

  /// AdvanceStringIndex: one code unit, or a whole surrogate pair with the `u` flag.
  static func advance(_ text: VimText, _ index: Int, _ unicode: Bool) -> Int {
    if unicode, index + 1 < text.length, isHighSurrogate(text[index]),
      isLowSurrogate(text[index + 1])
    {
      return index + 2
    }
    return index + 1
  }

  /// GetSubstitution of the ECMAScript spec.
  static func substitution(_ match: JSMatch, _ replacement: VimText) -> VimText {
    let r = replacement.units
    let groupCount = match.count - 1
    var out: [UInt16] = []
    var i = 0
    while i < r.count {
      let c = r[i]
      guard c == 0x24, i + 1 < r.count else {
        out.append(c)
        i += 1
        continue
      }
      let n = r[i + 1]
      switch n {
      case 0x24:  // $$
        out.append(0x24)
        i += 2
      case 0x26:  // $&
        out.append(contentsOf: match[0]?.units ?? [])
        i += 2
      case 0x60:  // $`
        out.append(contentsOf: match.subject.text.units[0..<match.index])
        i += 2
      case 0x27:  // $'
        out.append(contentsOf: match.subject.text.units[min(match.end, match.subject.length)...])
        i += 2
      case 0x30...0x39:
        let d1 = Int(n - 0x30)
        if i + 2 < r.count, isASCIIDigit(r[i + 2]) {
          let d2 = d1 * 10 + Int(r[i + 2] - 0x30)
          if d2 >= 1 && d2 <= groupCount {
            out.append(contentsOf: match[d2]?.units ?? [])
            i += 3
            continue
          }
        }
        if d1 >= 1 && d1 <= groupCount {
          out.append(contentsOf: match[d1]?.units ?? [])
          i += 2
        } else {
          out.append(c)
          i += 1
        }
      case 0x3C where match.hasNamedGroups:  // $<name>
        var j = i + 2
        while j < r.count, r[j] != 0x3E { j += 1 }
        if j < r.count {
          let name = String(decoding: r[(i + 2)..<j], as: UTF16.self)
          out.append(contentsOf: match.group(named: name)?.units ?? [])
          i = j + 1
        } else {
          out.append(c)
          i += 1
        }
      default:
        out.append(c)
        i += 1
      }
    }
    return VimText(units: out)
  }
}
