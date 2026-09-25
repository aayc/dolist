import Foundation
import Testing

@testable import DailyDoListComputer

/// The TypeScript key tables this port must match, when the package sits in its repository.
private let typeScriptKeys: URL? = {
  var folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  for _ in 0..<10 {
    let file = folder.appendingPathComponent("packages/agent/src/execution/local/computer-keys.ts")
    if FileManager.default.fileExists(atPath: file.path) { return file }
    folder.deleteLastPathComponent()
  }
  return nil
}()

@Suite("Key combos")
struct KeyComboTests {
  let cmd: UInt64 = 0x10_0000
  let shift: UInt64 = 0x2_0000
  let ctrl: UInt64 = 0x4_0000
  let alt: UInt64 = 0x8_0000

  // The same cases as computer.test.ts.
  @Test func parsesModifiersAndKeys() throws {
    #expect(
      try KeyCombo.parse("cmd+shift+4")
        == KeyCombo(modifiers: [.cmd, .shift], key: "4", code: 21, flags: cmd | shift))
    #expect(
      try KeyCombo.parse("Enter") == KeyCombo(modifiers: [], key: "enter", code: 36, flags: 0))
    let delete = try KeyCombo.parse("ctrl+alt+delete")
    #expect(delete.code == 51 && delete.flags == ctrl | alt)
    let copy = try KeyCombo.parse("Command-C")
    #expect(copy.modifiers == [.cmd] && copy.key == "c" && copy.code == 8)
    let left = try KeyCombo.parse("option + left")
    #expect(left.modifiers == [.alt] && left.code == 123)
    #expect(try KeyCombo.parse("F12").code == 111)
    #expect(try KeyCombo.parse("esc").code == 53)
    #expect(try KeyCombo.parse("cmd+,").code == 43)
    #expect(try KeyCombo.parse("-").code == 27)
    #expect(try KeyCombo.parse("cmd-shift-4").flags == cmd | shift)
    #expect(
      try KeyCombo.parse("cmd--") == KeyCombo(modifiers: [.cmd], key: "-", code: 27, flags: cmd))
    #expect(try KeyCombo.parse("cmd k").code == 40)
    #expect(try KeyCombo.parse("shift+shift+tab").modifiers == [.shift])
  }

  @Test func mapsPlusToShiftAndEqual() throws {
    let plus = try KeyCombo.parse("cmd++")
    #expect(plus.modifiers == [.cmd, .shift] && plus.code == 24)
    #expect(try KeyCombo.parse("cmd+plus").flags == cmd | shift)
    #expect(try KeyCombo.parse("+").modifiers == [.shift])
  }

  @Test(arguments: ["", "cmd", "ctrl+shift", "cmd+a+b", "hyper+a", "cmd+banana", "cmd++a", "  "])
  func rejects(combo: String) {
    #expect(throws: KeyComboError.self) { try KeyCombo.parse(combo) }
  }

  @Test func explainsWhatWentWrong() {
    #expect(throws: KeyComboError("Invalid key combo: \"\"")) { try KeyCombo.parse("") }
    #expect(
      throws: KeyComboError(
        "Invalid key combo \"cmd+a+b\": use modifiers (cmd, ctrl, alt, shift, fn) plus exactly one key."
      )
    ) { try KeyCombo.parse("cmd+a+b") }
    #expect(
      throws: KeyComboError(
        "Unknown key \"banana\" in \"cmd+banana\". Use letters, digits, punctuation, return, tab, "
          + "space, escape, delete, arrows, home/end, pageup/pagedown or f1–f12.")
    ) { try KeyCombo.parse("cmd+banana") }
  }

  @Test func pressesModifiersInOrderAndReleasesThemInReverse() throws {
    #expect(
      try KeyCombo.parse("cmd+shift+4").events == [
        KeyEventStep(code: 55, down: true, flags: cmd),
        KeyEventStep(code: 56, down: true, flags: cmd | shift),
        KeyEventStep(code: 21, down: true, flags: cmd | shift),
        KeyEventStep(code: 21, down: false, flags: cmd | shift),
        KeyEventStep(code: 56, down: false, flags: cmd),
        KeyEventStep(code: 55, down: false, flags: 0),
      ])
    #expect(
      try KeyCombo.parse("tab").events == [
        KeyEventStep(code: 48, down: true, flags: 0), KeyEventStep(code: 48, down: false, flags: 0),
      ])
  }

  @Test(.enabled(if: typeScriptKeys != nil))
  func matchesTheTypeScriptTables() throws {
    let source = try String(contentsOf: try #require(typeScriptKeys), encoding: .utf8)

    let keycodes = try entries(in: source, after: "const KEYCODES: Record<string, number> = {")
    let letters = try #require(
      source.firstMatch(of: /const LETTERS = "([^"]+)"/).map { String($0.output.1) })
    var expected: [String: UInt16] = [:]
    for (name, value) in keycodes { expected[name] = UInt16(value) }
    for (index, letter) in letters.enumerated() where letter != "?" {
      expected[String(letter)] = UInt16(index)
    }
    #expect(KeyCombo.keyCodes == expected)
    for name in expected.keys {
      #expect((try? KeyCombo.parse(name))?.code == expected[name], "\(name)")
    }

    let aliases = try entries(
      in: source, after: "const MODIFIER_ALIASES: Record<string, ModifierName> = {")
    #expect(
      KeyCombo.modifierAliases.mapValues(\.rawValue)
        == Dictionary(uniqueKeysWithValues: aliases.map { ($0.0, $0.1) }))

    for modifier in KeyCombo.Modifier.allCases {
      let pattern = try Regex(
        "\(modifier.rawValue): \\{ code: (\\d+), flag: 0x([0-9a-f]+) \\}")
      let match = try #require(source.firstMatch(of: pattern), "\(modifier)")
      #expect(match.output[1].substring.map(String.init) == String(modifier.keyCode))
      #expect(
        match.output[2].substring.flatMap { UInt64($0, radix: 16) } == modifier.flag, "\(modifier)")
    }
  }

  /// `name: value,` lines of the object literal that starts after `header`. Names may be quoted
  /// (with `\\` escapes); values are numbers or quoted strings.
  private func entries(in source: String, after header: String) throws -> [(String, String)] {
    let start = try #require(source.range(of: header)).upperBound
    let end = try #require(source[start...].range(of: "\n};")).lowerBound
    return try source[start..<end].split(separator: "\n").compactMap { rawLine in
      let line = rawLine.trimmingCharacters(in: .whitespaces)
      guard !line.isEmpty else { return nil }
      let match = try #require(
        line.wholeMatch(of: /(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_]+)): *(?:(\d+)|"([^"]*)"),?/),
        "unexpected line: \(line)")
      let name =
        match.output.1.map { $0.replacingOccurrences(of: "\\\\", with: "\\") }
        ?? String(match.output.2 ?? "")
      let value = match.output.3.map(String.init) ?? String(match.output.4 ?? "")
      return (String(name), value)
    }
  }
}

