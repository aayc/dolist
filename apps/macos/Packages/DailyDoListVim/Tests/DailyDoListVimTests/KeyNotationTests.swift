import Testing

@testable import DailyDoListVim

/// `VimKeyNotation.vimKey(for:isMac:)`, vim.js's `vimKeyFromEvent`: key presses to vim key names.
@MainActor
@Suite struct KeyNotationTests {
  private func key(
    _ key: String, control: Bool = false, alt: Bool = false, meta: Bool = false, shift: Bool = false, code: String? = nil,
    isMac: Bool = false
  ) -> String? {
    VimKeyNotation.vimKey(for: VimKeyInput(key: key, control: control, alt: alt, meta: meta, shift: shift, code: code), isMac: isMac)
  }

  @Test func characters() {
    #expect(key("a") == "a")
    #expect(key("A", shift: true) == "A")
    #expect(key("<") == "<")
    #expect(key("é") == "é")
    // An astral character is two UTF-16 units, so vim.js brackets it like a named key.
    #expect(key("😀") == "<😀>")
  }

  @Test func modifiers() {
    #expect(key("a", control: true) == "<C-a>")
    #expect(key("A", control: true, shift: true) == "<C-S-A>")
    #expect(key("x", alt: true) == "<A-x>")
    #expect(key("x", meta: true) == "<M-x>")
    #expect(key("x", control: true, alt: true, meta: true) == "<C-A-M-x>")
  }

  @Test func namedKeys() {
    #expect(key("Enter") == "<CR>")
    #expect(key("Escape") == "<Esc>")
    #expect(key("Backspace") == "<BS>")
    #expect(key("Delete") == "<Del>")
    #expect(key("Insert") == "<Ins>")
    #expect(key("Tab") == "<Tab>")
    #expect(key("Tab", shift: true) == "<S-Tab>")
    #expect(key(" ") == "<Space>")
    #expect(key(" ", shift: true) == "<S-Space>")
    #expect(key("ArrowUp") == "<Up>")
    #expect(key("ArrowLeft", control: true) == "<C-Left>")
    #expect(key("PageDown") == "<PageDown>")
    #expect(key("F5") == "<F5>")
    // vim.js only strips "Numpad" from keys starting with a lowercase "n", so this never applies.
    #expect(key("Numpad0") == "<Numpad0>")
  }

  @Test func modifierOnlyKeysAreIgnored() {
    for name in ["Shift", "Alt", "Command", "Control", "CapsLock", "AltGraph", "Dead", "Unidentified"] {
      #expect(key(name) == nil, "\(name)")
    }
  }

  @Test func optionTypesCharactersOnMac() {
    #expect(key("å", alt: true, isMac: true) == "å")
    #expect(key("å", alt: true, isMac: false) == "<A-å>")
    #expect(key("å", control: true, alt: true, isMac: true) == "<C-A-å>")
    // Only a lone Option on a one-unit key is dropped.
    #expect(key("ArrowUp", alt: true, isMac: true) == "<A-Up>")
  }

  @Test func sessionsApplyLangmap() {
    let t = VimTester("abc")
    t.vim.setLangmap("ab,ba")
    #expect(t.session.vimKey(for: VimKeyInput(key: "a")) == "b")
    #expect(t.session.vimKey(for: VimKeyInput(key: "a", control: true)) == "<C-b>")
    t.vim.setLangmap("ab,ba", remapCtrl: false)
    #expect(t.session.vimKey(for: VimKeyInput(key: "a", control: true)) == "<C-a>")
    #expect(t.session.vimKey(for: VimKeyInput(key: "c")) == "c")
  }

  @Test func sessionsMapNonLatinLayoutsByPhysicalKey() {
    let t = VimTester("abc")
    #expect(t.session.vimKey(for: VimKeyInput(key: "д", code: "KeyL")) == "l")
    #expect(t.session.vimKey(for: VimKeyInput(key: "Д", shift: true, code: "KeyL")) == "L")
    #expect(VimKeyNotation.vimKey(for: VimKeyInput(key: "д", code: "KeyL")) == "д")
    // A key some mapping uses stays itself.
    try? t.vim.map("д", "x")
    #expect(t.session.vimKey(for: VimKeyInput(key: "д", code: "KeyL")) == "д")
    // Option-v on a Mac types "√"; vim sees <A-v>.
    t.vim.isMac = true
    #expect(t.session.vimKey(for: VimKeyInput(key: "√", alt: true, code: "KeyV")) == "<A-v>")
  }

  @Test func domEventsForVimKeys() {
    let ctrl = DOMKeyEvent(vimKey: "<C-a>")
    #expect(ctrl.key == "a" && ctrl.ctrlKey && !ctrl.shiftKey)
    let enter = DOMKeyEvent(vimKey: "<CR>")
    #expect(enter.key == "Enter" && enter.keyCode == 13)
    let minus = DOMKeyEvent(vimKey: "<C-->")
    #expect(minus.key == "-" && minus.ctrlKey)
    #expect(DOMKeyEvent(vimKey: "<S-Space>").insertedText == " ")
    #expect(DOMKeyEvent(vimKey: "<A-x>").insertedText == nil)
    #expect(DOMKeyEvent(vimKey: "x").insertedText == "x")
    #expect(DOMKeyEvent(vimKey: "<C-a>").overwriteText == "a")
    #expect(DOMKeyEvent(vimKey: "😀").overwriteText == nil)
  }
}
