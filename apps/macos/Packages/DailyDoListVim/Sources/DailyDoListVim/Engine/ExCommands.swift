// Ported from `exCommands` of vim.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke
// and others).

extension Vim {
  func registerExCommands() {
    exCommands["colorscheme"] = { [unowned self] cm, params throws in
      if (params.args?.count ?? 0) < 1 {
        // The editor has no `theme` option: vim shows an empty message.
        self.showConfirm(cm, "")
        return
      }
    }
    for (name, context, noremap) in [
      ("map", nil, false), ("imap", KeyContext.insert, false), ("nmap", .normal, false), ("vmap", .visual, false),
      ("omap", .operatorPending, false), ("noremap", nil, true), ("inoremap", .insert, true), ("nnoremap", .normal, true),
      ("vnoremap", .visual, true), ("onoremap", .operatorPending, true),
    ] as [(String, KeyContext?, Bool)] {
      exCommands[name] = { [unowned self] cm, params throws in
        guard let mapArgs = params.args, mapArgs.count >= 2 else {
          self.showConfirm(cm, "Invalid mapping: " + params.input.string)
          return
        }
        try self.exMap(mapArgs[0], mapArgs[1], context, noremap: noremap)
      }
    }
    exCommands["unmap"] = { [unowned self] cm, params throws in
      guard let mapArgs = params.args, !mapArgs.isEmpty, try self.exUnmap(mapArgs[0], nil) else {
        self.showConfirm(cm, "No such mapping: " + params.input.string)
        return
      }
    }
    exCommands["mapclear"] = { [unowned self] _, _ throws in self.mapclear(nil as KeyContext?) }
    exCommands["imapclear"] = { [unowned self] _, _ throws in self.mapclear(KeyContext.insert) }
    exCommands["nmapclear"] = { [unowned self] _, _ throws in self.mapclear(KeyContext.normal) }
    exCommands["vmapclear"] = { [unowned self] _, _ throws in self.mapclear(KeyContext.visual) }
    exCommands["omapclear"] = { [unowned self] _, _ throws in self.mapclear(KeyContext.operatorPending) }
    exCommands["move"] = { [unowned self] cm, params throws in
      let command = VimCommand(keys: "", type: .motion)
      command.motion = "moveToLineOrEdgeOfDocument"
      command.motionArgs = MotionArgs(forward: false, linewise: true, explicitRepeat: true)
      command.repeatOverride = (params.line ?? 0) + 1
      try self.processCommand(cm, self.maybeInitVimState(cm), command)
    }
    exCommands["set"] = { [unowned self] cm, params throws in try self.exSet(cm, params) }
    exCommands["setlocal"] = { [unowned self] cm, params throws in
      params.setCfg = .local
      try self.exSet(cm, params)
    }
    exCommands["setglobal"] = { [unowned self] cm, params throws in
      params.setCfg = .global
      try self.exSet(cm, params)
    }
    exCommands["registers"] = { [unowned self] cm, params throws in
      let registers = self.globalState.registerController.registers
      var regInfo = "----------Registers----------\n\n"
      if let regArgs = params.args {
        let registerNames = regArgs.joined()
        for u in registerNames.units {
          let registerName = VimText(unit: u).string
          if !self.globalState.registerController.isValidRegister(registerName) { continue }
          let register = registers[registerName] ?? VimRegister()
          regInfo += "\"" + registerName + "    " + register.text.string + "\n"
        }
      } else {
        for registerName in registers.keys {
          let text = registers[registerName]!.text
          if !text.isEmpty { regInfo += "\"" + registerName + "    " + text.string + "\n" }
        }
      }
      self.showConfirm(cm, regInfo, long: true)
    }
    exCommands["marks"] = { [unowned self] cm, params throws in
      let marks = self.maybeInitVimState(cm).marks
      var regInfo = "-----------Marks-----------\nmark\tline\tcol\n\n"
      let names = params.args.map { $0.joined().units.map { VimText(unit: $0).string } } ?? marks.keys
      for name in names {
        if let marker = marks[name]?.find() { regInfo += name + "\t" + String(marker.line) + "\t" + String(marker.ch) + "\n" }
      }
      self.showConfirm(cm, regInfo, long: true)
    }
    exCommands["sort"] = { [unowned self] cm, params throws in try self.exSort(cm, params) }
    exCommands["vglobal"] = { [unowned self] cm, params throws in try self.exGlobal(cm, params) }
    exCommands["global"] = { [unowned self] cm, params throws in try self.exGlobal(cm, params) }
    exCommands["normal"] = { [unowned self] cm, params throws in
      var noremap = false
      guard var argString = params.argString else {
        throw JSException.typeError("Cannot read properties of undefined (reading 'trimStart')")
      }
      if argString.code(at: 0) == 0x21 {
        argString = argString.slice(1)
        noremap = true
      }
      argString = argString.trimStart()
      if argString.isEmpty {
        self.showConfirm(cm, "Argument is required.")
        return
      }
      // vim.js feeds the original argument string (a leading "!" included).
      let keys = params.argString!.trimStart()
      if let line = params.line {
        let lineEnd = params.lineEnd ?? line
        var i = line
        while i <= lineEnd {
          cm.setCursor(i, 0)
          try self.doKeyToKey(cm, keys, NoremapSource(noremap: noremap))
          if self.maybeInitVimState(cm).insertMode { try self.exitInsertMode(cm, keepCursor: true) }
          i += 1
        }
      } else {
        try self.doKeyToKey(cm, keys, NoremapSource(noremap: noremap))
        if self.maybeInitVimState(cm).insertMode { try self.exitInsertMode(cm, keepCursor: true) }
      }
    }
    exCommands["substitute"] = { [unowned self] cm, params throws in try self.exSubstitute(cm, params) }
    exCommands["startinsert"] = { [unowned self] cm, params throws in
      try self.doKeyToKey(cm, params.argString == "!" ? "A" : "i", NoremapSource(noremap: true))
    }
    exCommands["redo"] = { cm, _ throws in cm.runHistoryCommand(revert: false) }
    exCommands["undo"] = { cm, _ throws in cm.runHistoryCommand(revert: true) }
    exCommands["write"] = { cm, _ throws in cm.host.vimSave() }
    exCommands["nohlsearch"] = { [unowned self] cm, _ throws in self.clearSearchHighlight(cm) }
    exCommands["yank"] = { [unowned self] cm, params throws in
      guard var line = params.selectionLine else { throw JSException.rangeError("Invalid line number NaN") }
      var lineEnd = params.selectionLineEnd ?? line
      if lineEnd < line { swap(&line, &lineEnd) }
      let text = cm.getRange(Pos(line, 0), Pos(lineEnd + 1, 0))
      let registerName = params.args.flatMap { $0.first.map(\.string) }.flatMap { $0.isEmpty ? nil : $0 } ?? "0"
      self.globalState.registerController.pushText(registerName, "yank", text, linewise: true, blockwise: false)
      self.showConfirm(cm, String(lineEnd + 1 - line) + " lines yanked" + " into \"" + registerName, long: false, duration: 1.5)
    }
    exCommands["put"] = { [unowned self] cm, params throws in try self.exPut(cm, params, matchIndent: false) }
    exCommands["iput"] = { [unowned self] cm, params throws in try self.exPut(cm, params, matchIndent: true) }
    exCommands["delete"] = { [unowned self] cm, params throws in
      guard let line = params.selectionLine else { throw JSException.rangeError("Invalid line number NaN") }
      let lineEnd = params.selectionLineEnd ?? line
      let args = OperatorArgs(linewise: true)
      _ = try self.operators["delete"]!(cm, args, [VimRange(anchor: Pos(line, 0), head: Pos(lineEnd + 1, 0))], Pos(line, 0), nil)
    }
    exCommands["join"] = { [unowned self] cm, params throws in
      guard let line = params.selectionLine else { throw JSException.rangeError("Invalid line number NaN") }
      let lineEnd = params.selectionLineEnd ?? line
      cm.setCursor(Pos(line, 0))
      let args = ActionArgs()
      args.repeat = lineEnd - line
      try self.actions["joinLines"]!(cm, args, self.maybeInitVimState(cm))
    }
    exCommands["delmarks"] = { [unowned self] cm, params throws in try self.exDelmarks(cm, params) }
  }

