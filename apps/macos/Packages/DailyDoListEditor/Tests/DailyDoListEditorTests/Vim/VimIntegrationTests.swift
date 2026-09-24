import AppKit
import DailyDoListVim
import Testing

@testable import DailyDoListEditor

/// The app's vim integration (`EditorVimIntegration`, the port of the web editor's
/// `vim-integration.ts`): ex commands and keys mapped to app requests, the clipboard registers,
/// the vimrc and the Ctrl key policy. Mirrors `vim-integration.test.ts` and `vimrc.test.ts`.
@MainActor
@Suite("Vim integration")
struct VimIntegrationTests {
  private func ex(_ editor: VimEditorHarness, _ input: String) {
    guard let session = editor.session else { return }
    try? editor.vim.handleEx(input, in: session)
  }

  @Test func exCommandsMapToTheHostsRequests() {
    let editor = VimEditorHarness("one two\nthree")
    ex(editor, "w")
    ex(editor, "write")
    #expect(editor.delegate.saves == 2)
    ex(editor, "wa")
    #expect(editor.delegate.requests == [.saveAll])
    editor.delegate.requests.removeAll()
    for command in ["q", "q!", "quit", "tabc", "bd"] { ex(editor, command) }
    #expect(editor.delegate.requests == Array(repeating: .close(all: false), count: 5))
    editor.delegate.requests.removeAll()
    ex(editor, "qa")
    #expect(editor.delegate.requests.last == .close(all: true))
    ex(editor, "wq")
    ex(editor, "x")
    #expect(editor.delegate.saves == 4)
    #expect(editor.delegate.requests.last == .close(all: false))
    ex(editor, "xa")
    #expect(editor.delegate.requests.suffix(2) == [.saveAll, .close(all: true)])
    editor.delegate.requests.removeAll()

    ex(editor, "e Garden Redesign")
    ex(editor, "edit")
    ex(editor, "e!")
    ex(editor, "tabe Notes/Idea.md")
    ex(editor, "tabnew")
    #expect(
      editor.delegate.requests == [
        .openNote("Garden Redesign", newTab: false), .openNote(nil, newTab: false),
        .openNote(nil, newTab: false),
        .openNote("Notes/Idea.md", newTab: true), .openNote(nil, newTab: true),
      ])
    editor.delegate.requests.removeAll()

