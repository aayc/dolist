// `defineAction` and `mapCommand` of vim.js's external API (@replit/codemirror-vim-core 0.1.0,
// MIT, © Marijn Haverbeke and others), for the keys a host adds (the web app's `gt`/`gT`).

/// What a host action receives: the command's arguments and the count typed before it.
public struct VimActionArguments: Sendable {
  /// The `forward` argument the action was mapped with.
  public var forward: Bool
  /// The count (1 when none was typed).
  public var `repeat`: Int
  /// Whether a count was typed (`3gt` rather than `gt`).
  public var repeatIsExplicit: Bool
  /// The register named with `"x` before the command.
  public var registerName: String?
}

extension Vim {
  /// `Vim.defineAction(name, fn)`: an action keys can be mapped to with `mapAction`.
  public func defineAction(
    _ name: String, _ handler: @escaping @MainActor (VimSession, VimActionArguments) throws -> Void
  ) {
    actions[name] = { cm, args, _ in
      guard let session = cm.session else { return }
      try handler(
        session,
        VimActionArguments(
          forward: args.forward, repeat: args.repeat, repeatIsExplicit: args.repeatIsExplicit,
          registerName: args.registerName))
    }
  }

  /// `Vim.mapCommand(keys, "action", name, {forward}, {context})`: maps `keys` to a defined
  /// action in `context` ("normal", "insert", "visual"; nil for all). Like any user mapping it
  /// goes first and `:mapclear` removes it (see `didMapclear`).
  public func mapAction(_ keys: String, action: String, forward: Bool = false, context: String? = nil) {
    let command = VimCommand(keys: VimText(keys), type: .action)
    command.action = action
    command.actionArgs = ActionArgs(forward: forward)
    command.context = context.flatMap(KeyContext.init(rawValue:))
    mapCommand(command)
  }

  /// Puts `register` in place of register `name`, defining the name if needed (the web app backs
  /// `+` and `*` with the system clipboard). `resetGlobalState()` puts the default back.
  public func installRegister(_ name: String, _ register: VimRegister) {
    globalState.registerController.registers[name] = register
    if !validRegisters.contains(name) { validRegisters.append(name) }
  }
}