  /// `exCommands.put(cm, params, matchIndent)`.
  private func exPut(_ cm: EditorAdapter, _ params: ExParams, matchIndent: Bool) throws {
    // vim.js sets `lineWise` (sic), so the register decides whether the text is linewise.
    let actionArgs = ActionArgs(after: true, isEdit: true, matchIndent: matchIndent)
    actionArgs.repeat = 1
    actionArgs.registerName = ""
    var args = params.args ?? []
    if args.first == "!" {
      actionArgs.after = false
      args.removeFirst()
    }
    if let first = args.first, !first.isEmpty { actionArgs.registerName = first.string }
    if let line = params.selectionLine { cm.setCursor(Pos(line, 0)) }
    try actions["paste"]!(cm, actionArgs, maybeInitVimState(cm))
  }

  /// `exCommands.set(cm, params)`: `:set opt`, `:set noopt`, `:set opt!`, `:set opt?`,
  /// `:set opt=value`.
  private func exSet(_ cm: EditorAdapter, _ params: ExParams) throws {
    let setCfg = params.setCfg
    guard let setArgs = params.args, !setArgs.isEmpty else {
      showConfirm(cm, "Invalid mapping: " + params.input.string)
      return
    }
    var expr = setArgs[0].split(unit: 0x3D)
    var optionName = expr.isEmpty ? VimText() : expr.removeFirst()
    var value: VimOptionValue? = expr.isEmpty ? nil : .string(expr.joined("=").string)
    var forceGet = false
    var forceToggle = false
    if optionName.charAt(optionName.length - 1) == "?" {
      // If post-fixed with ?, then the set is actually a get.
      if let v = value, v.isTruthy { throw JSException.error("Trailing characters: " + (params.argString?.string ?? "undefined")) }
      optionName = optionName.substring(0, optionName.length - 1)
      forceGet = true
    } else if optionName.charAt(optionName.length - 1) == "!" {
      optionName = optionName.substring(0, optionName.length - 1)
      forceToggle = true
    }
    if value == nil && optionName.substring(0, 2) == "no" {
      // To set boolean options to false, the option name is prefixed with 'no'.
      optionName = optionName.substring(2)
      value = .bool(false)
    }
    let name = optionName.string
    let optionIsBoolean = options[name]?.kind == .boolean
    if optionIsBoolean {
      if forceToggle {
        let current = (try? getOptionValue(name, cm, scope: setCfg).get()) ?? nil
        value = .bool(!(current?.isTruthy ?? false))
      } else if value == nil {
        // Calling set with a boolean option sets it to true.
        value = .bool(true)
      }
    }
    // If no value is provided, then we assume this is a get.
    if (!optionIsBoolean && value == nil) || forceGet {
      switch getOptionValue(name, cm, scope: setCfg) {
      case .failure(let error):
        showConfirm(cm, error.message)
      case .success(let old):
        if case .bool(let b) = old {
          showConfirm(cm, " " + (b ? "" : "no") + name)
        } else {
          showConfirm(cm, "  " + name + "=" + (old?.description ?? "undefined"))
        }
      }
    } else if let error = setOptionValue(name, value, cm, scope: setCfg) {
      showConfirm(cm, error.message)
    }
  }