    for command in ["tabn", "tabn 3", "tabp", "tabp 2", "tabN", "bn", "bp", "bN"] {
      ex(editor, command)
    }
    #expect(
      editor.delegate.requests == [
        .switchTab(.delta(1)), .switchTab(.index(2)), .switchTab(.delta(-1)),
        .switchTab(.delta(-2)), .switchTab(.delta(-1)),
        .switchTab(.delta(1)), .switchTab(.delta(-1)), .switchTab(.delta(-1)),
      ])
    editor.delegate.requests.removeAll()
    ex(editor, "obcommand daily.today")
    #expect(editor.delegate.requests == [.runCommand("daily.today")])
  }

  @Test func theUserHearsWhenACommandCantBeDoneHere() {
    let editor = VimEditorHarness("text")
    editor.delegate.result = .unavailable
    ex(editor, "q")
    #expect(editor.session?.lastMessage == ":quit isn't available here")
    editor.delegate.result = .failed
    ex(editor, "obcommand nope.nothing")
    #expect(editor.session?.lastMessage == "No command nope.nothing")
    ex(editor, "obcommand")
    #expect(editor.session?.lastMessage == "Usage: :obcommand <command id>")
  }

  @Test func gtAndGTSwitchTabsWithCountsAndSurviveMapclear() {
    let editor = VimEditorHarness("text")
    editor.press("g", "t")
    editor.press("3", "g", "t")
    editor.press("g", "T")
    editor.press("2", "g", "T")
    ex(editor, "mapclear")
    editor.press("g", "t")
    #expect(
      editor.delegate.requests == [
        .switchTab(.delta(1)), .switchTab(.index(2)), .switchTab(.delta(-1)),
        .switchTab(.delta(-2)), .switchTab(.delta(1)),
      ])
  }

  // MARK: Clipboard

  @Test func plusAndStarAreTheSystemClipboard() throws {
    let editor = VimEditorHarness("first line\nsecond line")
    editor.press("\"", "+", "y", "y")
    #expect(editor.pasteboard.string(forType: .string) == "first line\n")
    editor.pasteboard.clearContents()
    editor.pasteboard.setString("copied elsewhere", forType: .string)
    editor.press("j", "\"", "*", "P")
    #expect(editor.text == "first line\ncopied elsewheresecond line")
    // Text copied with a trailing line break pastes as lines, like Vim.
    editor.pasteboard.clearContents()
    editor.pasteboard.setString("a whole line\n", forType: .string)
    editor.press("\"", "+", "p")
    #expect(editor.text == "first line\ncopied elsewheresecond line\na whole line")
    // Without `clipboard=unnamed`, the unnamed register stays vim's own.
    editor.press("g", "g", "y", "w")
    #expect(editor.pasteboard.string(forType: .string) == "a whole line\n")
  }

  @Test func setClipboardUnnamedMirrorsTheUnnamedRegister() throws {
    let editor = VimEditorHarness("alpha beta")
    ex(editor, "set clipboard=unnamed")
    editor.press("y", "w")
    #expect(editor.pasteboard.string(forType: .string) == "alpha ")
    // What another app copied is what `p` pastes…
    editor.pasteboard.clearContents()
    editor.pasteboard.setString("OTHER", forType: .string)
    editor.press("$", "p")
    #expect(editor.text == "alpha betaOTHER")
    // …and a yank in vim wins again.
    editor.press("0", "y", "l", "$", "p")
    #expect(editor.text == "alpha betaOTHERa")
    ex(editor, "set clipboard=")
    editor.pasteboard.clearContents()
    editor.pasteboard.setString("IGNORED", forType: .string)
    editor.press("p")
    #expect(editor.text == "alpha betaOTHERaa")
  }

  @Test func vimKeepsWorkingAfterTheIntegrationIsReleased() throws {
    let editor = VimEditorHarness("one\ntwo", integrated: false)
    weak var released: EditorVimIntegration?
    do {
      let integration = EditorVimIntegration(
        vim: editor.vim, pasteboard: SystemVimPasteboard(editor.pasteboard))
      released = integration
      ex(editor, "set clipboard=unnamed")
    }
    #expect(released == nil)
    // Its hooks (register writes, pastes, `:mapclear`, ex commands, `gt`) are left on the engine.
    editor.press("d", "d", "p")
    #expect(editor.text == "two\none")
    ex(editor, "mapclear")
    ex(editor, "w")
    editor.press("g", "t")
    #expect(editor.delegate.saves == 0)
    #expect(editor.delegate.requests.isEmpty)
  }

  // MARK: vimrc

  @Test func theVimrcIsAppliedAndReappliedReportingBadLines() throws {
    let editor = VimEditorHarness("one two")
    let integration = try #require(editor.integration)
    #expect(
      integration.applyVimrc("nmap Q i\n\" comment\nset bogus") == [
        VimrcProblem(line: 2, message: "Unknown option: bogus")
      ])
    editor.press("Q")
    #expect(editor.mode == .insert)
    editor.press("<Esc>")

    #expect(integration.applyVimrc("nmap Z i\nset clipboard=unnamed") == [])
    #expect(try editor.vim.getOption("clipboard") == .string("unnamed"))
    editor.press("Q")
    #expect(editor.mode == .normal)
    editor.press("Z")
    #expect(editor.mode == .insert)
    editor.press("<Esc>")

    #expect(integration.applyVimrc("") == [])
    #expect(try editor.vim.getOption("clipboard") == nil)
    editor.press("Z")
    #expect(editor.mode == .normal)
    // gt survives the vimrc's mapclear.
    editor.press("g", "t")
    #expect(editor.delegate.requests == [.switchTab(.delta(1))])
  }

  @Test func theVimrcKeepsTheLastExCommandAndItsMessagesOutOfTheEditor() throws {
    let editor = VimEditorHarness("text")
    let integration = try #require(editor.integration)
    ex(editor, "nohlsearch")
    integration.applyVimrc("set nosuchoption\nnmap j gj")
    #expect(editor.vim.register(":").text.string == "nohlsearch")
    #expect(editor.host.panelView == nil)
    #expect(integration.vimrcProblems.map(\.line) == [0])
  }

  @Test func exmapAndLeaderWork() throws {
    let editor = VimEditorHarness("text")
    let integration = try #require(editor.integration)
    // vim.js runs a command as soon as its keys match (`,` repeats a search), so a leader must be
    // a key vim doesn't bind: here the default `\`.
    integration.applyVimrc("exmap today obcommand daily.today\nnmap <leader>t :today<CR>")
    editor.press("\\", "t")
    #expect(editor.delegate.requests == [.runCommand("daily.today")])
    // A new vimrc drops the old ex alias.
    integration.applyVimrc("")
    ex(editor, "today")
    #expect(editor.delegate.requests.count == 1)
  }

  @Test func mappedControlKeysAreClaimedFromMenus() throws {
    let editor = VimEditorHarness("one\ntwo\nthree")
    let integration = try #require(editor.integration)
    let ctrlJ = VimEditorHarness.event(for: "<C-j>", window: editor.window)
    #expect(!editor.host.claimsKeyEquivalent(ctrlJ))
    integration.applyVimrc("nmap <C-j> j\nimap <C-k> <Esc>")
    #expect(editor.host.claimsKeyEquivalent(ctrlJ))
    #expect(
      !editor.host.claimsKeyEquivalent(VimEditorHarness.event(for: "<C-k>", window: editor.window)))
    #expect(editor.textView.performKeyEquivalent(with: ctrlJ))
    #expect(editor.host.vimLineNumber(at: editor.cursor) == 1)
    integration.applyVimrc("")
    #expect(!editor.host.claimsKeyEquivalent(ctrlJ))
  }
}

