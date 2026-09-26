import AppKit
import DailyDoListVim

/// Vim mode as the app ships it, installed once on the app's `Vim` (a port of the web editor's
/// `vim-integration.ts`): ex commands mapped to app requests (`MarkdownEditorDelegate.editor(_:
/// perform:)`), `gt`/`gT`, the system clipboard as the `+` and `*` registers and `set
/// clipboard=unnamed`, and the vimrc. Everything acts on the editor vim passes in, so every
/// window's editor shares it.
@MainActor
public final class EditorVimIntegration {
  public let vim: Vim
  let clipboard: VimSystemClipboard
  let clipboardRegister: PasteboardRegister
  /// Lines of the vimrc vim rejected when it was last applied.
  public private(set) var vimrcProblems: [VimrcProblem] = []
  private var appliedVimrc = ""
  private var vimrcExMappings: [String] = []
  /// Values options had before any vimrc changed them, restored when the vimrc changes.
  private var optionBaseline: [String: VimOptionValue?] = [:]
  /// The editor the vimrc runs its commands in (their messages stay out of the notes' panels).
  private let scratch = VimTextBuffer()
  private lazy var scratchSession = scratch.attach(to: vim)

  private struct Installed {
    weak var integration: EditorVimIntegration?
  }

  private static var installed: [ObjectIdentifier: Installed] = [:]

  /// Installs the integration on `vim` (call once per app; the clipboard registers read and write
  /// `pasteboard`). Keep it as long as `vim` is used: once it's released, the commands and hooks
  /// it installed do nothing.
  public init(vim: Vim, pasteboard: NSPasteboard = .general) {
    self.vim = vim
    clipboard = VimSystemClipboard(pasteboard: pasteboard)
    clipboardRegister = PasteboardRegister(clipboard: clipboard)
    vim.isMac = true
    defineExCommands()
    defineAppKeys()
    installClipboard()
    Self.installed = Self.installed.filter { $0.value.integration != nil }
    Self.installed[ObjectIdentifier(vim)] = Installed(integration: self)
  }

  /// The Ctrl keys a vimrc mapping claims for `vim` (see `VimCtrlKeys`).
  static func mappedCtrlKeys(for vim: Vim) -> Set<String> {
    installed[ObjectIdentifier(vim)]?.integration?.mappedCtrlKeys ?? []
  }

  private var mappedCtrlKeys: Set<String> = []

  // MARK: Ex commands

  private func defineExCommands() {
    // The `Vim` keeps these handlers; they do nothing once the integration is gone.
    func define(
      _ name: String, _ prefix: String,
      _ handler: @escaping @MainActor (EditorVimIntegration, VimSession, VimExCommand) -> Void
    ) {
      try? vim.defineEx(name, prefix) { [weak self] session, command in
        if let self { handler(self, session, command) }
      }
    }
    define("write", "w") { app, session, _ in app.save(session) }
    define("wall", "wa") { app, session, _ in app.request(.saveAll, in: session, command: "wall") }
    define("quit", "q") { app, session, _ in app.close(session, all: false) }
    define("qall", "qa") { app, session, _ in app.close(session, all: true) }
    define("wq", "wq") { app, session, _ in app.saveAndClose(session) }
    define("xit", "x") { app, session, _ in app.saveAndClose(session) }
    define("wqall", "wqa") { app, session, _ in app.saveAllAndClose(session) }
    define("xall", "xa") { app, session, _ in app.saveAllAndClose(session) }
    define("edit", "e") { app, session, command in app.open(session, command, newTab: false) }
    define("tabedit", "tabe") { app, session, command in app.open(session, command, newTab: true) }
    define("tabnew", "tabnew") { app, session, command in app.open(session, command, newTab: true) }
    define("tabclose", "tabc") { app, session, _ in app.close(session, all: false) }
    define("tabnext", "tabn") { app, session, command in
      app.switchTab(session, command, forward: true)
    }
    define("tabprevious", "tabp") { app, session, command in
      app.switchTab(session, command, forward: false)
    }
    define("tabNext", "tabN") { app, session, command in
      app.switchTab(session, command, forward: false)
    }
    define("bnext", "bn") { app, session, command in app.switchTab(session, command, forward: true)
    }
    define("bprevious", "bp") { app, session, command in
      app.switchTab(session, command, forward: false)
    }
    define("bNext", "bN") { app, session, command in app.switchTab(session, command, forward: false)
    }
    define("bdelete", "bd") { app, session, _ in app.close(session, all: false) }
    // Obsidian's name, so vimrc lines like `exmap back obcommand …` carry over.
    define("obcommand", "obcommand") { app, session, command in app.runCommand(session, command) }
  }