@Suite("Typing and scrolling plans")
struct InputPlanTests {
  @Test func eachLineBreakIsOneReturnAndATabIsTab() {
    #expect(
      TypingPlan.steps(for: "hi\r\nthere\tyou\n") == [
        .text("hi"), .key(36), .text("there"), .key(48), .text("you"), .key(36),
      ])
    #expect(
      TypingPlan.steps(for: "a\r\rb\n\nc\r\n\r\n") == [
        .text("a"), .key(36), .key(36), .text("b"), .key(36), .key(36), .text("c"), .key(36),
        .key(36),
      ])
    #expect(TypingPlan.steps(for: "\t\t") == [.key(48), .key(48)])
    #expect(TypingPlan.steps(for: "") == [])
  }

  @Test func chunksTextWithoutSplittingCharacters() {
    #expect(
      TypingPlan.steps(for: String(repeating: "a", count: 19) + "😀b") == [
        .text(String(repeating: "a", count: 19)), .text("😀b"),
      ])
    let emoji = String(repeating: "😀", count: 30)
    let chunks = TypingPlan.steps(for: emoji).compactMap { step -> String? in
      if case .text(let chunk) = step { return chunk }
      return nil
    }
    #expect(chunks.allSatisfy { $0.utf16.count <= 20 })
    #expect(chunks.joined() == emoji)

    let family = "👨‍👩‍👧‍👦"
    #expect(TypingPlan.steps(for: family + family) == [.text(family), .text(family)])

    let zalgo = "e" + String(repeating: "\u{0301}", count: 30)
    let pieces = TypingPlan.steps(for: zalgo)
    #expect(pieces.count == 2)
    #expect(
      pieces.map { step -> String in
        if case .text(let chunk) = step { return chunk }
        return ""
      }.joined() == zalgo)
  }

  @Test func scrollsInWheelEventsOfAtMostTenLines() {
    let steps = { (dx: Int, dy: Int) in ScrollPlan.steps(dx: dx, dy: dy).map { [$0.dx, $0.dy] } }
    #expect(steps(0, 25) == [[0, -10], [0, -10], [0, -5]])
    #expect(steps(-3, 0) == [[3, 0]])
    #expect(steps(12, -4) == [[-10, 4], [-2, 0]])
    #expect(steps(0, 0) == [])
    #expect(ScrollPlan.steps(dx: 0, dy: 1_000).map(\.dy).reduce(0, +) == -200)
  }
}