/// `Vimrc.parse` and friends (the web's `vimrc.test.ts`).
@Suite("vimrc parsing")
struct VimrcParsingTests {
  @Test func keepsOneExCommandPerLineAndSkipsBlankAndCommentLines() {
    let parsed = Vimrc.parse(
      ["\" insert-mode escape", "", "imap jj <Esc>", "   ", "  \" indented comment", "nmap j gj"]
        .joined(separator: "\n"))
    #expect(parsed.problems.isEmpty)
    #expect(
      parsed.commands == [.ex(line: 2, input: "imap jj <Esc>"), .ex(line: 5, input: "nmap j gj")])
  }

  @Test func acceptsCRLFLineEndingsAndLeadingColons() {
    #expect(
      Vimrc.parse(":set clipboard=unnamed\r\n::nmap Y y$\r\n").commands == [
        .ex(line: 0, input: "set clipboard=unnamed"), .ex(line: 1, input: "nmap Y y$"),
      ])
  }

  @Test func expandsLeaderWithTheLatestMapleaderABackslashByDefault() {
    let parsed = Vimrc.parse(
      [
        "nmap <leader>a x", "let mapleader = \",\"", "nmap <Leader>w :w<CR>",
        "let g:mapleader=\"\\<Space>\"",
        "nmap <leader>q :q<CR>", "let mapleader=' '", "nmap <LEADER>e :e<CR>",
      ].joined(separator: "\n"))
    #expect(
      parsed.commands.compactMap { if case .ex(_, let input) = $0 { input } else { nil } } == [
        "nmap \\a x", "nmap ,w :w<CR>", "nmap <Space>q :q<CR>", "nmap <Space>e :e<CR>",
      ])
  }

  @Test func turnsExmapIntoAnExAliasAndReportsWhatItCantUse() {
    let parsed = Vimrc.parse(
      ["exmap back obcommand app:go-back", "exmap", "let g:other = 1", "exmap tab :tabnext"].joined(
        separator: "\n"))
    #expect(
      parsed.commands == [
        .exmap(line: 0, name: "back", command: "obcommand app:go-back"),
        .exmap(line: 3, name: "tab", command: "tabnext"),
      ])
    #expect(
      parsed.problems == [
        VimrcProblem(line: 1, message: "exmap needs a name and a command"),
        VimrcProblem(line: 2, message: "Only `let mapleader = …` is supported"),
      ])
  }

  @Test func tracksTheOptionsAndExAliasesALineCreates() {
    #expect(Vimrc.optionsSet(by: "set clipboard=unnamed") == ["clipboard"])
    #expect(Vimrc.optionsSet(by: "se nopcre") == ["pcre"])
    #expect(Vimrc.optionsSet(by: "setlocal tw=40") == ["tw"])
    #expect(Vimrc.optionsSet(by: "nmap j gj") == [])
    #expect(Vimrc.exMappings(createdBy: .exmap(line: 0, name: "back", command: "x")) == [":back"])
    #expect(Vimrc.exMappings(createdBy: .ex(line: 0, input: "map :del x")) == [":del"])
    #expect(Vimrc.exMappings(createdBy: .ex(line: 0, input: "noremap :k j")) == [":k"])
    #expect(Vimrc.exMappings(createdBy: .ex(line: 0, input: "nmap jj x")) == [])
  }

  @Test func controlKeysOfMappings() {
    #expect(VimCtrlKeys.ctrlKeys(of: "<C-J>") == ["<C-j>"])
    #expect(VimCtrlKeys.ctrlKeys(of: "<c-s-x>abc") == ["<C-x>"])
    #expect(VimCtrlKeys.ctrlKeys(of: "<C-Space>") == ["<C-Space>"])
    #expect(VimCtrlKeys.ctrlKeys(of: "jj") == [])
    #expect(VimCtrlKeys.isClaimed("<C-O>", mapped: []))
    #expect(!VimCtrlKeys.isClaimed("<C-s>", mapped: []))
    #expect(VimCtrlKeys.isClaimed("<C-s>", mapped: ["<C-s>"]))
  }
}
