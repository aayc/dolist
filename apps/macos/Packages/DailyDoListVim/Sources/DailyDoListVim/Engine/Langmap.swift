// Ported from `parseLangmap` / `updateLangmap` of vim.js (@replit/codemirror-vim-core 0.1.0, MIT,
// © Marijn Haverbeke and others): the 'langmap' option, which maps keys of another keyboard
// layout to the Latin ones in normal and visual mode.

struct Langmap {
  var keymap: [VimText: VimText]
  var string: VimText
  var remapCtrl: Bool?
}

extension Vim {
  func updateLangmap(_ langmapString: VimText, remapCtrl: Bool? = nil) {
    if langmap.string != langmapString { langmap = parseLangmap(langmapString) }
    langmap.remapCtrl = remapCtrl
  }

  private static let partSplitter = try! JSRegExp("((?:[^\\\\,]|\\\\.)+),")
  private static let semicolonSplitter = try! JSRegExp("((?:[^\\\\;]|\\\\.)+);")
  private static let escapeSplitter = try! JSRegExp("\\\\?(.)")

  /// `parseLangmap(langmapString)`: "aA,bB" pairs and "abc;ABC" lists; backslash escapes.
  func parseLangmap(_ langmapString: VimText) -> Langmap {
    var keymap: [VimText: VimText] = [:]
    if langmapString.isEmpty { return Langmap(keymap: keymap, string: VimText()) }
    func getEscaped(_ list: VimText) -> [VimText] {
      JSSplit.split(list, Self.escapeSplitter).compactMap { $0 }.filter { !$0.isEmpty }
    }
    for case let part? in JSSplit.split(langmapString, Self.partSplitter) where !part.isEmpty {
      let semicolon = JSSplit.split(part, Self.semicolonSplitter)
      if semicolon.count == 3 {
        let from = getEscaped(semicolon[1] ?? VimText())
        let to = getEscaped(semicolon[2] ?? VimText())
        if from.count != to.count { continue }  // skip over malformed part
        for (f, t) in zip(from, to) { keymap[f] = t }
      } else if semicolon.count == 1 {
        let pairs = getEscaped(part)
        if pairs.count % 2 != 0 { continue }  // skip over malformed part
        var i = 0
        while i < pairs.count {
          keymap[pairs[i]] = pairs[i + 1]
          i += 2
        }
      }
    }
    return Langmap(keymap: keymap, string: langmapString)
  }
}

/// `String.prototype.split(regexp)`: the pieces between matches plus the captured groups (nil
/// for groups that didn't take part).
enum JSSplit {
  static func split(_ s: VimText, _ regex: JSRegExp) -> [VimText?] {
    let subject = JSSubject(s)
    let size = s.length
    if size == 0 { return regex.execAnchored(subject, at: 0) != nil ? [] : [s] }
    var out: [VimText?] = []
    var p = 0
    var q = 0
    while q < size {
      guard let z = regex.execAnchored(subject, at: q) else {
        q = JSReplace.advance(s, q, regex.unicode)
        continue
      }
      let e = min(z.end, size)
      if e == p {
        q = JSReplace.advance(s, q, regex.unicode)
        continue
      }
      out.append(s.slice(p, q))
      for i in 1..<max(1, z.count) { out.append(z[i]) }
      p = e
      q = p
    }
    out.append(s.slice(p, size))
    return out
  }
}
