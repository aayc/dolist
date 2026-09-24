// Ported from `ExCommandDispatcher` and `commandDispatcher.processEx` of vim.js
// (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke and others): the `:` prompt, the ex
// command line parser (ranges, marks, patterns, offsets) and ex mappings.

typealias ExCommandFn = @MainActor (EditorAdapter, ExParams) throws -> Void

/// An entry of the ex command map.
@MainActor
final class ExCommandDefinition: KeyToKeySource {
  enum Kind {
    case builtin, api, exToEx, exToKey
  }

  let name: String
  let shortName: String?
  let type: Kind
  var possiblyAsync = false
  var excludeFromCommandHistory = false
  var toKeys: VimText?
  var toInput: VimText?
  var user = false

  init(name: String, shortName: String?, type: Kind) {
    self.name = name
    self.shortName = shortName
    self.type = type
  }

  /// `fromKey.noremap != false`: an ex-to-key mapping has no `noremap`, so it is non-recursive.
  var noremapForKeyToKey: Bool { true }
}

/// The parsed command line an ex command receives (`params`).
@MainActor
final class ExParams {
  var input = VimText()
  var line: Int?
  var lineEnd: Int?
  var selectionLine: Int?
  var selectionLineEnd: Int?
  var commandName: VimText?
  var argString: VimText?
  var args: [VimText]?
  var callback: (() throws -> Void)?
  var setCfg: VimOptionScope?
}

extension Vim {
  func buildCommandMap() {
    exCommandMap = [:]
    for entry in DefaultKeymap.exCommands {
      let definition = ExCommandDefinition(
        name: entry.name, shortName: entry.shortName, type: .builtin)
      definition.possiblyAsync = entry.possiblyAsync
      definition.excludeFromCommandHistory = entry.excludeFromCommandHistory
      exCommandMap[entry.shortName ?? entry.name] = definition
    }
  }

  // MARK: The : command

  /// `commandDispatcher.processEx(cm, vim, command)`.
  func processEx(_ cm: EditorAdapter, _ vim: VimState, _ command: VimCommand) throws {
    if command.type == .keyToEx {
      // Handle user defined Ex to Ex mappings
      try exProcessCommand(cm, command.exInput ?? VimText())
      return
    }
    let options = PromptOptions(prefix: ":")
    options.onClose = { [unowned self] input throws in
      // Give the prompt some time to close so that if processCommand shows an error, the
      // elements don't overlap.
      self.globalState.exCommandHistoryController.pushInput(input)
      self.globalState.exCommandHistoryController.reset()
      try self.exProcessCommand(cm, input)
      if cm.vim != nil { self.clearInputState(cm) }
      self.clearSearchHighlight(cm)
    }
    options.onKeyDown = { [unowned self] e, inputIn, close in
      let keyName = self.vimKeyFromEvent(e)
      var input = inputIn
      if keyName == "<Esc>" || keyName == "<C-c>" || keyName == "<C-[>"
        || (keyName == "<BS>" && input.isEmpty)
      {
        self.globalState.exCommandHistoryController.pushInput(input)
        self.globalState.exCommandHistoryController.reset()
        e.preventDefault()
        self.clearInputState(cm)
        self.clearSearchHighlight(cm)
        close(nil)
        cm.focus()
      }
      if keyName == "<Up>" || keyName == "<Down>" {
        e.preventDefault()
        let up = keyName == "<Up>"
        input = self.globalState.exCommandHistoryController.nextMatch(input, up) ?? VimText()
        close(input)
      } else if keyName == "<C-u>" {
        // Ctrl-U clears input.
        e.preventDefault()
        close(VimText())
      } else if let keyName, keyName != "<Left>" && keyName != "<Right>" {
        self.globalState.exCommandHistoryController.reset()
      }
      return false
    }
    options.onKeyUp = { [unowned self] _, query, _ in
      // Highlights the pattern of a :s command as it is typed.
      var inputStream = StringStream(query)
      let params = ExParams()
      do {
        try self.parseInput(cm, &inputStream, params)
        if params.commandName != "s" {
          self.clearSearchHighlight(cm)
          return false
        }
        guard let command = self.matchExCommand(params.commandName!) else { return false }
        self.parseCommandArgs(&inputStream, params, command)
        guard let argString = params.argString, !argString.isEmpty else { return false }
        if let regex = try self.parseQuery(argString.slice(1), true, true) {
          self.highlightSearchMatches(cm, regex)
        }
      } catch {}
      return false
    }
    if vim.visualMode {
      options.value = "'<,'>"
    } else {
      let count = vim.inputState.getRepeat()
      if count > 1 { options.value = VimText(".,.+" + String(count - 1)) }
    }
    showPrompt(cm, options)
  }

