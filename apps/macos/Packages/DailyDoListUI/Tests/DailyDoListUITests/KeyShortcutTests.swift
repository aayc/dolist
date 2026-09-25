import Testing

@testable import DailyDoListUI

@Suite("Keycaps")
struct KeyShortcutTests {
  @Test func modifiersComeInAppleOrderThenTheKey() {
    let all = KeyShortcut("d", [.command, .shift, .option, .control])
    #expect(all.caps == ["⌃", "⌥", "⇧", "⌘", "D"])
    #expect(all.display == "⌃⌥⇧⌘D")
    #expect(KeyShortcut("d", [.shift, .command]).caps == ["⇧", "⌘", "D"])
    #expect(KeyShortcut("n", .command).display == "⌘N")
  }

  @Test func specialKeysHaveTheirGlyphs() {
    #expect(KeyShortcut("\t", [.control]).caps == ["⌃", "⇥"])
    #expect(KeyShortcut.returnKey.caps == ["↩"])
    #expect(KeyShortcut.shiftReturn.caps == ["⇧", "↩"])
    #expect(KeyShortcut.commandReturn.caps == ["⌘", "↩"])
    #expect(KeyShortcut.escapeKey.caps == ["⎋"])
    #expect(KeyShortcut(.delete).caps == ["⌫"])
    let arrows: [KeyShortcut.Key] = [.leftArrow, .rightArrow, .upArrow, .downArrow]
    #expect(arrows.map(\.cap) == ["←", "→", "↑", "↓"])
    #expect(KeyShortcut(.space, .control).caps == ["⌃", "Space"])
    #expect(KeyShortcut(.function(5)).caps == ["F5"])
  }

  @Test func punctuationStaysAsTyped() {
    #expect(KeyShortcut("\\", .command).caps == ["⌘", "\\"])
    #expect(KeyShortcut("[", .command).display == "⌘[")
    #expect(KeyShortcut("+", .command).display == "⌘+")
  }

  @Test func voiceOverHearsWords() {
    #expect(KeyShortcut("d", [.command, .shift]).spokenDescription == "Shift-Command-D")
    #expect(KeyShortcut("[", .command).spokenDescription == "Command-Left Bracket")
    #expect(KeyShortcut.shiftReturn.spokenDescription == "Shift-Return")
    #expect(KeyShortcut("\t", [.control, .shift]).spokenDescription == "Control-Shift-Tab")
  }

  @Test func multilineTextSplitsIntoLabelAndDetail() throws {
    let content = try #require(
      TooltipContent(multilineText: "Sole — booking\nsole.example\nhttps://sole.example/book"))
    #expect(content.lines == [TooltipContent.Line("Sole — booking")])
    #expect(content.detail?.contains("sole.example") == true)
    #expect(content.plainText == "Sole — booking\nsole.example\nhttps://sole.example/book")
    #expect(TooltipContent(multilineText: "Ideas")?.detail == nil)
    #expect(TooltipContent(multilineText: "  ") == nil)
  }

  @Test func pathsMayWrapAfterTheirSlashes() {
    let content = TooltipContent.path("Projects/2026/Launch Plan.md")
    #expect(content.lines.first?.text == "Projects/\u{200B}2026/\u{200B}Launch Plan.md")
    #expect(content.plainText == "Projects/2026/Launch Plan.md")
  }
}
