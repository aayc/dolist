import DailyDoListVim
import Foundation

/// The vim behavior vectors recorded from the web app's engine in Chromium
/// (`packages/editor/test/vim/vectors.jsonl`; the format is described in the README next to it).
public struct VimVectorFile: Sendable {
  public let header: VimVectorHeader
  public let cases: [VimVectorCase]

  /// The file in this source tree.
  public static let defaultURL: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // VimVectorFile.swift
    .deletingLastPathComponent()  // DailyDoListVimTestSupport
    .deletingLastPathComponent()  // Sources
    .deletingLastPathComponent()  // DailyDoListVim
    .deletingLastPathComponent()  // Packages
    .deletingLastPathComponent()  // macos
    .deletingLastPathComponent()  // apps
    .appendingPathComponent("packages/editor/test/vim/vectors.jsonl")

  /// Reads and parses a vectors file; nil when it doesn't exist.
  public static func load(from url: URL = defaultURL) throws -> VimVectorFile? {
    guard let data = FileManager.default.contents(atPath: url.path) else { return nil }
    var lines = data.split(separator: UInt8(ascii: "\n"), omittingEmptySubsequences: true)
    guard !lines.isEmpty else { return nil }
    let header = try VimVectorHeader(try VimVectorJSON.parse(lines.removeFirst()))
    var cases: [VimVectorCase] = []
    cases.reserveCapacity(lines.count)
    for (index, line) in lines.enumerated() {
      do {
        cases.append(try VimVectorCase(try VimVectorJSON.parse(line)))
      } catch {
        throw VimVectorFormatError(reason: "line \(index + 2): \(error)")
      }
    }
    return VimVectorFile(header: header, cases: cases)
  }

  /// The names in `exclusions` that no case has any more.
  public func staleExclusions(_ exclusions: some Sequence<String>) -> [String] {
    let names = Set(cases.map(\.name))
    return exclusions.filter { !names.contains($0) }.sorted()
  }
}

public struct VimVectorFormatError: Error, CustomStringConvertible {
  public let reason: String
  public var description: String { "malformed vector: \(reason)" }
}

/// The header: editor defaults and the fixed viewport viewport cases were recorded in.
public struct VimVectorHeader: Sendable {
  public let version: Int
  public let tabSize: Int
  public let indentUnit: String
  /// Visible rows of the oracle's scroller.
  public let rows: Int
  /// The oracle's line height in points.
  public let lineHeight: Double
  /// Optional metrics a newer header may carry (nil: the host's own).
  public let textHeight: Double?
  public let charWidth: Double?

  init(_ json: VimVectorJSON) throws {
    guard json["format"]?.text == "ddl-vim-vectors", let version = json["version"]?.int,
      let tabSize = json["defaults"]?["tabSize"]?.int,
      let indentUnit = json["defaults"]?["indentUnit"]?.text,
      let rows = json["viewport"]?["rows"]?.int,
      let lineHeight = json["viewport"]?["lineHeight"]?.number
    else { throw VimVectorFormatError(reason: "bad header") }
    self.version = version
    self.tabSize = tabSize
    self.indentUnit = indentUnit.string
    self.rows = rows
    self.lineHeight = lineHeight
    textHeight = json["viewport"]?["textHeight"]?.number
    charWidth = json["viewport"]?["charWidth"]?.number
  }
}

/// A register's contents in a case or an expected state.
public struct VimVectorRegister: Equatable, Sendable {
  public let text: VimText
  public let linewise: Bool
  public let blockwise: Bool

  public init(text: VimText, linewise: Bool, blockwise: Bool) {
    self.text = text
    self.linewise = linewise
    self.blockwise = blockwise
  }

  init(_ json: VimVectorJSON) throws {
    guard let text = json["text"]?.text else { throw VimVectorFormatError(reason: "bad register") }
    self.init(
      text: text, linewise: json["linewise"]?.bool ?? false,
      blockwise: json["blockwise"]?.bool ?? false)
  }
}

/// `[line, ch]` (a cursor) or `[anchorLine, anchorCh, headLine, headCh]`.
public typealias VimVectorRange = [Int]