  // MARK: The dispatcher

  /// `exCommandDispatcher.processCommand(cm, input, opt_params)`.
  func exProcessCommand(_ cm: EditorAdapter, _ input: VimText, _ params: ExParams? = nil) throws {
    try cm.operation { () throws in
      cm.curOp?.isVimOp = true
      try self.exProcessCommandInner(cm, input, params ?? ExParams())
    }
  }

  private func exProcessCommandInner(_ cm: EditorAdapter, _ input: VimText, _ params: ExParams)
    throws
  {
    let vim = maybeInitVimState(cm)
    let commandHistoryRegister = globalState.registerController.getRegister(":")
    let previousCommand = commandHistoryRegister.text
    var inputStream = StringStream(input)
    // update ": with the latest command whether valid or invalid
    commandHistoryRegister.setText(input)
    params.input = input
    do {
      try parseInput(cm, &inputStream, params)
    } catch {
      showConfirm(cm, JSException.from(error).description)
      return
    }
    if vim.visualMode { try exitVisualMode(cm) }
    var command: ExCommandDefinition?
    var commandName: String?
    if let name = params.commandName, !name.isEmpty {
      command = matchExCommand(name)
      if let command {
        commandName = command.name
        if command.excludeFromCommandHistory { commandHistoryRegister.setText(previousCommand) }
        parseCommandArgs(&inputStream, params, command)
        if command.type == .exToKey {
          // Handle Ex to Key mapping.
          try doKeyToKey(cm, command.toKeys ?? VimText(), command)
          return
        } else if command.type == .exToEx {
          // Handle Ex to Ex mapping.
          try exProcessCommand(cm, command.toInput ?? VimText())
          return
        }
      }
    } else if params.line != nil {
      // If only a line range is defined, move to the line.
      commandName = "move"
    }
    guard let commandName else {
      showConfirm(cm, "Not an editor command \":" + input.string + "\"")
      return
    }
    do {
      guard let fn = exCommands[commandName] else {
        throw JSException.typeError("exCommands[commandName] is not a function")
      }
      try fn(cm, params)
      // Possibly asynchronous commands (e.g. substitute, which might have a user confirmation),
      // are responsible for calling the callback when done. All others have it taken care of for
      // them here.
      if !(command?.possiblyAsync ?? false), let callback = params.callback { try callback() }
    } catch {
      showConfirm(cm, JSException.from(error).description)
      throw error
    }
  }

  /// `parseInput_(cm, inputStream, result)`: the range and the command name.
  func parseInput(_ cm: EditorAdapter, _ inputStream: inout StringStream, _ result: ExParams) throws
  {
    let vim = maybeInitVimState(cm)
    inputStream.eatWhile(":")
    // Parse range.
    if inputStream.eat("%") != nil {
      result.line = cm.firstLine()
      result.lineEnd = cm.lastLine()
    } else if inputStream.eat("*") != nil {
      let lastSelection = vim.lastSelection
      let anchor = lastSelection?.anchorMark.find()?.line ?? 0
      let head = lastSelection?.headMark.find()?.line ?? 0
      result.line = max(anchor, head)
      result.lineEnd = min(anchor, head)
    } else {
      result.line = try parseLineSpec(cm, &inputStream)
      if result.line != nil, inputStream.eat(",") != nil {
        result.lineEnd = try parseLineSpec(cm, &inputStream)
      }
    }
    if result.line == nil {
      if vim.visualMode {
        result.selectionLine = getMarkPos(cm, vim, "<")?.line
        result.selectionLineEnd = getMarkPos(cm, vim, ">")?.line
      } else {
        result.selectionLine = cm.getCursor().line
      }
    } else {
      result.selectionLine = result.line
      result.selectionLineEnd = result.lineEnd
    }
    inputStream.eatSpace()
    // Parse command name: /^(\w+|!!|@@|[!#&*<=>@~])/, else /.*/.
    let rest = inputStream.string.slice(inputStream.pos)
    var nameLength = 0
    while nameLength < rest.length && isJSAsciiWordChar(rest[nameLength]) { nameLength += 1 }
    if nameLength == 0 {
      if rest.hasPrefix("!!") || rest.hasPrefix("@@") {
        nameLength = 2
      } else if let first = rest.code(at: 0), "!#&*<=>@~".utf16.contains(first) {
        nameLength = 1
      }
    }
    if nameLength > 0 {
      result.commandName = rest.slice(0, nameLength)
      inputStream.pos += nameLength
    } else {
      result.commandName = inputStream.matchRestOfLine()
    }
  }

