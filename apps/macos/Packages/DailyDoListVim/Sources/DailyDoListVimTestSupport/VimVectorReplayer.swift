import DailyDoListVim
import Foundation

/// An editor the vim vectors can be replayed against: a `VimEditor` plus what the replay needs to
/// drive it like the oracle editor.
@MainActor
public protocol VimVectorHost: VimEditor {
  /// Attaches `vim` the way the host normally does (it keeps the session to report its own edits).
  func replayAttach(_ vim: Vim) -> VimSession
  /// Performs the native edit for a token vim left to the editor in insert or replace mode (the
  /// vectors README, rule 2; `VimVectorReplayer.nativeEdit(for:in:)` computes it) as the host's own
  /// edit, reported to `session`. Returns false when the token doesn't edit.
  func replayNativeEdit(_ token: String, in session: VimSession) -> Bool
  /// Completes a layout pass: applies the scrolling requested since the last one (rule 4).
  func replayLayoutPass()
  /// Scrolls so that the 0-based `line` is the first visible line (a case's `scrollTop`).
  func replayScroll(toLine line: Int)
  /// The vertical scroll offset in points; the expected `scrollTop` is `round(offset / lineHeight)`.
  var replayScrollOffset: Double { get }
}

/// What a host is created with for one case.
public struct VimVectorEditorSpec: Sendable {
  public let doc: VimText
  public let tabSize: Int
  public let indentUnit: String
  public let header: VimVectorHeader
  /// The time every transaction of the case happens at, in milliseconds: every vector runs
  /// within CodeMirror's 500 ms undo grouping delay.
  public let clock: Double

  public init(doc: VimText, tabSize: Int, indentUnit: String, header: VimVectorHeader, clock: Double = 1_700_000_000_000) {
    self.doc = doc
    self.tabSize = tabSize
    self.indentUnit = indentUnit
    self.header = header
    self.clock = clock
  }
}

/// The first step of a case whose state differs from what the oracle recorded.
public struct VimVectorMismatch: Sendable {
  public let step: Int
  public let history: [String]
  public let differences: [String]
}

/// Replays vector cases following the README's "How a replay applies a token" (the Swift
/// counterpart of `packages/editor/test/vim/harness/harness.ts`), against any `VimVectorHost`.
@MainActor
public struct VimVectorReplayer {
  public let header: VimVectorHeader

  /// Registers in the snapshot, in this order; `+`/`*` (system clipboard) and `_` never are.
  public static let snapshotRegisters: [String] = {
    var names: [String] = ["\""]
    names += (0...9).map { String($0) }
    names += "abcdefghijklmnopqrstuvwxyz".map { String($0) }
    names += ["-", ".", ":", "/"]
    return names
  }()

  /// A fixed clock: every vector runs within CodeMirror's 500 ms undo grouping delay.
  public static let clock: Double = 1_700_000_000_000

  public init(header: VimVectorHeader) {
    self.header = header
  }

  /// The oracle's native edit for `token` in the editor `session` is attached to: the changes, the
  /// selection afterwards and CodeMirror's user event ("input.type", "delete.backward"…).
  public static func nativeEdit(for token: String, in session: VimSession)
    -> (changes: VimChangeSet, selection: VimSelection, userEvent: String)?
  {
    session.replayNativeEdit(for: token)
  }

