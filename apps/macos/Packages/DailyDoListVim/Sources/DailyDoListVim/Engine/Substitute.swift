// Ported from `exCommands.substitute` and `doReplace` of vim.js (@replit/codemirror-vim-core 0.1.0,
// MIT, © Marijn Haverbeke and others).

extension Vim {
  /// `exCommands.substitute(cm, params)`: `:[range]s/pattern/replacement/[flags] [count]`.
  func exSubstitute(_ cm: EditorAdapter, _ params: ExParams) throws {
    let argString = params.argString
    let tokens: [VimText]? = argString.flatMap { $0.isEmpty ? [] : splitBySeparator($0, $0[0]) } ?? []
    var regexPart = VimText()
    var replacePart: VimText?
    var trailing: [VimText]?
    var confirm = false  // Whether to confirm each replace.
    var global = false  // True to replace all instances on a line, false to replace only 1.
    if let tokens, !tokens.isEmpty {
      regexPart = tokens[0]
      if pcre && !regexPart.isEmpty {
        regexPart = try JSRegExp.make(regexPart).source  // normalize not escaped characters
      }
      replacePart = tokens.count > 1 ? tokens[1] : nil
      if let part = replacePart {
        let translated: VimText
        if pcre {
          translated = unescapeRegexReplace(JSReplace.replace(part, Self.ampersandRegex, with: "$1$$&"))
        } else {
          translated = translateRegexReplace(part)
        }
        replacePart = translated
        globalState.lastSubstituteReplacePart = translated
      }
      trailing = tokens.count > 2 && !tokens[2].isEmpty ? tokens[2].split(unit: 0x20) : []
    } else if let argString, !argString.isEmpty {
      // either the argString is empty or its of the form ' hello/world'; actually splitBySlash
      // returns a list of tokens only if the string starts with a '/'
      showConfirm(cm, "Substitutions should be of the form :s/pattern/replace/")
      return
    }
    // After the 3rd slash, we can have flags followed by a space followed by count.
    var count: Int?
    if let trailing {
      let flagsPart = trailing.first ?? VimText()
      let parsed = trailing.count > 1 ? JSNumber.parseInt(trailing[1]) : .nan
      if !parsed.isNaN && parsed != 0 { count = Int(max(min(parsed, 1e15), -1e15)) }
      if !flagsPart.isEmpty {
        if flagsPart.contains(unit: 0x63) { confirm = true }
        if flagsPart.contains(unit: 0x67) { global = true }
        if pcre {
          regexPart = regexPart + "/" + flagsPart
        } else {
          regexPart = VimText(units: regexPart.units.flatMap { $0 == 0x2F ? [0x5C, 0x2F] : [$0] }) + "/" + flagsPart
        }
      }
    }
    if !regexPart.isEmpty {
      // If regex part is empty, then use the previous query. Otherwise use the regex part as the
      // new query.
      do {
        try updateSearchQuery(cm, regexPart, true, true)
      } catch {
        showConfirm(cm, "Invalid regex: " + regexPart.string)
        return
      }
    }
    if replacePart == nil || replacePart!.isEmpty { replacePart = globalState.lastSubstituteReplacePart }
    guard let replaceWith = replacePart else {
      showConfirm(cm, "No previous substitute regular expression")
      return
    }
    guard let query = globalState.query else {
      throw JSException.typeError("Cannot read properties of undefined (reading 'source')")
    }
    var lineStart = params.line ?? cm.getCursor().line
    var lineEnd: Int = params.lineEnd.flatMap { $0 == 0 ? nil : $0 } ?? lineStart
    if lineStart == cm.firstLine() && lineEnd == cm.lastLine() { lineEnd = Int.max }
    if let count {
      lineStart = lineEnd
      lineEnd = lineStart == Int.max ? Int.max : lineStart + count - 1
    }
    let startPos = clipCursorToContent(cm, Pos(lineStart, 0))
    let cursor = cm.getSearchCursor(query, startPos)
    try doReplace(cm, confirm, global, lineStart, lineEnd, cursor, query, replaceWith, params.callback)
  }

  /// `/([^\\])&/g`: an `&` not preceded by a backslash.
  private static let ampersandRegex = try! JSRegExp("([^\\\\])&", flags: "g")