  /// `parseLineSpec_(cm, inputStream)`.
  private func parseLineSpec(_ cm: EditorAdapter, _ inputStream: inout StringStream) throws -> Int?
  {
    let rest = inputStream.string.slice(inputStream.pos)
    var digits = 0
    while digits < rest.length && isASCIIDigit(rest[digits]) { digits += 1 }
    if digits > 0 {
      inputStream.pos += digits
      let number = JSNumber.parseInt(rest.slice(0, digits), radix: 10)
      return try parseLineSpecOffset(cm, &inputStream, Int(min(number, 1e15)) - 1)
    }
    let vim = maybeInitVimState(cm)
    switch inputStream.next()?.string {
    case ".":
      return try parseLineSpecOffset(cm, &inputStream, cm.getCursor().line)
    case "$":
      return try parseLineSpecOffset(cm, &inputStream, cm.lastLine())
    case "'":
      let markName = inputStream.next()?.string ?? ""
      guard let markPos = getMarkPos(cm, vim, markName) else {
        throw JSException.error("Mark not set")
      }
      return try parseLineSpecOffset(cm, &inputStream, markPos.line)
    case "-", "+", "/", "?":
      inputStream.backUp(1)
      // Offset is relative to current line if not otherwise specified.
      return try parseLineSpecOffset(cm, &inputStream, cm.getCursor().line)
    default:
      inputStream.backUp(1)
      return nil
    }
  }

  /// `parseLineSpecOffset_(cm, inputStream, line)`: `+3`, `-`, `/pattern/`, `?pattern?`, `\/`.
  private func parseLineSpecOffset(
    _ cm: EditorAdapter, _ inputStream: inout StringStream, _ lineIn: Int
  ) throws -> Int {
    var line = lineIn
    while true {
      // /^([\/\?]|\\[\?\/])|([+-]?)(\d*)/
      let rest = inputStream.string.slice(inputStream.pos)
      var search: VimText?
      if let first = rest.code(at: 0), first == 0x2F || first == 0x3F {
        search = rest.slice(0, 1)
      } else if rest.code(at: 0) == 0x5C, let second = rest.code(at: 1),
        second == 0x3F || second == 0x2F
      {
        search = rest.slice(0, 2)
      }
      if let search {
        inputStream.pos += search.length
        var queryString = VimText()
        let forward = !search.hasSuffix("?")
        if search.length == 1 {
          let r = inputStream.string.slice(inputStream.pos)
          var end = 0
          while end < r.length {
            if forward {
              if r[end] != 0x2F && r[end] != 0x5C {
                end += 1
              } else if r[end] == 0x5C && r.code(at: end + 1) == 0x2F {
                end += 2
              } else {
                break
              }
            } else {
              if r[end] != 0x2F && r[end] != 0x3F { end += 1 } else { break }
            }
          }
          queryString = r.slice(0, end)
          inputStream.pos += end
          if inputStream.string.code(at: inputStream.pos) == (forward ? 0x2F : 0x3F) {
            inputStream.pos += 1
          }
        }
        if queryString.isEmpty {
          queryString = globalState.registerController.getRegister("/").text
        }
        let query = try JSRegExp.make(queryString)
        let cursor = cm.getSearchCursor(query, Pos(line + (forward ? 1 : 0), 0))
        if forward { _ = try cursor.findNext() } else { _ = try cursor.findPrevious() }
        guard let nextPos = cursor.from() else {
          throw JSException.error("Pattern not found" + query.description)
        }
        line = nextPos.line
        continue
      }
      var length = 0
      var sign = VimText()
      if let first = rest.code(at: 0), first == 0x2B || first == 0x2D {
        sign = rest.slice(0, 1)
        length = 1
      }
      var digitsEnd = length
      while digitsEnd < rest.length && isASCIIDigit(rest[digitsEnd]) { digitsEnd += 1 }
      if digitsEnd == 0 { break }
      let digits = rest.slice(length, digitsEnd)
      inputStream.pos += digitsEnd
      let offset = JSNumber.parseInt(sign + (digits.isEmpty ? "1" : digits), radix: 10)
      line += Int(max(min(offset, 1e15), -1e15))
    }
    return line
  }