func vectorRanges(_ json: VimVectorJSON?) throws -> [VimVectorRange] {
  guard let list = json?.array else { throw VimVectorFormatError(reason: "bad selection") }
  return try list.map { range in
    guard let values = range.array?.compactMap(\.int), values.count == 2 || values.count == 4 else {
      throw VimVectorFormatError(reason: "bad range")
    }
    return values
  }
}

public struct VimVectorPrompt: Equatable, Sendable {
  public let prefix: VimText
  public let text: VimText
}

/// The README's "Expected state".
public struct VimVectorState: Equatable, Sendable {
  public var doc: VimText
  public var selection: [VimVectorRange]
  public var primary: Int?
  public var mode: String
  public var registers: [String: VimVectorRegister]?
  public var prompt: VimVectorPrompt?
  public var message: VimText?
  public var scrollTop: Int?

  init(
    doc: VimText, selection: [VimVectorRange], primary: Int?, mode: String,
    registers: [String: VimVectorRegister]?,
    prompt: VimVectorPrompt?, message: VimText?, scrollTop: Int?
  ) {
    self.doc = doc
    self.selection = selection
    self.primary = primary
    self.mode = mode
    self.registers = registers
    self.prompt = prompt
    self.message = message
    self.scrollTop = scrollTop
  }

  init(_ json: VimVectorJSON) throws {
    guard let doc = json["doc"]?.text, let mode = json["mode"]?.text else {
      throw VimVectorFormatError(reason: "bad expect")
    }
    self.doc = doc
    selection = try vectorRanges(json["selection"])
    primary = json["primary"]?.int
    self.mode = mode.string
    if let members = json["registers"]?.members {
      var registers: [String: VimVectorRegister] = [:]
      for member in members { registers[member.key] = try VimVectorRegister(member.value) }
      self.registers = registers
    }
    if let prompt = json["prompt"], let prefix = prompt["prefix"]?.text,
      let text = prompt["text"]?.text
    {
      self.prompt = VimVectorPrompt(prefix: prefix, text: text)
    }
    message = json["message"]?.text
    scrollTop = json["scrollTop"]?.int
  }
}

public enum VimVectorAction: Sendable {
  case keys([String])
  case api(op: String, args: [VimVectorJSON])
}

public struct VimVectorStep: Sendable {
  public let action: VimVectorAction
  public let expect: VimVectorState
}

public struct VimVectorCase: Sendable {
  public let name: String
  public let origin: String
  public let doc: VimText
  public let selection: [VimVectorRange]
  public let primary: Int?
  public let tabSize: Int?
  public let indentUnit: String?
  public let vimOptions: [(name: String, value: VimVectorJSON)]
  public let registers: [(name: String, value: VimVectorRegister)]
  public let scrollTop: Int?
  public let steps: [VimVectorStep]

  /// The first path component ("motion", "operator", "upstream"…).
  public var category: String { String(name.prefix { $0 != "/" }) }

  init(_ json: VimVectorJSON) throws {
    guard let name = json["name"]?.text, let origin = json["origin"]?.text,
      let doc = json["doc"]?.text,
      let steps = json["steps"]?.array
    else { throw VimVectorFormatError(reason: "bad case") }
    self.name = name.string
    self.origin = origin.string
    self.doc = doc
    selection = try vectorRanges(json["selection"])
    primary = json["primary"]?.int
    tabSize = json["options"]?["tabSize"]?.int
    indentUnit = json["options"]?["indentUnit"]?.text?.string
    vimOptions = json["vim"]?.members?.map { ($0.key, $0.value) } ?? []
    registers =
      try json["registers"]?.members?.map { ($0.key, try VimVectorRegister($0.value)) } ?? []
    scrollTop = json["scrollTop"]?.int
    self.steps = try steps.map { step in
      guard let expect = step["expect"] else {
        throw VimVectorFormatError(reason: "step without expect")
      }
      if let keys = step["keys"]?.array {
        return VimVectorStep(
          action: .keys(keys.compactMap { $0.text?.string }), expect: try VimVectorState(expect))
      }
      guard let api = step["api"], let op = api["op"]?.text else {
        throw VimVectorFormatError(reason: "bad step")
      }
      return VimVectorStep(
        action: .api(op: op.string, args: api["args"]?.array ?? []),
        expect: try VimVectorState(expect))
    }
  }
}
