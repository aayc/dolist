// Ported from `defineOption`, `setOption` and `getOption` of vim.js (@replit/codemirror-vim-core
// 0.1.0, MIT, © Marijn Haverbeke and others), with its option definitions (filetype, textwidth,
// langmap, pcre, insertModeEscKeysTimeout).

/// Which value of an option to set or read: the editor's (`:setlocal`) or the global one
/// (`:setglobal`). Without a scope, setting changes both and reading prefers the editor's.
public enum VimOptionScope: Sendable {
  case local, global
}

/// The type of an option defined with `Vim.defineOption`.
public enum VimOptionType: String, Sendable {
  case boolean, number, string
}

@MainActor
final class VimOption {
  typealias Kind = VimOptionType

  let kind: Kind
  let defaultValue: VimOptionValue?
  /// Options backed by editor state: called with (value, cm) to set, (nil, cm) to get.
  let callback: ((VimOptionValue?, EditorAdapter?) -> VimOptionValue?)?
  var value: VimOptionValue?

  init(kind: Kind, defaultValue: VimOptionValue?, callback: ((VimOptionValue?, EditorAdapter?) -> VimOptionValue?)?) {
    self.kind = kind
    self.defaultValue = defaultValue
    self.callback = callback
  }
}

/// What `setOption` / `getOption` report instead of a value.
struct OptionError: Error {
  let message: String
}

extension Vim {
  func defineOption(
    _ name: String, _ defaultValue: VimOptionValue?, _ kind: VimOption.Kind, aliases: [String] = [],
    callback: ((VimOptionValue?, EditorAdapter?) -> VimOptionValue?)? = nil
  ) {
    let option = VimOption(kind: kind, defaultValue: defaultValue, callback: callback)
    options[name] = option
    for alias in aliases { options[alias] = option }
    if let defaultValue, defaultValue.isTruthy { _ = setOptionValue(name, defaultValue, nil) }
  }

  /// `setOption(name, value, cm, cfg)`; nil value stands for `undefined`.
  @discardableResult
  func setOptionValue(_ name: String, _ input: VimOptionValue?, _ cm: EditorAdapter?, scope: VimOptionScope? = nil) -> OptionError? {
    guard let option = options[name] else { return OptionError(message: "Unknown option: " + name) }
    var value = input
    if option.kind == .boolean {
      if let v = value, v.isTruthy, v != .bool(true) {
        return OptionError(message: "Invalid argument: " + name + "=" + v.description)
      } else if value != .bool(false) {
        value = .bool(true)
      }
    }
    if let callback = option.callback {
      if scope != .local { _ = callback(value, nil) }
      if scope != .global, let cm { _ = callback(value, cm) }
    } else {
      if scope != .local {
        option.value = option.kind == .boolean ? .bool(value?.isTruthy ?? false) : value
      }
      if scope != .global, let cm, let vim = cm.vim {
        vim.localOptions.values[name] = .some(value)
      }
    }
    return nil
  }

  /// `getOption(name, cm, cfg)`: nil for `undefined`.
  func getOptionValue(_ name: String, _ cm: EditorAdapter? = nil, scope: VimOptionScope? = nil) -> Result<VimOptionValue?, OptionError> {
    guard let option = options[name] else { return .failure(OptionError(message: "Unknown option: " + name)) }
    if let callback = option.callback {
      let local = cm.flatMap { callback(nil, $0) }
      if scope != .global, let local { return .success(local) }
      if scope != .local { return .success(callback(nil, nil)) }
      return .success(nil)
    }
    if scope != .global, let cm, let vim = cm.vim, let local = vim.localOptions.values[name] {
      return .success(local)
    }
    return .success(scope != .local ? option.value : nil)
  }

  /// `getOption(name)` for the options vim.js reads itself.
  func option(_ name: String) -> VimOptionValue? {
    (try? getOptionValue(name).get()) ?? nil
  }

  var pcre: Bool { option("pcre")?.isTruthy ?? false }

  func defineDefaultOptions() {
    defineOption("filetype", nil, .string, aliases: ["ft"]) { name, cm in
      // Proxies CodeMirror's `mode` option, which the adapter doesn't have.
      guard cm != nil else { return nil }
      return nil
    }
    defineOption("textwidth", 80, .number, aliases: ["tw"]) { width, cm in
      guard let cm else { return nil }
      guard let width else { return cm.getOption("textwidth") }
      let column = JSNumber.round(width.numberValue)
      if column > 1 { cm.setOption("textwidth", .number(column)) }
      return nil
    }
    defineOption("langmap", nil, .string, aliases: ["lmap"]) { [unowned self] name, _ in
      guard let name else { return .string(self.langmap.string.string) }
      self.updateLangmap(VimText(name.description))
      return nil
    }
    defineOption("pcre", true, .boolean)
    defineOption("insertModeEscKeysTimeout", 200, .number)
  }
}
