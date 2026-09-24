// Ported from the search functions of vim.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn
// Haverbeke and others): `translateRegex`, `translateRegexReplace`, `unescapeRegexReplace`,
// `splitBySeparator`, `findUnescapedSeparators`, `parseQuery`, `updateSearchQuery`,
// `highlightSearchMatches`, `findNext`, `findNextFromAndToInclusive`, `clearSearchHighlight`,
// `commandDispatcher.processSearch` and `motions.findAndSelectNextInclusive`.

extension Vim {
  func getSearchState(_ cm: EditorAdapter) -> SearchState {
    let vim = maybeInitVimState(cm)
    if let state = vim.searchState { return state }
    let state = SearchState()
    vim.searchState = state
    return state
  }

  // MARK: Separators

  /// `findUnescapedSeparators(str, separator)`.
  func findUnescapedSeparators(_ str: VimText, _ separator: UInt16 = 0x2F) -> [Int] {
    var escapeNextChar = false
    var slashes: [Int] = []
    for (i, c) in str.units.enumerated() {
      if !escapeNextChar && c == separator { slashes.append(i) }
      escapeNextChar = !escapeNextChar && c == 0x5C
    }
    return slashes
  }

  /// `splitBySeparator(argString, separator)`: nil when the string doesn't start with it.
  func splitBySeparator(_ argString: VimText, _ separator: UInt16) -> [VimText]? {
    let slashes = findUnescapedSeparators(argString, separator)
    if slashes.isEmpty { return [] }
    // in case of strings like foo/bar
    if slashes[0] != 0 { return nil }
    var tokens: [VimText] = []
    for (i, slash) in slashes.enumerated() {
      tokens.append(argString.substring(slash + 1, i + 1 < slashes.count ? slashes[i + 1] : nil))
    }
    return tokens
  }

  // MARK: Translation

  /// `translateRegex(str)`: a vim pattern (magic by default, `\v` `\m` `\M` `\V` switch) as a
  /// JavaScript pattern.
  func translateRegex(_ str: VimText) -> VimText {
    // When these match, add a '\' if unescaped or remove one if escaped.
    let modes: [UInt16: String] = [
      0x56: "|(){+?*.[$^", 0x4D: "|(){+?*.[", 0x6D: "|(){+?", 0x76: "<>",
    ]
    let escapes: [UInt16: String] = [
      0x3E: "(?<=[\\w])(?=[^\\w]|$)", 0x3C: "(?<=[^\\w]|^)(?=[\\w])",
    ]
    var specials = Set(modes[0x6D]!.utf16)
    let candidates = Set("[|(){+*?.$^<>".utf16)
    let u = str.units
    var out: [UInt16] = []
    var i = 0
    while i < u.count {
      let c = u[i]
      if c == 0x5C, i + 1 < u.count, !isJSLineTerminator(u[i + 1]) {
        let next = u[i + 1]
        i += 2
        if next == 0x7D || specials.contains(next) {
          out.append(next)
        } else if let mode = modes[next] {
          specials = Set(mode.utf16)
        } else if let escape = escapes[next] {
          out.append(contentsOf: escape.utf16)
        } else {
          out.append(c)
          out.append(next)
        }
        continue
      }
      if candidates.contains(c), specials.contains(c) {
        if let escape = escapes[c] {
          out.append(contentsOf: escape.utf16)
        } else {
          out.append(0x5C)
          out.append(c)
        }
      } else {
        out.append(c)
      }
      i += 1
    }
    var regex = VimText(units: out)
    let zs = regex.indexOf("\\zs")
    if zs != -1 { regex = VimText("(?<=") + regex.slice(0, zs) + ")" + regex.slice(zs + 3) }
    let ze = regex.indexOf("\\ze")
    if ze != -1 { regex = regex.slice(0, ze) + "(?=" + regex.slice(ze + 3) + ")" }
    return regex
  }

  /// `translateRegexReplace(str)`: a vim replacement (`\1`, `&`) as a JavaScript one (`$1`,
  /// `$&`).
  func translateRegexReplace(_ str: VimText) -> VimText {
    var escapeNextChar = false
    var out: [UInt16] = []
    var i = -1
    while i < str.length {
      let c = str.charAt(i)
      let n = str.charAt(i + 1)
      let pair = c + n
      if pair == "\\n" || pair == "\\r" || pair == "\\t" {
        out.append(pair == "\\n" ? 0x0A : pair == "\\r" ? 0x0D : 0x09)
        i += 1
      } else if escapeNextChar {
        // At any point in the loop, escapeNextChar is true if the previous character was a '\'
        // and was not escaped.
        out.append(contentsOf: c.units)
        escapeNextChar = false
      } else {
        if c == "\\" {
          escapeNextChar = true
          if n.containsDigit || n == "$" {
            out.append(0x24)
          } else if n != "/" && n != "\\" {
            out.append(0x5C)
          }
        } else {
          if c == "$" { out.append(0x24) }
          out.append(contentsOf: c.units)
          if n == "/" { out.append(0x5C) }
        }
      }
      i += 1
    }
    return VimText(units: out)
  }