  private func close(_ session: VimSession, all: Bool) {
    request(.close(all: all), in: session, command: all ? "qall" : "quit")
  }

  private func saveAndClose(_ session: VimSession) {
    save(session)
    close(session, all: false)
  }

  private func saveAllAndClose(_ session: VimSession) {
    request(.saveAll, in: session, command: "wall")
    close(session, all: true)
  }

  private func open(_ session: VimSession, _ command: VimExCommand, newTab: Bool) {
    let target = Self.argument(command)
    request(
      .openNote(target.isEmpty ? nil : target, newTab: newTab), in: session,
      command: newTab ? "tabedit" : "edit")
  }

  private func runCommand(_ session: VimSession, _ command: VimExCommand) {
    let id = Self.argument(command)
    guard !id.isEmpty else { return session.notify("Usage: :obcommand <command id>") }
    if request(.runCommand(id), in: session, command: "obcommand") == .failed {
      session.notify("No command \(id)")
    }
  }

  /// `:tabnext 3` goes to tab 3; `:tabprevious 2` goes back two.
  private func switchTab(_ session: VimSession, _ command: VimExCommand, forward: Bool) {
    let count = Int(Self.argument(command).prefix { $0.isASCII && $0.isNumber }) ?? 0
    let to: EditorTabSwitch =
      count > 0 ? (forward ? .index(count - 1) : .delta(-count)) : .delta(forward ? 1 : -1)
    request(.switchTab(to), in: session, command: "tabnext")
  }

  private func save(_ session: VimSession) {
    guard let controller = Self.controller(of: session) else { return }
    controller.delegate?.editorDidRequestSave(controller)
  }

  /// Asks the editor's host; tells the user when it can't be done here.
  @discardableResult
  private func request(_ request: EditorVimRequest, in session: VimSession, command: String)
    -> EditorVimRequestResult
  {
    let result =
      Self.controller(of: session).map { controller in
        controller.delegate?.editor(controller, perform: request) ?? .unavailable
      } ?? .unavailable
    if result == .unavailable { session.notify(":\(command) isn't available here") }
    return result
  }

  static func controller(of session: VimSession) -> MarkdownEditorController? {
    (session.editor as? TextViewVimHost)?.controller
  }

  static func argument(_ command: VimExCommand) -> String {
    var text = command.argString ?? ""
    if text.hasPrefix("!") { text.removeFirst() }
    return text.trimmingCharacters(in: .whitespaces)
  }

  // MARK: gt / gT

  private func defineAppKeys() {
    vim.defineAction("ddlSwitchTab") { [weak self] session, args in
      let to: EditorTabSwitch =
        args.forward
        ? (args.repeatIsExplicit ? .index(args.repeat - 1) : .delta(1))
        : .delta(-max(args.repeat, 1))
      self?.request(.switchTab(to), in: session, command: args.forward ? "tabnext" : "tabprevious")
    }
    mapAppKeys()
    // `:mapclear` (and a vimrc change) clears every mapping, including the app's own keys.
    vim.didMapclear = { [weak self] context in
      guard let self else { return }
      if context == nil || context == "normal" { mapAppKeys() }
      if context == nil { mappedCtrlKeys = [] }
    }
  }

