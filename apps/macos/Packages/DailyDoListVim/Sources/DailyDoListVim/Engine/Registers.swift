// Ported from `Register`, `RegisterController`, `defineRegister`, `HistoryController` and
// `createInsertModeChanges` of vim.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn
// Haverbeke and others).

/// A recorded key typed in insert mode that isn't text (Backspace, Delete), replayed by `.`.
struct InsertModeKey {
  let keyName: String
  let key: String
  let ctrlKey: Bool
  let altKey: Bool
  let metaKey: Bool
  let shiftKey: Bool
}

/// One entry of the changes insert mode records for `.` and macros.
enum InsertModeChange {
  /// Text typed at the cursor.
  case text(VimText)
  /// `[text]` (replace mode) or `[text, offset]` (inserted with the cursor `offset` before its
  /// end, like an auto-closed bracket pair).
  case textAt(VimText, Int?)
  case key(InsertModeKey)

  /// How JavaScript's `changes.join('')` renders it (the "." register).
  var joinedText: VimText {
    switch self {
    case .text(let t): return t
    case .textAt(let t, let offset): return offset.map { t + VimText("," + String($0)) } ?? t
    case .key: return "[object Object]"
    }
  }
}

/// `InsertModeChanges`: what the current insert session typed.
@MainActor
final class InsertModeChanges {
  var changes: [InsertModeChange] = []
  var expectCursorActivityForChange = false
  var visualBlock = 0
  var ignoreCount: Int?
  var maybeReset = false

  init() {}

  /// `createInsertModeChanges(c)`: copies the change list and the cursor flag only.
  init(copying c: InsertModeChanges) {
    changes = c.changes
    expectCursorActivityForChange = c.expectCursorActivityForChange
  }
}

/// A vim register: text (as a list of pieces, for macros), whether it holds lines or a block,
/// and for macros the insert-mode changes and search queries recorded with the keys.
///
/// Subclass it to back a register with something else (the system clipboard) and install it with
/// `Vim.defineRegister(_:_:)`.
@MainActor
open class VimRegister {
  public internal(set) var keyBuffer: [VimText] = []
  var insertModeChanges: [InsertModeChanges] = []
  var searchQueries: [VimText] = []
  public internal(set) var linewise = false
  public internal(set) var blockwise = false

  public init(text: VimText = VimText(), linewise: Bool = false, blockwise: Bool = false) {
    clear()
    keyBuffer = [text]
    self.linewise = linewise
    self.blockwise = blockwise
  }

  /// Replaces the contents (yank into a register, or an explicit `"a` without append).
  open func setText(_ text: VimText, linewise: Bool = false, blockwise: Bool = false) {
    keyBuffer = [text]
    self.linewise = linewise
    self.blockwise = blockwise
  }

  /// Appends (`"A`, and every key while recording a macro).
  open func pushText(_ text: VimText, linewise: Bool = false) {
    if linewise {
      if !self.linewise { keyBuffer.append("\n") }
      self.linewise = true
    }
    keyBuffer.append(text)
  }

  func pushInsertModeChanges(_ changes: InsertModeChanges) {
    insertModeChanges.append(InsertModeChanges(copying: changes))
  }

  func pushSearchQuery(_ query: VimText) {
    searchQueries.append(query)
  }

  /// Empties the register (`blockwise` stays, like in vim.js).
  open func clear() {
    keyBuffer = []
    insertModeChanges = []
    searchQueries = []
    linewise = false
  }

  /// `toString()`: the text.
  open var text: VimText { keyBuffer.joined() }
}

/// `RegisterController`: every register, and the rules for where yanks and deletes go.
@MainActor
final class RegisterController {
  var registers = JSObjectMap<VimRegister>()
  let unnamedRegister: VimRegister
  unowned let vim: Vim

  init(_ vim: Vim) {
    self.vim = vim
    unnamedRegister = VimRegister()
    registers["\""] = unnamedRegister
    registers["."] = VimRegister()
    registers[":"] = VimRegister()
    registers["/"] = VimRegister()
    registers["+"] = VimRegister()
  }

  /// `pushText(registerName, operator, text, linewise, blockwise)`.
  func pushText(
    _ registerName: String?, _ op: String, _ input: VimText, linewise: Bool = false,
    blockwise: Bool = false
  ) {
    if registerName == "_" { return }
    defer { vim.didPushText?(registerName, linewise, blockwise) }
    var text = input
    if linewise && text.charAt(text.length - 1) != "\n" { text += "\n" }
    let register = isValidRegister(registerName) ? getRegister(registerName) : nil
    guard let register, let name = registerName, !name.isEmpty else {
      switch op {
      case "yank":
        registers["0"] = VimRegister(text: text, linewise: linewise, blockwise: blockwise)
      case "delete", "change":
        if text.indexOf("\n") == -1 {
          registers["-"] = VimRegister(text: text, linewise: linewise)
        } else {
          shiftNumericRegisters()
          registers["1"] = VimRegister(text: text, linewise: linewise)
        }
      default:
        break
      }
      unnamedRegister.setText(text, linewise: linewise, blockwise: blockwise)
      return
    }
    if VimText(name).isUpperCaseLetter {
      register.pushText(text, linewise: linewise)
    } else {
      register.setText(text, linewise: linewise, blockwise: blockwise)
    }
    if name == "+" { vim.clipboard?.writeText(text.string) }
    unnamedRegister.setText(register.text, linewise: linewise)
  }

  /// `getRegister(name)`: creates missing registers; invalid names give the unnamed register.
  func getRegister(_ name: String?) -> VimRegister {
    guard let name, isValidRegister(name) else { return unnamedRegister }
    let lower = VimText(name).toLowerCase().string
    if let register = registers[lower] { return register }
    let register = VimRegister()
    registers[lower] = register
    return register
  }

  func isValidRegister(_ name: String?) -> Bool {
    guard let name, !name.isEmpty else { return false }
    return vim.validRegisters.contains(name) || VimText(name).isLatinChar
  }

  private func shiftNumericRegisters() {
    for i in stride(from: 9, through: 2, by: -1) {
      registers[String(i)] = getRegister(String(i - 1))
    }
  }
}

/// `HistoryController`: the search and ex command histories walked with `<Up>` / `<Down>`.
@MainActor
final class HistoryController {
  var historyBuffer: [VimText] = []
  var iterator = 0
  var initialPrefix: VimText?

  /// `nextMatch(input, up)`: the previous/next entry starting with what was typed.
  func nextMatch(_ input: VimText, _ up: Bool) -> VimText? {
    let dir = up ? -1 : 1
    if initialPrefix == nil { initialPrefix = input }
    var i = iterator + dir
    while up ? i >= 0 : i < historyBuffer.count {
      let element = historyBuffer[i]
      for j in 0...element.length where initialPrefix == element.substring(0, j) {
        iterator = i
        return element
      }
      i += dir
    }
    if i >= historyBuffer.count {
      iterator = historyBuffer.count
      return initialPrefix
    }
    if i < 0 { return input }
    return nil
  }

  func pushInput(_ input: VimText) {
    if let index = historyBuffer.firstIndex(of: input) { historyBuffer.remove(at: index) }
    if !input.isEmpty { historyBuffer.append(input) }
  }

  func reset() {
    initialPrefix = nil
    iterator = historyBuffer.count
  }
}

/// The system clipboard behind the `+` register.
@MainActor
public protocol VimClipboard: AnyObject {
  func writeText(_ text: String)
  func readText() -> String?
}