  /// `unescapeRegexReplace(str)`: unescapes `\/`, `\\`, `\n`, `\r`, `\t`, `\&` (pcre mode).
  func unescapeRegexReplace(_ str: VimText) -> VimText {
    var stream = StringStream(str)
    var output: [UInt16] = []
    let unescapes: [(String, UInt16)] = [
      ("\\/", 0x2F), ("\\\\", 0x5C), ("\\n", 0x0A), ("\\r", 0x0D), ("\\t", 0x09), ("\\&", 0x26),
    ]
    while !stream.eol() {
      // Search for \.
      while let c = stream.peek(), c != "\\" { output.append(contentsOf: stream.next()!.units) }
      var matched = false
      for (matcher, value) in unescapes where stream.match(matcher) {
        matched = true
        output.append(value)
        break
      }
      if !matched, let next = stream.next() { output.append(contentsOf: next.units) }
    }
    return VimText(units: output)
  }

  // MARK: Queries

  /// `parseQuery(query, ignoreCase, smartCase)`: the regexp of a search (`/foo/i` flags allowed),
  /// nil when blank. Throws for an invalid pattern.
  func parseQuery(_ query: VimText, _ ignoreCaseIn: Bool, _ smartCase: Bool) throws -> JSRegExp? {
    // First update the last search register
    globalState.registerController.getRegister("/").setText(query)
    let slashes = findUnescapedSlashes(query)
    var regexPart: VimText
    var forceIgnoreCase = false
    if slashes.isEmpty {
      regexPart = query
    } else {
      regexPart = query.substring(0, slashes[0])
      forceIgnoreCase = query.substring(slashes[0]).contains(unit: 0x69)
    }
    if regexPart.isEmpty { return nil }
    if !pcre { regexPart = translateRegex(regexPart) }
    var ignoreCase = ignoreCaseIn
    if smartCase { ignoreCase = !regexPart.units.contains { $0 >= 0x41 && $0 <= 0x5A } }
    return try JSRegExp.make(regexPart, ignoreCase || forceIgnoreCase ? "im" : "m")
  }

  func findUnescapedSlashes(_ str: VimText) -> [Int] { findUnescapedSeparators(str, 0x2F) }

  /// `updateSearchQuery(cm, rawQuery, ignoreCase, smartCase)`.
  @discardableResult
  func updateSearchQuery(
    _ cm: EditorAdapter, _ rawQuery: VimText, _ ignoreCase: Bool = false, _ smartCase: Bool = false
  ) throws -> JSRegExp? {
    if rawQuery.isEmpty { return nil }
    let state = getSearchState(cm)
    _ = state
    guard let query = try parseQuery(rawQuery, ignoreCase, smartCase) else { return nil }
    highlightSearchMatches(cm, query)
    if query.isEquivalent(to: globalState.query) { return query }
    globalState.query = query
    return query
  }

  /// `highlightSearchMatches(cm, query)`: highlights after 50 ms.
  func highlightSearchMatches(_ cm: EditorAdapter, _ query: JSRegExp) {
    highlightTimeout?.cancel()
    let searchState = getSearchState(cm)
    // vim.js stores the timer it just cleared here, not the new one.
    searchState.highlightTimeout = highlightTimeout
    highlightTimeout = scheduler.schedule(after: 0.05) { [weak cm, unowned self] in
      guard let cm, cm.vim != nil else { return }
      let searchState = self.getSearchState(cm)
      searchState.highlightTimeout = nil
      if !searchState.hasOverlay || searchState.overlay !== query {
        if searchState.hasOverlay { cm.removeOverlay() }
        cm.addOverlay(query)
        searchState.overlay = query
        searchState.hasOverlay = true
      }
    }
  }

  /// `clearSearchHighlight(cm)`.
  func clearSearchHighlight(_ cm: EditorAdapter) {
    let state = getSearchState(cm)
    if let timer = state.highlightTimeout {
      timer.cancel()
      state.highlightTimeout = nil
    }
    cm.removeOverlay()
    state.overlay = nil
    state.hasOverlay = false
  }

