// Ported from vim.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke and others):
// the module state of `initVim` and the external API (`vimApi`). In vim.js this state is global to
// the page; here it lives in a `Vim` instance that the editors of an app share.

/// Vim's global state: registers, search and command history, macros, the jump list, mappings,
/// options and ex commands. Create one per app and attach every editor to it; tests create their
/// own for isolation. See the package README for the integration guide.
@MainActor
public final class Vim {
  // MARK: Configuration

  /// `CodeMirror.isMac`: on macOS a lone Option modifier types characters, and unmatched `<A-…>`
  /// keys are swallowed in normal mode.
  public var isMac: Bool
  /// Backs the `+` register (vim.js uses the browser clipboard).
  public var clipboard: VimClipboard?
  /// Runs vim's delayed work (search highlight, insert-mode mapping timeout).
  public let scheduler: VimScheduler
  /// Called when a command throws (vim then resets the editor's vim state, like the web app).
  public var onError: ((JSException) -> Void)?

  // MARK: Host hooks (what the web app patches into vim.js)

  /// Called after `mapclear` removed user mappings (`:mapclear`, `mapclear(context:)`) with the
  /// context it cleared (nil: all), so a host can put its own keys back (the web app's `gt`).
  public var didMapclear: ((_ context: String?) -> Void)?
  /// Called after a yank, delete or change stored text (`RegisterController.pushText`), with the
  /// register the user named (nil: none): `set clipboard=unnamed` mirrors the unnamed register.
  public var didPushText: ((_ registerName: String?, _ linewise: Bool, _ blockwise: Bool) -> Void)?
  /// A register `p`/`P` without a register name (or `""`) paste from instead of the unnamed
  /// register when it holds other, non-empty text (the web app's `set clipboard=unnamed` pastes
  /// what another app copied). nil (or returning nil) pastes the unnamed register.
  public var unnamedPasteRegister: ((_ session: VimSession) -> VimRegister?)?

  // MARK: Global state

  var globalState: VimGlobalState!
  var options: [String: VimOption] = [:]
  var keymap: [VimCommand]
  let defaultKeymapLength: Int
  var exCommandMap: [String: ExCommandDefinition] = [:]
  var exCommands: [String: ExCommandFn] = [:]
  var motions: [String: MotionFn] = [:]
  var operators: [String: OperatorFn] = [:]
  var actions: [String: ActionFn] = [:]
  var keyToKeyStack: [KeyToKeySource] = []
  var noremap = false
  var virtualPrompt: PromptOptions?
  var usedKeys: [VimText: Int] = [:]
  var langmap = Langmap(keymap: [:], string: VimText())
  var validRegisters: [String] = ["-", "\"", ".", ":", "_", "/", "+"]
  let validMarks: [String] = ["<", ">"]
  var highlightTimeout: VimTimer?
  var lastInsertModeKeyTimer: VimTimer?

  // Handler identities (vim.js registers these functions and removes them later).
  let onChangeToken = HandlerToken()
  let onCursorActivityToken = HandlerToken()
  let onKeyEventTargetKeyDownToken = HandlerToken()

  public init(scheduler: VimScheduler? = nil, isMac: Bool = true) {
    self.scheduler = scheduler ?? MainQueueVimScheduler()
    self.isMac = isMac
    keymap = DefaultKeymap.make()
    defaultKeymapLength = keymap.count
    buildCommandMap()
    registerMotions()
    registerOperators()
    registerActions()
    registerExCommands()
    defineDefaultOptions()
    resetVimGlobalState()
    let version: ExCommandFn = { [unowned self] cm, _ in self.showConfirm(cm, "Codemirror-vim version: <DEV>") }
    try? defineEx("version", "ve", version)
  }

  /// `resetVimGlobalState()`: registers, history, macros, the jump list, the last search and
  /// option values. Mappings and ex commands stay (like in vim.js).
  public func resetGlobalState() {
    resetVimGlobalState()
  }

  func resetVimGlobalState() {
    globalState = VimGlobalState(self)
    for option in options.values { option.value = option.defaultValue }
  }