  /// `parseCommandArgs_(inputStream, params, command)`.
  func parseCommandArgs(
    _ inputStream: inout StringStream, _ params: ExParams, _ command: ExCommandDefinition
  ) {
    if inputStream.eol() { return }
    params.argString = inputStream.matchRestOfLine()
    // Parse command-line arguments: trim(argString).split(/\s+/)
    let args = splitOnWhitespace(params.argString?.trim() ?? VimText())
    if let first = args.first, !first.isEmpty { params.args = args }
  }

  /// `str.split(/\s+/)`.
  func splitOnWhitespace(_ str: VimText) -> [VimText] {
    var parts: [VimText] = []
    var current: [UInt16] = []
    var i = 0
    let u = str.units
    while i < u.count {
      if isJSWhitespace(u[i]) {
        parts.append(VimText(units: current))
        current = []
        while i < u.count && isJSWhitespace(u[i]) { i += 1 }
      } else {
        current.append(u[i])
        i += 1
      }
    }
    parts.append(VimText(units: current))
    return parts
  }

  /// `matchCommand_(commandName)`: the command whose prefix (short name) starts the name.
  func matchExCommand(_ commandName: VimText) -> ExCommandDefinition? {
    var i = commandName.length
    while i > 0 {
      let prefix = commandName.substring(0, i).string
      if let command = exCommandMap[prefix], VimText(command.name).indexOf(commandName) == 0 {
        return command
      }
      i -= 1
    }
    return nil
  }

  // MARK: Mappings

  /// `exCommandDispatcher.map(lhs, rhs, ctx, noremap)`.
  func exMap(_ lhs: VimText, _ rhs: VimText, _ ctx: KeyContext?, noremap: Bool) throws {
    if lhs != ":" && lhs.charAt(0) == ":" {
      if ctx != nil { throw JSException.error("Mode not supported for ex mappings") }
      let commandName = lhs.substring(1).string
      if rhs != ":" && rhs.charAt(0) == ":" {
        // Ex to Ex mapping
        let definition = ExCommandDefinition(name: commandName, shortName: nil, type: .exToEx)
        definition.toInput = rhs.substring(1)
        definition.user = true
        exCommandMap[commandName] = definition
      } else {
        // Ex to key mapping
        let definition = ExCommandDefinition(name: commandName, shortName: nil, type: .exToKey)
        definition.toKeys = rhs
        definition.user = true
        exCommandMap[commandName] = definition
      }
    } else {
      // Key to key or ex mapping
      let mapping = VimCommand(keys: lhs, type: .keyToKey)
      mapping.toKeys = rhs
      mapping.noremapValue = noremap
      mapping.context = ctx
      mapCommand(mapping)
    }
  }

  /// `exCommandDispatcher.unmap(lhs, ctx)`: removes the first entry with these keys and exactly
  /// this context (nil: none), default bindings included.
  func exUnmap(_ lhs: VimText, _ ctx: KeyContext?, rawContext: String? = nil) throws -> Bool {
    if lhs != ":" && lhs.charAt(0) == ":" {
      // Ex to Ex or Ex to key mapping
      if ctx != nil || !(rawContext ?? "").isEmpty {
        throw JSException.error("Mode not supported for ex mappings")
      }
      let commandName = lhs.substring(1).string
      if let definition = exCommandMap[commandName], definition.user {
        exCommandMap[commandName] = nil
        return true
      }
      return false
    }
    // Key to Ex or key to key mapping (vim.js compares contexts with ===).
    if let rawContext, KeyContext(rawValue: rawContext) == nil { return false }
    if let index = keymap.firstIndex(where: { $0.keys == lhs && $0.context == ctx }) {
      keymap.remove(at: index)
      removeUsedKeys(lhs)
      return true
    }
    return false
  }
}