  /// Runs `vector` on a host made by `makeHost`; nil when every step matches.
  public func run(_ vector: VimVectorCase, makeHost: (VimVectorEditorSpec) -> any VimVectorHost) -> VimVectorMismatch? {
    let vim = Vim(scheduler: ManualVimScheduler(), isMac: false)
    let spec = VimVectorEditorSpec(
      doc: vector.doc, tabSize: vector.tabSize ?? header.tabSize, indentUnit: vector.indentUnit ?? header.indentUnit,
      header: header, clock: Self.clock)
    let host = makeHost(spec)
    let session = host.replayAttach(vim)
    defer { session.detach() }
    host.replayLayoutPass()
    session.replaySetSelections(vector.selection.map(Self.range), primary: vector.primary ?? 0)
    for (name, value) in vector.vimOptions {
      try? vim.setOption(name, Self.optionValue(value), in: session)
    }
    for (name, register) in vector.registers {
      vim.register(name).setText(register.text, linewise: register.linewise, blockwise: register.blockwise)
    }
    if let top = vector.scrollTop {
      host.replayScroll(toLine: top)
    } else {
      host.vimScrollIntoView(nil)
    }
    host.replayLayoutPass()
    var history: [String] = []
    for (index, step) in vector.steps.enumerated() {
      session.replayClearLastMessage()
      switch step.action {
      case .keys(let keys):
        history.append(keys.joined(separator: " "))
        for token in keys {
          session.handleKey(token, nativeEdit: { host.replayNativeEdit(token, in: session) })
          host.replayLayoutPass()
        }
      case .api(let op, let args):
        history.append("api \(op)")
        do {
          try applyApi(op, args, vim: vim, session: session)
        } catch {
          return VimVectorMismatch(step: index, history: history, differences: ["api \(op) threw \(error)"])
        }
        host.replayLayoutPass()
      }
      let actual = snapshot(host, session, viewport: vector.scrollTop != nil)
      let differences = Self.differences(expected: step.expect, actual: actual)
      if !differences.isEmpty { return VimVectorMismatch(step: index, history: history, differences: differences) }
    }
    return nil
  }

  private func applyApi(_ op: String, _ args: [VimVectorJSON], vim: Vim, session: VimSession) throws {
    func arg(_ i: Int) -> VimVectorJSON? { i < args.count ? args[i] : nil }
    func string(_ i: Int) -> String? { arg(i)?.text?.string }
    func pos(_ value: VimVectorJSON?) -> VimPosition? {
      guard let values = value?.array?.compactMap(\.int), values.count == 2 else { return nil }
      return VimPosition(line: values[0], ch: values[1])
    }
    switch op {
    case "setCursor":
      session.replaySetCursor(line: arg(0)?.int ?? 0, ch: arg(1)?.int ?? 0)
    case "setSelections":
      session.replaySetSelections(try vectorRanges(arg(0)).map(Self.range), primary: arg(1)?.int ?? 0)
    case "setValue":
      session.replaySetValue(arg(0)?.text ?? VimText())
    case "replaceRange":
      try session.replayReplaceRange(arg(0)?.text ?? VimText(), from: pos(arg(1)) ?? VimPosition(line: 0, ch: 0), to: pos(arg(2)))
    case "setOption":
      session.replaySetEditorOption(string(0) ?? "", arg(1).flatMap(Self.optionValue))
    case "vimSetOption":
      try? vim.setOption(string(0) ?? "", arg(1).flatMap(Self.optionValue))
    case "map":
      try vim.map(string(0) ?? "", string(1) ?? "", context: string(2))
    case "noremap":
      try vim.noremap(string(0) ?? "", string(1) ?? "", context: string(2))
    case "unmap":
      _ = try vim.unmap(string(0) ?? "", context: string(1))
    case "mapclear":
      vim.mapclear(context: string(0))
    case "setRegister":
      vim.register(string(0) ?? "").setText(arg(1)?.text ?? VimText(), linewise: arg(2)?.bool ?? false, blockwise: arg(3)?.bool ?? false)
    case "pushText":
      vim.replayPushText(string(0), string(1) ?? "", arg(2)?.text ?? VimText(), linewise: arg(3)?.bool ?? false, blockwise: arg(4)?.bool ?? false)
    case "ex":
      try vim.handleEx(string(0) ?? "", in: session)
    default:
      throw VimVectorFormatError(reason: "unknown api op \(op)")
    }
  }

  /// The README's "Expected state" of the host.
  private func snapshot(_ host: any VimVectorHost, _ session: VimSession, viewport: Bool) -> VimVectorState {
    let ranges = session.selections.map { range -> VimVectorRange in
      range.anchor == range.head
        ? [range.anchor.line, range.anchor.ch] : [range.anchor.line, range.anchor.ch, range.head.line, range.head.ch]
    }
    var registers: [String: VimVectorRegister] = [:]
    for name in Self.snapshotRegisters {
      guard let register = session.vim.replayExistingRegister(name), !register.text.isEmpty else { continue }
      registers[name] = VimVectorRegister(text: register.text, linewise: register.linewise, blockwise: register.blockwise)
    }
    var doc: [UInt16] = []
    for line in 0..<host.vimLineCount {
      if line > 0 { doc.append(0x0A) }
      doc.append(contentsOf: host.vimLine(line).units)
    }
    return VimVectorState(
      doc: VimText(units: doc),
      selection: ranges,
      primary: ranges.count > 1 ? session.replayMainIndex : nil,
      mode: session.mode.rawValue,
      registers: registers.isEmpty ? nil : registers,
      prompt: session.activePrompt.map { VimVectorPrompt(prefix: VimText($0.text), text: $0.value) },
      message: session.lastMessage.map { VimText($0) },
      scrollTop: viewport ? Int((host.replayScrollOffset / header.lineHeight + 0.5).rounded(.down)) : nil)
  }