  // MARK: Editors

  /// Attaches vim to `editor` (`enterVimMode`). Keep the session as long as vim mode is on.
  public func attach(to editor: any VimEditor) -> VimSession {
    VimSession(vim: self, editor: editor)
  }

  // MARK: Mappings

  /// `:map lhs rhs` in `context` ("normal", "insert", "visual" or nil for all).
  public func map(_ lhs: String, _ rhs: String, context: String? = nil) throws {
    try exMap(VimText(lhs), VimText(rhs), context.flatMap(KeyContext.init(rawValue:)), noremap: false)
  }

  /// `:noremap lhs rhs`: the right-hand side isn't mapped again.
  public func noremap(_ lhs: String, _ rhs: String, context: String? = nil) throws {
    try exMap(VimText(lhs), VimText(rhs), context.flatMap(KeyContext.init(rawValue:)), noremap: true)
  }

  /// `:unmap lhs`; returns whether a mapping was removed.
  @discardableResult
  public func unmap(_ lhs: String, context: String? = nil) throws -> Bool {
    try exUnmap(VimText(lhs), context.flatMap(KeyContext.init(rawValue:)), rawContext: context)
  }

  /// `:mapclear`: removes the user mappings of `context` (all when nil).
  public func mapclear(context: String? = nil) {
    mapclear(context.flatMap(KeyContext.init(rawValue:)))
  }

  func mapclear(_ ctx: KeyContext?) {
    defer { didMapclear?(ctx?.rawValue) }
    let actualLength = keymap.count
    let userCount = max(0, actualLength - defaultKeymapLength)
    let userKeymap = Array(keymap.prefix(userCount))
    keymap = Array(keymap.suffix(from: userCount))
    guard let ctx else { return }
    for mapping in userKeymap.reversed() where ctx != mapping.context {
      if mapping.context != nil {
        mapCommand(mapping)
      } else {
        for context in [KeyContext.normal, .insert, .visual] where context != ctx {
          let newMapping = mapping.copy()
          newMapping.context = context
          mapCommand(newMapping)
        }
      }
    }
  }

  /// `_mapCommand(command)`: user commands go first.
  func mapCommand(_ command: VimCommand) {
    keymap.insert(command, at: 0)
    if !command.keys.isEmpty { addUsedKeys(command.keys) }
  }

  func addUsedKeys(_ keys: VimText) {
    for part in splitKeyParts(keys) { usedKeys[part, default: 0] += 1 }
  }

  func removeUsedKeys(_ keys: VimText) {
    for part in splitKeyParts(keys) where (usedKeys[part] ?? 0) > 0 { usedKeys[part]! -= 1 }
  }

  /// `keys.split(/(<(?:[CSMA]-)*\w+>|.)/i)`, keeping the non-empty parts.
  private func splitKeyParts(_ keys: VimText) -> [VimText] {
    var parts: [VimText] = []
    var i = 0
    let u = keys.units
    while i < u.count {
      if let end = namedKeyEnd(u, i) {
        parts.append(VimText(u[i..<end]))
        i = end
      } else if isJSLineTerminator(u[i]) {
        // "." doesn't match a line terminator: it is left in the split text.
        parts.append(VimText(unit: u[i]))
        i += 1
      } else {
        parts.append(VimText(unit: u[i]))
        i += 1
      }
    }
    return parts
  }

  // MARK: Options

  /// `Vim.setOption(name, value, cm, {scope})`: sets the global value and, with `session`, the
  /// editor's. Throws for an unknown option or a non-boolean value for a boolean option (vim.js
  /// returns the error instead).
  public func setOption(_ name: String, _ value: VimOptionValue?, in session: VimSession? = nil, scope: VimOptionScope? = nil) throws {
    if let error = setOptionValue(name, value, session?.cm, scope: scope) { throw JSException.error(error.message) }
  }