  /// `exCommands.delmarks(cm, params)`.
  private func exDelmarks(_ cm: EditorAdapter, _ params: ExParams) throws {
    guard let argString = params.argString, !argString.trim().isEmpty else {
      showConfirm(cm, "Argument required")
      return
    }
    let state = maybeInitVimState(cm)
    var stream = StringStream(argString.trim())
    func isLetter(_ u: UInt16) -> Bool { (u >= 0x41 && u <= 0x5A) || (u >= 0x61 && u <= 0x7A) }
    while !stream.eol() {
      stream.eatSpace()
      // Record the streams position at the beginning of the loop for use in error messages.
      let count = stream.pos
      guard let c = stream.string.code(at: stream.pos), isLetter(c) else {
        showConfirm(cm, "Invalid argument: " + argString.substring(count).string)
        return
      }
      let sym = stream.next()!
      if stream.match("-") {
        // This symbol is part of a range. The range must terminate at an alphabetic character.
        guard let f = stream.string.code(at: stream.pos), isLetter(f) else {
          showConfirm(cm, "Invalid argument: " + argString.substring(count).string)
          return
        }
        let startMark = sym
        let finishMark = stream.next()!
        // The range must terminate at an alphabetic character which shares the same case as the
        // start of the range.
        if startMark.isLowerCaseLetter == finishMark.isLowerCaseLetter {
          let start = startMark[0], finish = finishMark[0]
          if start >= finish {
            showConfirm(cm, "Invalid argument: " + argString.substring(count).string)
            return
          }
          // Because marks are always ASCII values, and we have determined that they are the same
          // case, we can use their char codes to iterate through the defined range.
          for code in start...finish { state.marks[VimText(unit: code).string] = nil }
        } else {
          showConfirm(cm, "Invalid argument: " + startMark.string + "-")
          return
        }
      } else {
        // This symbol is a valid mark, and is not part of a range.
        state.marks[sym.string] = nil
      }
    }
  }

