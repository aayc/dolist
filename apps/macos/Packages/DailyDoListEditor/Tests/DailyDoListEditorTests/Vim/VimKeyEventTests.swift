import AppKit
import DailyDoListVim
import Testing

@testable import DailyDoListEditor

/// `NSEvent` → vim key: named keys by key code, characters vs. characters ignoring modifiers,
/// modifiers, and the physical key for non-Latin layouts.
@MainActor
@Suite("Vim key events")
struct VimKeyEventTests {
  private func event(
    keyCode: UInt16, characters: String, ignoring: String? = nil, flags: NSEvent.ModifierFlags = [],
    isRepeat: Bool = false
  ) -> NSEvent {
    NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: 0,
      context: nil,
      characters: characters, charactersIgnoringModifiers: ignoring ?? characters,
      isARepeat: isRepeat, keyCode: keyCode)!
  }

  private func vimKey(_ event: NSEvent) -> String? {
    VimKeyEvents.input(for: event).flatMap { VimKeyNotation.vimKey(for: $0, isMac: true) }
  }

  @Test func namedKeysComeFromTheKeyCode() {
    #expect(vimKey(event(keyCode: 53, characters: "\u{1b}")) == "<Esc>")
    #expect(vimKey(event(keyCode: 36, characters: "\r")) == "<CR>")
    #expect(vimKey(event(keyCode: 76, characters: "\u{3}")) == "<CR>")
    #expect(vimKey(event(keyCode: 51, characters: "\u{7f}")) == "<BS>")
    #expect(vimKey(event(keyCode: 117, characters: "\u{F728}")) == "<Del>")
    #expect(vimKey(event(keyCode: 48, characters: "\t")) == "<Tab>")
    #expect(vimKey(event(keyCode: 48, characters: "\u{19}", flags: .shift)) == "<S-Tab>")
    #expect(
      vimKey(event(keyCode: 123, characters: "\u{F702}", flags: [.numericPad, .function]))
        == "<Left>")
    #expect(vimKey(event(keyCode: 124, characters: "\u{F703}")) == "<Right>")
    #expect(vimKey(event(keyCode: 125, characters: "\u{F701}")) == "<Down>")
    #expect(vimKey(event(keyCode: 126, characters: "\u{F700}")) == "<Up>")
    #expect(vimKey(event(keyCode: 115, characters: "\u{F729}")) == "<Home>")
    #expect(vimKey(event(keyCode: 119, characters: "\u{F72B}")) == "<End>")
    #expect(vimKey(event(keyCode: 116, characters: "\u{F72C}")) == "<PageUp>")
    #expect(vimKey(event(keyCode: 121, characters: "\u{F72D}")) == "<PageDown>")
    #expect(vimKey(event(keyCode: 122, characters: "\u{F704}")) == "<F1>")
    #expect(vimKey(event(keyCode: 111, characters: "\u{F70F}")) == "<F12>")
    #expect(vimKey(event(keyCode: 49, characters: " ")) == "<Space>")
  }

  @Test func controlKeysUseTheKeyWithoutModifiers() {
    #expect(
      vimKey(event(keyCode: 2, characters: "\u{4}", ignoring: "d", flags: .control)) == "<C-d>")
    #expect(
      vimKey(event(keyCode: 2, characters: "\u{4}", ignoring: "D", flags: [.control, .shift]))
        == "<C-S-D>")
    #expect(
      vimKey(event(keyCode: 33, characters: "\u{1b}", ignoring: "[", flags: .control)) == "<C-[>")
    #expect(
      vimKey(event(keyCode: 49, characters: "\0", ignoring: " ", flags: .control)) == "<C-Space>")
    #expect(vimKey(event(keyCode: 53, characters: "\u{1b}", flags: .control)) == "<C-Esc>")
    #expect(vimKey(event(keyCode: 1, characters: "s", ignoring: "s", flags: .command)) == "<M-s>")
  }

  @Test func charactersKeepTheirCaseAndOptionCharacters() {
    #expect(vimKey(event(keyCode: 0, characters: "a")) == "a")
    #expect(vimKey(event(keyCode: 0, characters: "A", ignoring: "A", flags: .shift)) == "A")
    #expect(vimKey(event(keyCode: 28, characters: "•", ignoring: "8", flags: .option)) == "•")
    #expect(vimKey(event(keyCode: 42, characters: "«", ignoring: "\\", flags: .option)) == "«")
    #expect(vimKey(event(keyCode: 25, characters: "(", ignoring: "(", flags: .shift)) == "(")
  }

  @Test func repeatsAreOrdinaryKeys() {
    #expect(vimKey(event(keyCode: 38, characters: "j", isRepeat: true)) == "j")
  }

  @Test func deadKeysAndModifierOnlyEventsHaveNoVimKey() {
    #expect(
      VimKeyEvents.input(for: event(keyCode: 14, characters: "", ignoring: "e", flags: .option))
        == nil)
    #expect(VimKeyEvents.input(for: event(keyCode: 999, characters: "\u{F746}")) == nil)
    let flagsChanged = NSEvent.keyEvent(
      with: .flagsChanged, location: .zero, modifierFlags: .shift, timestamp: 0, windowNumber: 0,
      context: nil,
      characters: "", charactersIgnoringModifiers: "", isARepeat: false, keyCode: 56)
    #expect(flagsChanged.flatMap { VimKeyEvents.input(for: $0) } == nil)
  }

  @Test func theUSKeyPositionIsPassedForNonLatinLayouts() throws {
    let input = try #require(VimKeyEvents.input(for: event(keyCode: 12, characters: "й")))
    #expect(input.code == "KeyQ")
    // A session maps a key vim doesn't know to the Latin key at the same position.
    let buffer = VimTextBuffer("one two")
    let session = buffer.attach(to: Vim(scheduler: ManualVimScheduler()))
    #expect(session.vimKey(for: input) == "q")
    let shifted = try #require(
      VimKeyEvents.input(for: event(keyCode: 38, characters: "О", ignoring: "О", flags: .shift)))
    #expect(session.vimKey(for: shifted) == "J")
    let digit = try #require(VimKeyEvents.input(for: event(keyCode: 18, characters: "1")))
    #expect(digit.code == "Digit1")
  }
}