  /// `findNext(cm, prev, query, repeat)`: the start of the `repeat`th match after (or before) the
  /// cursor, wrapping around the document.
  func findNext(_ cm: EditorAdapter, _ prev: Bool, _ query: JSRegExp, _ repeatIn: Int? = nil) throws
    -> Pos?
  {
    try cm.operation { () throws -> Pos? in
      let count = repeatIn ?? 1
      let pos = cm.getCursor()
      var cursor = cm.getSearchCursor(query, pos)
      for i in 0..<max(0, count) {
        var found = try cursor.find(prev)
        if i == 0, found != nil, cursor.from() == pos {
          let lastEndPos = prev ? cursor.from()! : cursor.to()!
          found = try cursor.find(prev)
          if let f = found, f[0]?.isEmpty ?? true, cursor.from() == lastEndPos {
            if cm.getLine(lastEndPos.line).length == lastEndPos.ch { found = try cursor.find(prev) }
          }
        }
        if found == nil {
          // SearchCursor may have returned null because it hit EOF, wrap around and try again.
          cursor = cm.getSearchCursor(
            query, prev ? Pos(cm.lastLine(), Pos.endOfLine) : Pos(cm.firstLine(), 0))
          if try cursor.find(prev) == nil { return nil }
        }
      }
      return cursor.from()
    }
  }

  /// `findNextFromAndToInclusive(cm, prev, query, repeat, vim)`.
  func findNextFromAndToInclusive(
    _ cm: EditorAdapter, _ prev: Bool, _ query: JSRegExp, _ repeatIn: Int?, _ vim: VimState
  ) throws -> (Pos, Pos)? {
    try cm.operation { () throws -> (Pos, Pos)? in
      let count = repeatIn ?? 1
      let pos = cm.getCursor()
      var cursor = cm.getSearchCursor(query, pos)
      // Go back one result to ensure that if the cursor is currently a match, we keep it.
      let found = try cursor.find(!prev)
      // If we haven't moved, go back one more (similar to if i==0 logic in findNext).
      if !vim.visualMode, found != nil, cursor.from() == pos { try cursor.find(!prev) }
      for _ in 0..<max(0, count) {
        if try cursor.find(prev) == nil {
          // SearchCursor may have returned null because it hit EOF, wrap around and try again.
          cursor = cm.getSearchCursor(
            query, prev ? Pos(cm.lastLine(), Pos.endOfLine) : Pos(cm.firstLine(), 0))
          if try cursor.find(prev) == nil { return nil }
        }
      }
      guard let from = cursor.from(), let to = cursor.to() else { return nil }
      return (from, to)
    }
  }

  /// `motions.findAndSelectNextInclusive`: `gn` / `gN`.
  func findAndSelectNextInclusive(
    _ cm: EditorAdapter, _ args: MotionArgs, _ vim: VimState, _ prevInputState: InputState
  ) throws -> MotionResult? {
    guard let query = globalState.query else { return nil }
    var prev = !args.forward
    prev = globalState.isReversed ? !prev : prev
    guard let next = try findNextFromAndToInclusive(cm, prev, query, args.repeat, vim) else {
      return nil
    }
    // If there's an operator that will be executed, return the selection.
    if prevInputState.operator != nil { return .range(next.0, next.1) }
    let from = next.0
    // The "to" of a match is one past it; shrink it so that only the match is selected.
    let to = Pos(next.1.line, next.1.ch - 1)
    if vim.visualMode {
      // If we were in visualLine or visualBlock mode, get out of it.
      if vim.visualLine || vim.visualBlock {
        vim.visualLine = false
        vim.visualBlock = false
        cm.signal(.vimModeChange, .modeChange(mode: "visual", subMode: ""))
      }
      // If we're currently in visual mode, we should extend the selection to include the search
      // result.
      let anchor = vim.sel.anchor
      if globalState.isReversed {
        return args.forward ? .range(anchor, from) : .range(anchor, to)
      } else {
        return args.forward ? .range(anchor, to) : .range(anchor, from)
      }
    } else {
      // Let's turn visual mode on.
      vim.visualMode = true
      vim.visualLine = false
      vim.visualBlock = false
      cm.signal(.vimModeChange, .modeChange(mode: "visual", subMode: ""))
    }
    return prev ? .range(to, from) : .range(from, to)
  }

  // MARK: The search command