  /// `exCommands.global(cm, params)`: `:g/pattern/cmd`, `:g!`, `:v`.
  private func exGlobal(_ cm: EditorAdapter, _ params: ExParams) throws {
    // a global command is of the form :[range]g/pattern/[cmd]; argString holds the string
    // /pattern/[cmd]
    guard var argString = params.argString, !argString.isEmpty else {
      showConfirm(cm, "Regular Expression missing from global")
      return
    }
    let commandName = params.commandName ?? VimText()
    var inverted = commandName.charAt(0) == "v"
    if argString.charAt(0) == "!" && commandName.charAt(0) == "g" {
      inverted = true
      argString = argString.slice(1)
    }
    // range is specified here
    let lineStart = params.line ?? cm.firstLine()
    let lineEnd = nonZero(params.lineEnd) ?? nonZero(params.line) ?? cm.lastLine()
    // get the tokens from argString
    let tokens = splitBySeparator(argString, 0x2F)
    var regexPart = argString, cmd = VimText()
    if let tokens, !tokens.isEmpty {
      regexPart = tokens[0]
      cmd = Array(tokens.dropFirst()).joined("/")
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
    // now that we have the regexPart, search for regex matches in the specified range of lines
    guard let query = globalState.query else {
      throw JSException.typeError("Cannot read properties of undefined (reading 'test')")
    }
    var matchedHandles: [LineHandle] = []
    var matchedLines: [VimText] = []
    var i = lineStart
    while i <= lineEnd {
      let line = cm.getLine(i)
      let matched = query.test(line)
      if matched != inverted {
        if cmd.isEmpty { matchedLines.append(line) } else { matchedHandles.append(cm.getLineHandle(i)) }
      }
      i += 1
    }
    // if there is no [cmd], just display the list of matched lines
    if cmd.isEmpty {
      showConfirm(cm, matchedLines.joined("\n").string)
      return
    }
    // vim.js recurses through the callback; a trampoline keeps the same order without deep
    // stacks (and still runs inside the :g command's operation).
    var index = 0
    var running = false
    var requested = false
    var step: (() throws -> Void)!
    let nextCommand: () throws -> Void = {
      requested = true
      if running { return }
      running = true
      defer { running = false }
      while requested {
        requested = false
        try step()
      }
    }
    step = { [unowned self] () throws in
      if index < matchedHandles.count {
        let lineHandle = matchedHandles[index]
        index += 1
        guard let lineNum = cm.getLineNumber(lineHandle) else {
          requested = true
          return
        }
        let command = VimText(String(lineNum + 1)) + cmd
        let inner = ExParams()
        inner.callback = nextCommand
        try self.exProcessCommand(cm, command, inner)
      } else {
        cm.releaseLineHandles()
      }
    }
    try nextCommand()
  }

  /// JavaScript's `value || fallback` for a line number (0 counts as unset).
  private func nonZero(_ value: Int?) -> Int? {
    guard let value, value != 0 else { return nil }
    return value
  }

  // MARK: :sort

  private enum SortEntry {
    case match(key: VimText, input: VimText)
    case plain(VimText)
  }

  /// `exCommands.sort(cm, params)`: `:sort[!] [dinuoxr] [/pattern/]`.
  private func exSort(_ cm: EditorAdapter, _ params: ExParams) throws {
    var reverse = false, ignoreCase = false, unique = false, includeMatch = false
    var number: String?
    var pattern: JSRegExp?
    func parseArgs() throws -> String? {
      guard let argString = params.argString, !argString.isEmpty else { return nil }
      var args = StringStream(argString)
      if args.eat("!") != nil { reverse = true }
      if args.eol() { return nil }
      if !args.eatSpace() { return "Invalid arguments" }
      // /([dinuoxr]+)?\s*(\/.+\/)?\s*/
      let rest = args.string.slice(args.pos).units
      var i = 0
      while i < rest.count, "dinuoxr".utf16.contains(rest[i]) { i += 1 }
      let flags = VimText(rest[0..<i])
      while i < rest.count, isJSWhitespace(rest[i]) { i += 1 }
      var patternText: VimText?
      if i < rest.count, rest[i] == 0x2F {
        var lineEnd = i + 1
        while lineEnd < rest.count, !isJSLineTerminator(rest[lineEnd]) { lineEnd += 1 }
        if let close = rest[(i + 1)..<lineEnd].lastIndex(of: 0x2F), close > i + 1 {
          patternText = VimText(rest[i...close])
          i = close + 1
        }
      }
      while i < rest.count, isJSWhitespace(rest[i]) { i += 1 }
      if i < rest.count { return "Invalid arguments" }
      if !flags.isEmpty {
        includeMatch = flags.contains(unit: 0x72)
        ignoreCase = flags.contains(unit: 0x69)
        unique = flags.contains(unit: 0x75)
        let decimal = flags.contains(unit: 0x64) || flags.contains(unit: 0x6E)
        let hex = flags.contains(unit: 0x78)
        let octal = flags.contains(unit: 0x6F)
        if (decimal ? 1 : 0) + (hex ? 1 : 0) + (octal ? 1 : 0) > 1 { return "Invalid arguments" }
        number = decimal ? "decimal" : hex ? "hex" : octal ? "octal" : nil
      }
      if let patternText {
        pattern = try JSRegExp.make(patternText.substr(1, patternText.length - 2), ignoreCase ? "i" : "")
      }
      return nil
    }
    if let err = try parseArgs() {
      showConfirm(cm, err + ": " + (params.argString?.string ?? "undefined"))
      return
    }
    let lineStart = nonZero(params.line) ?? cm.firstLine()
    let lineEnd = nonZero(params.lineEnd) ?? nonZero(params.line) ?? cm.lastLine()
    if lineStart == lineEnd { return }
    let curStart = Pos(lineStart, 0)
    let curEnd = Pos(lineEnd, lineLength(cm, lineEnd))
    var text = cm.getRange(curStart, curEnd).split(unit: 0x0A)
    let numberRegex: JSRegExp? = switch number {
    case "decimal": try JSRegExp.make("(-?)([\\d]+)")
    case "hex": try JSRegExp.make("(-?)(?:0x)?([0-9a-f]+)", "i")
    case "octal": try JSRegExp.make("([0-7]+)")
    default: nil
    }
    let radix = number == "decimal" ? 10 : number == "hex" ? 16 : 8
    var numPart: [SortEntry] = []
    var textPart: [VimText] = []
    if number != nil || pattern != nil {
      for line in text {
        var entry: SortEntry?
        if let pattern, let m = pattern.firstMatch(in: line) {
          let key = includeMatch ? (m[0] ?? VimText()) : line.slice(m.index + m.length)
          if !key.isEmpty { entry = .match(key: key, input: line) }
        }
        if let entry {
          numPart.append(entry)
        } else if let numberRegex, numberRegex.test(line) {
          numPart.append(.plain(line))
        } else {
          textPart.append(line)
        }
      }
    } else {
      textPart = text
    }
    func compareFn(_ a0: VimText, _ b0: VimText) -> Double {
      var a = a0, b = b0
      if reverse { swap(&a, &b) }
      if ignoreCase {
        a = a.toLowerCase()
        b = b.toLowerCase()
      }
      guard let numberRegex, let amatch = numberRegex.firstMatch(in: a), let bmatch = numberRegex.firstMatch(in: b) else {
        return a < b ? -1 : 1
      }
      let anum = JSNumber.parseInt(((amatch[1] ?? "") + (amatch[2] ?? "undefined")).toLowerCase(), radix: radix)
      let bnum = JSNumber.parseInt(((bmatch[1] ?? "") + (bmatch[2] ?? "undefined")).toLowerCase(), radix: radix)
      return anum - bnum
    }
    func key(_ entry: SortEntry) -> VimText? {
      switch entry {
      case .match(let key, _): return key
      case .plain(let line): return line.at(0)
      }
    }
    if pattern != nil {
      if ignoreCase {
        for (i, entry) in numPart.enumerated() {
          switch entry {
          case .match(let k, let input): numPart[i] = .match(key: k.toLowerCase(), input: input)
          case .plain(let line): throw JSException.typeError("Cannot assign to read only property '0' of string '\(line.string)'")
          }
        }
      }
      numPart = stableSorted(numPart) { a, b in
        var ka = key(a), kb = key(b)
        if reverse { swap(&ka, &kb) }
        guard let x = ka, let y = kb else { return false }
        return x < y
      }
    } else {
      numPart = stableSorted(numPart) { a, b in
        guard case .plain(let x) = a, case .plain(let y) = b else { return false }
        return compareFn(x, y) < 0
      }
    }
    let numLines: [VimText] = numPart.map {
      switch $0 {
      case .match(_, let input): return input
      case .plain(let line): return pattern != nil ? VimText() : line
      }
    }
    if pattern == nil && number == nil { textPart = stableSorted(textPart) { compareFn($0, $1) < 0 } }
    text = !reverse ? textPart + numLines : numLines + textPart
    if unique {
      // Remove duplicate lines
      let textOld = text
      var lastLine: VimText?
      text = []
      for line in textOld {
        if line != lastLine { text.append(line) }
        lastLine = line
      }
    }
    try cm.replaceRange(text.joined("\n"), curStart, curEnd)
  }

  /// A stable sort (V8's `Array.prototype.sort` is stable).
  private func stableSorted<T>(_ items: [T], _ less: (T, T) -> Bool) -> [T] {
    items.enumerated().sorted { a, b in
      if less(a.element, b.element) { return true }
      if less(b.element, a.element) { return false }
      return a.offset < b.offset
    }.map(\.element)
  }
}