  /// `Vim.getOption(name, cm, {scope})`: with `session`, the editor's value if it has one.
  public func getOption(_ name: String, in session: VimSession? = nil, scope: VimOptionScope? = nil) throws -> VimOptionValue? {
    switch getOptionValue(name, session?.cm, scope: scope) {
    case .success(let value): return value
    case .failure(let error): throw JSException.error(error.message)
    }
  }

  /// `Vim.defineOption(name, defaultValue, type, aliases, callback)`: an option for `:set`. A
  /// callback stores the value itself: it is called with (value, session) to set (session nil for
  /// the global value) and with (nil, session) to read.
  public func defineOption(
    _ name: String, defaultValue: VimOptionValue?, type: VimOptionType = .string, aliases: [String] = [],
    callback: ((_ value: VimOptionValue?, _ session: VimSession?) -> VimOptionValue?)? = nil
  ) throws {
    if defaultValue == nil && callback == nil {
      throw JSException.error("defaultValue is required unless callback is provided")
    }
    defineOption(name, defaultValue, type, aliases: aliases, callback: callback.map { callback in { value, cm in callback(value, cm?.session) } })
  }

  /// `Vim.langmap(string, remapCtrl)`.
  public func setLangmap(_ string: String, remapCtrl: Bool? = nil) {
    updateLangmap(VimText(string), remapCtrl: remapCtrl)
  }

  // MARK: Ex commands and registers

  /// `Vim.defineEx(name, prefix, fn)`: adds (or replaces) an ex command, e.g. `:write` with
  /// prefix "w". The prefix must start `name`.
  public func defineEx(_ name: String, _ prefix: String? = nil, _ handler: @escaping @MainActor (VimSession, VimExCommand) throws -> Void) throws {
    try defineEx(name, prefix) { cm, params in
      guard let session = cm.session else { return }
      do {
        try handler(session, VimExCommand(params))
      } catch let error as JSException {
        throw error
      } catch {
        throw JSException.error(String(describing: error))
      }
    }
  }

  func defineEx(_ name: String, _ prefixOrNil: String?, _ fn: @escaping ExCommandFn) throws {
    var prefix = prefixOrNil ?? ""
    if prefix.isEmpty {
      prefix = name
    } else if VimText(name).indexOf(VimText(prefix)) != 0 {
      throw JSException.error("(Vim.defineEx) \"\(prefix)\" is not a prefix of \"\(name)\", command not registered")
    }
    exCommands[name] = fn
    exCommandMap[prefix] = ExCommandDefinition(name: name, shortName: prefix, type: .api)
  }

  /// `Vim.defineRegister(name, register)`: a one-character register backed by `register`.
  public func defineRegister(_ name: String, _ register: VimRegister) throws {
    guard name.utf16.count == 1 else { throw JSException.error("Register name must be 1 character") }
    if globalState.registerController.registers[name] != nil { throw JSException.error("Register already defined " + name) }
    globalState.registerController.registers[name] = register
    validRegisters.append(name)
  }

  /// The register `name` (invalid names give the unnamed register), for hosts and tests.
  public func register(_ name: String) -> VimRegister {
    globalState.registerController.getRegister(name)
  }

  /// The registers that exist, by name.
  public var registerNames: [String] { globalState.registerController.registers.keys }

  /// Runs an ex command line (`Vim.handleEx`), e.g. "s/a/b/g" or "%sort".
  public func handleEx(_ input: String, in session: VimSession) throws {
    try exProcessCommand(session.cm, VimText(input))
  }
}

/// An ex command as a `defineEx` handler receives it.
public struct VimExCommand: Sendable {
  /// The whole command line.
  public var input: String
  /// The command name as typed ("w", "wq").
  public var commandName: String
  /// Everything after the command name.
  public var argString: String?
  /// `argString` split on whitespace.
  public var args: [String]
  /// The line range (0-based) when one was given.
  public var line: Int?
  public var lineEnd: Int?

  @MainActor
  init(_ params: ExParams) {
    input = params.input.string
    commandName = params.commandName?.string ?? ""
    argString = params.argString?.string
    args = params.args?.map(\.string) ?? []
    line = params.line
    lineEnd = params.lineEnd
  }
}
