import Foundation

/// vimrc parsing, a port of the web editor's `vimrc.ts`: one ex command per line, `"` comment
/// lines, blank lines, optional leading `:`. Also understood: `let mapleader = "x"` (then
/// `<leader>` in later lines) and Obsidian's `exmap name command` (an ex command alias, typically
/// for `:obcommand`).
enum Vimrc {
  enum Command: Hashable, Sendable {
    case ex(line: Int, input: String)
    case exmap(line: Int, name: String, command: String)

    var line: Int {
      switch self {
      case .ex(let line, _), .exmap(let line, _, _): line
      }
    }
  }

  struct Parsed: Hashable, Sendable {
    var commands: [Command]
    var problems: [VimrcProblem]
  }

  static let defaultLeader = "\\"

  static func parse(_ text: String) -> Parsed {
    var commands: [Command] = []
    var problems: [VimrcProblem] = []
    var leader = defaultLeader
    let lines = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
      .components(separatedBy: "\n")
    for (line, raw) in lines.enumerated() {
      let trimmed = raw.trimmingCharacters(in: .whitespaces)
      if trimmed.isEmpty || trimmed.hasPrefix("\"") { continue }
      let input = String(trimmed.drop { $0 == ":" }).trimmingCharacters(in: .whitespaces)
      if input.isEmpty { continue }
      if input.hasPrefix("let"), input.dropFirst(3).first?.isWhitespace == true {
        if let match = input.wholeMatch(of: /let\s+(?:g:)?mapleader\s*=\s*(["'])(.*)\1/) {
          leader = leaderKeys(String(match.2))
        } else {
          problems.append(VimrcProblem(line: line, message: "Only `let mapleader = …` is supported"))
        }
        continue
      }
      let expanded = input.replacing(/(?i)<leader>/) { _ in leader }
      if let match = expanded.wholeMatch(of: /exmap\s+(\S+)\s+(.+)/) {
        var command = String(match.2)
        if command.hasPrefix(":") { command.removeFirst() }
        commands.append(.exmap(line: line, name: String(match.1), command: command))
      } else if expanded.firstMatch(of: /^exmap\b/) != nil {
        problems.append(VimrcProblem(line: line, message: "exmap needs a name and a command"))
      } else {
        commands.append(.ex(line: line, input: expanded))
      }
    }
    return Parsed(commands: commands, problems: problems)
  }

  /// A leader in key notation: vim reads `<Space>`, not a literal space, in mappings.
  private static func leaderKeys(_ value: String) -> String {
    if value == " " || value.lowercased() == "\\<space>" { return "<Space>" }
    if value == "<" { return "<lt>" }
    return value
  }

  /// Option names a `set` line changes (`set noic`, `setlocal tw=40`, `se clipboard=unnamed`).
  static func optionsSet(by input: String) -> [String] {
    guard let match = input.wholeMatch(of: /(?:se|set|setl|setlocal|setg|setglobal)\s+(.+)/) else { return [] }
    let argument = String(match.1).trimmingCharacters(in: .whitespaces)
    guard let name = argument.prefixMatch(of: /(?:no)?([A-Za-z]\w*)/) else { return [] }
    return [String(name.1)]
  }

  /// Ex-command aliases (`:map :name …`) a vimrc line creates.
  static func exMappings(createdBy command: Command) -> [String] {
    switch command {
    case .exmap(_, let name, _):
      return [":" + name]
    case .ex(_, let input):
      guard let match = input.prefixMatch(of: /(?:map|no|nor|nore|norem|norema|noremap)!?\s+(:\S+)/) else { return [] }
      return [String(match.1)]
    }
  }
}