  public static func range(_ range: VimVectorRange) -> VimRange {
    range.count == 2
      ? VimRange(cursor: VimPosition(line: range[0], ch: range[1]))
      : VimRange(anchor: VimPosition(line: range[0], ch: range[1]), head: VimPosition(line: range[2], ch: range[3]))
  }

  public static func optionValue(_ json: VimVectorJSON) -> VimOptionValue? {
    switch json {
    case .bool(let value): .bool(value)
    case .number(let value): .number(value)
    case .string(let value): .string(value.string)
    default: nil
    }
  }

  /// Field-by-field differences, empty when the states match.
  public static func differences(expected: VimVectorState, actual: VimVectorState) -> [String] {
    var out: [String] = []
    if expected.doc != actual.doc {
      out.append("doc: expected \(quote(expected.doc))\n       actual \(quote(actual.doc))")
    }
    if expected.selection != actual.selection || expected.primary != actual.primary {
      out.append(
        "selection: expected \(expected.selection)\(expected.primary.map { " primary \($0)" } ?? "") actual \(actual.selection)\(actual.primary.map { " primary \($0)" } ?? "")"
      )
    }
    if expected.mode != actual.mode { out.append("mode: expected \(expected.mode) actual \(actual.mode)") }
    if expected.registers != actual.registers {
      let names = Set((expected.registers ?? [:]).keys).union((actual.registers ?? [:]).keys)
      for name in snapshotRegisters where names.contains(name) {
        let e = expected.registers?[name], a = actual.registers?[name]
        if e != a { out.append("register \(name): expected \(describe(e)) actual \(describe(a))") }
      }
    }
    if expected.prompt != actual.prompt {
      out.append("prompt: expected \(describe(expected.prompt)) actual \(describe(actual.prompt))")
    }
    if expected.message != actual.message {
      out.append("message: expected \(expected.message.map(quote) ?? "none") actual \(actual.message.map(quote) ?? "none")")
    }
    if expected.scrollTop != actual.scrollTop {
      out.append("scrollTop: expected \(expected.scrollTop.map(String.init) ?? "none") actual \(actual.scrollTop.map(String.init) ?? "none")")
    }
    return out
  }

  private static func describe(_ register: VimVectorRegister?) -> String {
    guard let register else { return "empty" }
    return quote(register.text) + (register.linewise ? " linewise" : "") + (register.blockwise ? " blockwise" : "")
  }

  private static func describe(_ prompt: VimVectorPrompt?) -> String {
    guard let prompt else { return "none" }
    return "\(quote(prompt.prefix)) \(quote(prompt.text))"
  }

  /// A JSON-style quoted string (lone surrogates as `\u` escapes).
  public static func quote(_ text: VimText) -> String {
    var out = "\""
    var i = 0
    let units = text.units
    func isHigh(_ u: UInt16) -> Bool { u >= 0xD800 && u < 0xDC00 }
    func isLow(_ u: UInt16) -> Bool { u >= 0xDC00 && u < 0xE000 }
    while i < units.count {
      let u = units[i]
      if isHigh(u), i + 1 < units.count, isLow(units[i + 1]) {
        out += String(decoding: units[i...(i + 1)], as: UTF16.self)
        i += 2
        continue
      }
      switch u {
      case 0x22: out += "\\\""
      case 0x5C: out += "\\\\"
      case 0x0A: out += "\\n"
      case 0x09: out += "\\t"
      case 0x0D: out += "\\r"
      case 0..<0x20, 0xD800...0xDFFF:
        let hex = String(u, radix: 16)
        out += "\\u" + String(repeating: "0", count: max(0, 4 - hex.count)) + hex
      default: out += String(decoding: [u], as: UTF16.self)
      }
      i += 1
    }
    return out + "\""
  }
}