  /// `doReplace(cm, confirm, global, lineStart, lineEnd, searchCursor, query, replaceWith, callback)`.
  func doReplace(
    _ cm: EditorAdapter, _ confirm: Bool, _ global: Bool, _ lineStart: Int, _ lineEndIn: Int, _ searchCursor: SearchCursor,
    _ query: JSRegExp, _ replaceWith: VimText, _ callbackIn: (() throws -> Void)?
  ) throws {
    // Set up all the functions.
    maybeInitVimState(cm).exMode = true
    var done = false
    var matches = 0
    var lastPos: Pos?
    var modifiedLineNumber: Int?
    var joined = false
    var lineEnd = lineEndIn
    var callback = callbackIn

    func replace() throws {
      var newText = VimText()
      if let match = searchCursor.match {
        newText = substitutionText(replaceWith, match)
      } else if let from = searchCursor.from(), let to = searchCursor.to() {
        newText = JSReplace.replace(cm.getRange(from, to), query, with: replaceWith)
      }
      let unmodifiedLineNumber = searchCursor.to()?.line ?? 0
      try searchCursor.replace(newText)
      let modified = searchCursor.to()?.line ?? 0
      modifiedLineNumber = modified
      if lineEnd != Int.max { lineEnd += modified - unmodifiedLineNumber }
      joined = modified < unmodifiedLineNumber
    }

    func findNextValidMatch() throws -> JSMatch? {
      let lastMatchTo = lastPos != nil ? searchCursor.to() : nil
      var match = try searchCursor.findNext()
      if let m = match, (m[0]?.isEmpty ?? true), let lastMatchTo, searchCursor.from() == lastMatchTo {
        match = try searchCursor.findNext()
      }
      if match != nil { matches += 1 }
      return match
    }

    func next() throws {
      // The below only loops to skip over multiple occurrences on the same line when 'global'
      // is not true.
      while try findNextValidMatch() != nil, let from = searchCursor.from(),
        isInRange(from.line, lineStart, lineEnd == Int.max ? Int.max : lineEnd)
      {
        if !global && from.line == modifiedLineNumber && !joined { continue }
        cm.scrollIntoView(from)
        cm.setSelection(from, searchCursor.to() ?? from)
        lastPos = from
        done = false
        return
      }
      done = true
    }

    func stop(_ close: (() -> Void)? = nil) throws {
      close?()
      cm.focus()
      if let lastPos {
        cm.setCursor(lastPos)
        let vim = maybeInitVimState(cm)
        vim.exMode = false
        vim.lastHPos = lastPos.ch
        vim.lastHSPos = Double(lastPos.ch)
      }
      if let callback {
        try callback()
      } else if done {
        showConfirm(
          cm, (matches > 0 ? "Found \(matches) matches" : "No matches found") + " for pattern: " + query.description
            + (pcre ? " (set nopcre to use Vim regexps)" : ""))
      }
    }

    func replaceAll() throws {
      try cm.operation { () throws in
        while !done {
          try replace()
          try next()
        }
        try stop()
      }
    }

    // Actually do replace.
    try next()
    if done {
      showConfirm(cm, "No matches for " + query.description + (pcre ? " (set nopcre to use vim regexps)" : ""))
      return
    }
    if !confirm {
      try replaceAll()
      if let callback { try callback() }
      return
    }
    let options = PromptOptions(prefix: "replace with " + replaceWith.string + " (y/n/a/q/l)")
    options.onKeyDown = { [unowned self] e, _, close in
      // Swallow all keys.
      e.preventDefault()
      let closePrompt: () -> Void = { close(nil) }
      do {
        switch self.vimKeyFromEvent(e) {
        case "y":
          try replace()
          try next()
        case "n":
          try next()
        case "a":
          // replaceAll contains a call to close of its own. We don't want it to fire too early or
          // multiple times.
          let savedCallback = callback
          callback = nil
          try cm.operation { () throws in try replaceAll() }
          callback = savedCallback
        case "l":
          try replace()
          try stop(closePrompt)
        case "q", "<Esc>", "<C-c>", "<C-[>":
          try stop(closePrompt)
        default:
          break
        }
        if done { try stop(closePrompt) }
      } catch {
        cm.session?.report(error)
      }
      return true
    }
    showPrompt(cm, options)
  }

  /// The replacement of one match: `replaceWith.replace(/\$(\d{1,3}|[$&])/g, …)`, where `$0` is
  /// the whole match and a missing group reads "undefined" (JavaScript string concatenation).
  func substitutionText(_ replaceWith: VimText, _ match: JSMatch) -> VimText {
    let u = replaceWith.units
    var out: [UInt16] = []
    var i = 0
    while i < u.count {
      guard u[i] == 0x24, i + 1 < u.count else {
        out.append(u[i])
        i += 1
        continue
      }
      let n = u[i + 1]
      if n == 0x24 {
        out.append(0x24)
        i += 2
      } else if n == 0x26 {
        out.append(contentsOf: match[0]?.units ?? Array("undefined".utf16))
        i += 2
      } else if isASCIIDigit(n) {
        var end = i + 1
        while end < u.count && end < i + 4 && isASCIIDigit(u[end]) { end += 1 }
        let x = VimText(u[(i + 1)..<end])
        var x1 = x
        while !x1.isEmpty && JSNumber.parseInt(x1) >= Double(match.count) { x1 = x1.slice(0, x1.length - 1) }
        if !x1.isEmpty {
          // `match[x1]`: an array index only in canonical form ("1", not "01").
          let isCanonical = x1.length == 1 || x1[0] != 0x30
          let value = isCanonical ? match[Int(JSNumber.parseInt(x1))] : nil
          out.append(contentsOf: value?.units ?? Array("undefined".utf16))
          out.append(contentsOf: x.slice(x1.length).units)
        } else {
          out.append(contentsOf: u[i..<end])
        }
        i = end
      } else {
        out.append(u[i])
        i += 1
      }
    }
    return VimText(units: out)
  }
}