  /// `commandDispatcher.processSearch(cm, vim, command)`: `/`, `?`, `*`, `#`, `g*`, `g#`.
  func processSearch(_ cm: EditorAdapter, _ vim: VimState, _ command: VimCommand) throws {
    guard let searchArgs = command.searchArgs else { return }
    let forward = searchArgs.forward
    let wholeWordOnly = searchArgs.wholeWordOnly
    globalState.isReversed = !forward
    let promptPrefix = forward ? "/" : "?"
    let originalQuery = globalState.query
    let originalScrollPos = cm.getScrollInfo()
    var lastQuery = VimText()

    func handleQuery(_ query: VimText, _ ignoreCase: Bool, _ smartCase: Bool) throws {
      globalState.searchHistoryController.pushInput(query)
      globalState.searchHistoryController.reset()
      do {
        try updateSearchQuery(cm, query, ignoreCase, smartCase)
      } catch {
        showConfirm(cm, "Invalid regex: " + query.string)
        clearInputState(cm)
        return
      }
      let motion = VimCommand(keys: "", type: .motion)
      motion.motion = "findNext"
      motion.motionArgs = MotionArgs(forward: true, toJumplist: searchArgs.toJumplist)
      try processMotion(cm, vim, motion)
    }

    func onPromptClose(_ query: VimText) throws {
      cm.scrollTo(originalScrollPos.left, originalScrollPos.top)
      try handleQuery(query, true, true)
      let macroModeState = globalState.macroModeState
      if macroModeState.isRecording { logSearchQuery(macroModeState, query) }
    }

    func pcreLabel() -> String {
      pcre ? "(JavaScript regexp: set pcre)" : "(Vim regexp: set nopcre)"
    }

    func onChange() {
      var parsedQuery: JSRegExp?
      do {
        parsedQuery = try updateSearchQuery(cm, lastQuery, true, true)
      } catch {
        // Swallow bad regexes for incremental search.
      }
      if let parsedQuery {
        let found = try? findNext(cm, !forward, parsedQuery)
        cm.scrollIntoView(found ?? nil)
      } else {
        clearSearchHighlight(cm)
        cm.scrollTo(originalScrollPos.left, originalScrollPos.top)
      }
    }

    let onPromptKeyUp: VimPanel.KeyHook = { [unowned self] e, queryIn, close in
      let keyName = self.vimKeyFromEvent(e)
      var query = queryIn
      if keyName == "<Up>" || keyName == "<Down>" {
        let up = keyName == "<Up>"
        query = self.globalState.searchHistoryController.nextMatch(query, up) ?? VimText()
        close(query)
      } else if let keyName, keyName != "<Left>" && keyName != "<Right>" {
        self.globalState.searchHistoryController.reset()
      }
      lastQuery = query
      onChange()
      return false
    }

    let onPromptKeyDown: VimPanel.KeyHook = { [unowned self] e, query, close in
      let keyName = self.vimKeyFromEvent(e)
      if keyName == "<Esc>" || keyName == "<C-c>" || keyName == "<C-[>"
        || (keyName == "<BS>" && query.isEmpty)
      {
        self.globalState.searchHistoryController.pushInput(query)
        self.globalState.searchHistoryController.reset()
        _ = try? self.updateSearchQuery(cm, originalQuery?.source ?? VimText())
        self.clearSearchHighlight(cm)
        cm.scrollTo(originalScrollPos.left, originalScrollPos.top)
        e.preventDefault()
        self.clearInputState(cm)
        close(nil)
        cm.focus()
      } else if keyName == "<Up>" || keyName == "<Down>" {
        e.preventDefault()
      } else if keyName == "<C-u>" {
        // Ctrl-U clears input.
        e.preventDefault()
        close(VimText())
      }
      return false
    }

    switch searchArgs.querySrc {
    case "prompt":
      let macroModeState = globalState.macroModeState
      if macroModeState.isPlaying {
        let query =
          macroModeState.replaySearchQueries.isEmpty
          ? VimText() : macroModeState.replaySearchQueries.removeFirst()
        try handleQuery(query, true, false)
      } else {
        let options = PromptOptions(prefix: promptPrefix)
        options.onClose = { query throws in try onPromptClose(query) }
        options.desc = pcreLabel()
        options.onDescClick = { [unowned self] in
          _ = self.setOptionValue("pcre", .bool(!self.pcre), nil)
          options.desc = pcreLabel()
          onChange()
        }
        options.onKeyUp = onPromptKeyUp
        options.onKeyDown = onPromptKeyDown
        showPrompt(cm, options)
      }
    case "wordUnderCursor":
      var word = expandWordUnderCursor(cm, WordOptions(noSymbol: true))
      var isKeyword = true
      if word == nil {
        word = expandWordUnderCursor(cm, WordOptions(noSymbol: false))
        isKeyword = false
      }
      guard let word else {
        showConfirm(cm, "No word under cursor")
        clearInputState(cm)
        return
      }
      var query = cm.getLine(word.start.line).substring(word.start.ch, word.end.ch)
      if isKeyword && wholeWordOnly {
        query = VimText("\\b") + query + "\\b"
      } else {
        query = escapeRegex(query)
      }
      // cachedCursor is used to save the old position of the cursor when * or # causes vim to seek
      // for the nearest word and shift the cursor before entering the motion.
      globalState.jumpList.cachedCursor = cm.getCursor()
      cm.setCursor(word.start)
      try handleQuery(query, true, false)
    default:
      break
    }
  }
}