  private func mapAppKeys() {
    vim.mapAction("gt", action: "ddlSwitchTab", forward: true, context: "normal")
    vim.mapAction("gT", action: "ddlSwitchTab", forward: false, context: "normal")
  }

  // MARK: Clipboard

  private func installClipboard() {
    try? vim.defineOption("clipboard", defaultValue: .string(""), type: .string)
    vim.installRegister("+", clipboardRegister)
    vim.installRegister("*", clipboardRegister)
    // `set clipboard=unnamed(plus)`: `p` pastes what another app copied…
    vim.unnamedPasteRegister = { [weak self] session in
      guard let self, Self.mirrorsUnnamed(try? vim.getOption("clipboard", in: session)) else {
        return nil
      }
      return clipboardRegister
    }
    // …and whatever goes to the unnamed register also goes to the system clipboard.
    vim.didPushText = { [weak self] name, linewise, blockwise in
      guard let self, name == nil || name == "\"",
        Self.mirrorsUnnamed(try? vim.getOption("clipboard"))
      else { return }
      clipboard.write(
        .init(text: vim.register("\"").text.string, linewise: linewise, blockwise: blockwise))
    }
  }

  /// Whether a `clipboard` option value mirrors the unnamed register (`unnamed`, `unnamedplus`).
  static func mirrorsUnnamed(_ value: VimOptionValue??) -> Bool {
    guard case .string(let text)?? = value else { return false }
    return text.split(separator: ",").contains { $0 == "unnamed" || $0 == "unnamedplus" }
  }

  // MARK: vimrc

  /// Applies `text` as the vimrc (when it differs from the one applied): clears mappings and ex
  /// aliases a previous vimrc made, restores options it changed, then runs each line. Returns the
  /// lines vim rejected, with its message. The `:` register (last ex command) isn't touched.
  @discardableResult
  public func applyVimrc(_ text: String) -> [VimrcProblem] {
    guard text != appliedVimrc else { return vimrcProblems }
    let session = scratchSession
    vim.mapclear()
    for lhs in vimrcExMappings { _ = try? vim.unmap(lhs, context: "") }
    vimrcExMappings = []
    for (name, value) in optionBaseline { try? vim.setOption(name, value, in: session) }

    let parsed = Vimrc.parse(text)
    var problems = parsed.problems
    let lastEx = vim.register(":")
    let lastExText = lastEx.text
    for command in parsed.commands {
      let notified = scratch.notifications.count
      var message: String?
      do {
        switch command {
        case .exmap(_, let name, let exCommand):
          try vim.map(":" + name, ":" + exCommand, context: "")
        case .ex(_, let input):
          for name in Vimrc.optionsSet(by: input) where optionBaseline[name] == nil {
            do {
              let value = try vim.getOption(name)
              optionBaseline[name] = .some(value)
            } catch {}
          }
          try vim.handleEx(input, in: session)
          if let mapping = input.prefixMatch(of: /(\w*map|\w*noremap)!?\s+(\S+)/) {
            noteMapping(String(mapping.2), insert: mapping.1.hasPrefix("i"))
          }
        }
        vimrcExMappings += Vimrc.exMappings(createdBy: command)
      } catch let error as JSException {
        message = error.message
      } catch {
        message = String(describing: error)
      }
      if message == nil, scratch.notifications.count > notified {
        message = scratch.notifications.last
      }
      if let message { problems.append(VimrcProblem(line: command.line, message: message)) }
    }
    lastEx.setText(lastExText)
    appliedVimrc = text
    vimrcProblems = problems.sorted { $0.line < $1.line }
    return vimrcProblems
  }

  private func noteMapping(_ lhs: String, insert: Bool) {
    guard !insert else { return }
    for key in VimCtrlKeys.ctrlKeys(of: lhs) { mappedCtrlKeys.insert(key) }
  }
}
