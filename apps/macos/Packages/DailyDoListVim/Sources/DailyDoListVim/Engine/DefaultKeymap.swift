// Ported from `defaultKeymap` and `defaultExCommandMap` of vim.js (@replit/codemirror-vim-core
// 0.1.0, MIT, © Marijn Haverbeke and others). Order matters: the first full match wins, and user
// mappings are inserted at the front.

@MainActor
enum DefaultKeymap {
  // MARK: Builders

  private static func keyToKey(_ keys: String, _ toKeys: String, _ context: KeyContext? = nil) -> VimCommand {
    let c = VimCommand(keys: VimText(keys), type: .keyToKey)
    c.toKeys = VimText(toKeys)
    c.context = context
    return c
  }

  private static func motion(_ keys: String, _ name: String, _ args: MotionArgs? = nil, _ context: KeyContext? = nil) -> VimCommand {
    let c = VimCommand(keys: VimText(keys), type: .motion)
    c.motion = name
    c.motionArgs = args
    c.context = context
    return c
  }

  private static func op(
    _ keys: String, _ name: String, _ args: OperatorArgs? = nil, _ context: KeyContext? = nil, isEdit: Bool = false,
    exitVisualBlock: Bool = false
  ) -> VimCommand {
    let c = VimCommand(keys: VimText(keys), type: .operator)
    c.operator = name
    c.operatorArgs = args
    c.context = context
    c.isEdit = isEdit
    c.exitVisualBlock = exitVisualBlock
    return c
  }

  private static func opMotion(
    _ keys: String, _ op: String, _ motion: String, _ motionArgs: MotionArgs? = nil, operatorArgs: OperatorArgs? = nil,
    operatorMotionArgs: OperatorMotionArgs? = nil, _ context: KeyContext? = nil
  ) -> VimCommand {
    let c = VimCommand(keys: VimText(keys), type: .operatorMotion)
    c.operator = op
    c.motion = motion
    c.motionArgs = motionArgs
    c.operatorArgs = operatorArgs
    c.operatorMotionArgs = operatorMotionArgs
    c.context = context
    return c
  }

  private static func action(
    _ keys: String, _ name: String, _ args: ActionArgs? = nil, _ context: KeyContext? = nil, isEdit: Bool = false,
    interlaceInsertRepeat: Bool = false, motion: String? = nil
  ) -> VimCommand {
    let c = VimCommand(keys: VimText(keys), type: .action)
    c.action = name
    c.actionArgs = args
    c.context = context
    c.isEdit = isEdit
    c.interlaceInsertRepeat = interlaceInsertRepeat
    c.motion = motion
    return c
  }

  private static func search(_ keys: String, _ args: SearchArgs) -> VimCommand {
    let c = VimCommand(keys: VimText(keys), type: .search)
    c.searchArgs = args
    return c
  }

  // MARK: The keymap

  static func make() -> [VimCommand] {
    var map: [VimCommand] = [
      // Key to key mapping. This goes first to make it possible to override existing mappings.
      keyToKey("<Left>", "h"),
      keyToKey("<Right>", "l"),
      keyToKey("<Up>", "k"),
      keyToKey("<Down>", "j"),
      keyToKey("g<Up>", "gk"),
      keyToKey("g<Down>", "gj"),
      keyToKey("<Space>", "l"),
      keyToKey("<BS>", "h"),
      keyToKey("<Del>", "x"),
      keyToKey("<C-Space>", "W"),
      keyToKey("<C-BS>", "B"),
      keyToKey("<S-Space>", "w"),
      keyToKey("<S-BS>", "b"),
      keyToKey("<C-n>", "j"),
      keyToKey("<C-p>", "k"),
      keyToKey("<C-[>", "<Esc>"),
      keyToKey("<C-c>", "<Esc>"),
      keyToKey("<C-[>", "<Esc>", .insert),
      keyToKey("<C-c>", "<Esc>", .insert),
      keyToKey("<C-Esc>", "<Esc>"),  // ipad keyboard sends C-Esc instead of C-[
      keyToKey("<C-Esc>", "<Esc>", .insert),
      keyToKey("s", "cl", .normal),
      keyToKey("s", "c", .visual),
      keyToKey("S", "cc", .normal),
      keyToKey("S", "VdO", .visual),
      keyToKey("<Home>", "0"),
      keyToKey("<End>", "$"),
      keyToKey("<PageUp>", "<C-b>"),
      keyToKey("<PageDown>", "<C-f>"),
      keyToKey("<CR>", "j^", .normal),
      keyToKey("<Ins>", "i", .normal),
      action("<Ins>", "toggleOverwrite", nil, .insert),
      // Motions
      motion("H", "moveToTopLine", MotionArgs(linewise: true, toJumplist: true)),
      motion("M", "moveToMiddleLine", MotionArgs(linewise: true, toJumplist: true)),
      motion("L", "moveToBottomLine", MotionArgs(linewise: true, toJumplist: true)),
      motion("h", "moveByCharacters", MotionArgs(forward: false)),
      motion("l", "moveByCharacters", MotionArgs(forward: true)),
      motion("j", "moveByLines", MotionArgs(forward: true, linewise: true)),
      motion("k", "moveByLines", MotionArgs(forward: false, linewise: true)),
      motion("gj", "moveByDisplayLines", MotionArgs(forward: true)),
      motion("gk", "moveByDisplayLines", MotionArgs(forward: false)),
      motion("w", "moveByWords", MotionArgs(forward: true, wordEnd: false)),
      motion("W", "moveByWords", MotionArgs(forward: true, wordEnd: false, bigWord: true)),
      motion("e", "moveByWords", MotionArgs(forward: true, wordEnd: true, inclusive: true)),
      motion("E", "moveByWords", MotionArgs(forward: true, wordEnd: true, bigWord: true, inclusive: true)),
      motion("b", "moveByWords", MotionArgs(forward: false, wordEnd: false)),
      motion("B", "moveByWords", MotionArgs(forward: false, wordEnd: false, bigWord: true)),
      motion("ge", "moveByWords", MotionArgs(forward: false, wordEnd: true, inclusive: true)),
      motion("gE", "moveByWords", MotionArgs(forward: false, wordEnd: true, bigWord: true, inclusive: true)),
      motion("{", "moveByParagraph", MotionArgs(forward: false, toJumplist: true)),
      motion("}", "moveByParagraph", MotionArgs(forward: true, toJumplist: true)),
      motion("(", "moveBySentence", MotionArgs(forward: false)),
      motion(")", "moveBySentence", MotionArgs(forward: true)),
      motion("<C-f>", "moveByPage", MotionArgs(forward: true)),
      motion("<C-b>", "moveByPage", MotionArgs(forward: false)),
      motion("<C-d>", "moveByScroll", MotionArgs(forward: true, explicitRepeat: true)),
      motion("<C-u>", "moveByScroll", MotionArgs(forward: false, explicitRepeat: true)),
      motion("gg", "moveToLineOrEdgeOfDocument", MotionArgs(forward: false, linewise: true, toJumplist: true, explicitRepeat: true)),
      motion("G", "moveToLineOrEdgeOfDocument", MotionArgs(forward: true, linewise: true, toJumplist: true, explicitRepeat: true)),
      motion("g$", "moveToEndOfDisplayLine"),
      motion("g^", "moveToStartOfDisplayLine"),
      motion("g0", "moveToStartOfDisplayLine"),
      motion("0", "moveToStartOfLine"),
      motion("^", "moveToFirstNonWhiteSpaceCharacter"),
      motion("+", "moveByLines", MotionArgs(forward: true, toFirstChar: true)),
      motion("-", "moveByLines", MotionArgs(forward: false, toFirstChar: true)),
      motion("_", "moveByLines", MotionArgs(forward: true, repeatOffset: -1, toFirstChar: true)),
      motion("$", "moveToEol", MotionArgs(inclusive: true)),
      motion("%", "moveToMatchedSymbol", MotionArgs(toJumplist: true, inclusive: true)),
      motion("f<character>", "moveToCharacter", MotionArgs(forward: true, inclusive: true)),
      motion("F<character>", "moveToCharacter", MotionArgs(forward: false)),
      motion("t<character>", "moveTillCharacter", MotionArgs(forward: true, inclusive: true)),
      motion("T<character>", "moveTillCharacter", MotionArgs(forward: false)),
      motion(";", "repeatLastCharacterSearch", MotionArgs(forward: true)),
      motion(",", "repeatLastCharacterSearch", MotionArgs(forward: false)),
      motion("'<register>", "goToMark", MotionArgs(linewise: true, toJumplist: true)),
      motion("`<register>", "goToMark", MotionArgs(toJumplist: true)),
      motion("]`", "jumpToMark", MotionArgs(forward: true)),
      motion("[`", "jumpToMark", MotionArgs(forward: false)),
      motion("]'", "jumpToMark", MotionArgs(forward: true, linewise: true)),
      motion("['", "jumpToMark", MotionArgs(forward: false, linewise: true)),
      // the next two aren't motions but must come before more general motion declarations
      action("]p", "paste", ActionArgs(after: true, isEdit: true, matchIndent: true), isEdit: true),
      action("[p", "paste", ActionArgs(after: false, isEdit: true, matchIndent: true), isEdit: true),
      motion("]<character>", "moveToSymbol", MotionArgs(forward: true, toJumplist: true)),
      motion("[<character>", "moveToSymbol", MotionArgs(forward: false, toJumplist: true)),
      motion("|", "moveToColumn"),
      motion("o", "moveToOtherHighlightedEnd", nil, .visual),
      motion("O", "moveToOtherHighlightedEnd", MotionArgs(sameLine: true), .visual),
      // Operators
      op("d", "delete"),
      op("y", "yank"),
      op("c", "change"),
      op("=", "indentAuto"),
      op(">", "indent", OperatorArgs(indentRight: true)),
      op("<", "indent", OperatorArgs(indentRight: false)),
      op("g~", "changeCase"),
      op("gu", "changeCase", OperatorArgs(toLower: true), isEdit: true),
      op("gU", "changeCase", OperatorArgs(toLower: false), isEdit: true),
      op("gc", "toggleComment", isEdit: true),
      motion("n", "findNext", MotionArgs(forward: true, toJumplist: true)),
      motion("N", "findNext", MotionArgs(forward: false, toJumplist: true)),
      motion("gn", "findAndSelectNextInclusive", MotionArgs(forward: true)),
      motion("gN", "findAndSelectNextInclusive", MotionArgs(forward: false)),
      op("gq", "hardWrap"),
      op("gw", "hardWrap", OperatorArgs(keepCursor: true)),
      op("g?", "rot13"),
      // Operator-Motion dual commands
      opMotion("x", "delete", "moveByCharacters", MotionArgs(forward: true), operatorMotionArgs: OperatorMotionArgs(visualLine: false)),
      opMotion("X", "delete", "moveByCharacters", MotionArgs(forward: false), operatorMotionArgs: OperatorMotionArgs(visualLine: true)),
      opMotion("D", "delete", "moveToEol", MotionArgs(inclusive: true), .normal),
      op("D", "delete", OperatorArgs(linewise: true), .visual),
      opMotion("Y", "yank", "expandToLine", MotionArgs(linewise: true), .normal),
      op("Y", "yank", OperatorArgs(linewise: true), .visual),
      opMotion("C", "change", "moveToEol", MotionArgs(inclusive: true), .normal),
      op("C", "change", OperatorArgs(linewise: true), .visual),
      opMotion("~", "changeCase", "moveByCharacters", MotionArgs(forward: true), operatorArgs: OperatorArgs(shouldMoveCursor: true), .normal),
      op("~", "changeCase", nil, .visual),
      opMotion("<C-u>", "delete", "moveToStartOfLine", nil, .insert),
      opMotion("<C-w>", "delete", "moveByWords", MotionArgs(forward: false, wordEnd: false), .insert),
      // ignore C-w in normal mode
      {
        let c = VimCommand(keys: "<C-w>", type: .idle)
        c.context = .normal
        return c
      }(),
      // Actions
      action("<C-i>", "jumpListWalk", ActionArgs(forward: true)),
      action("<C-o>", "jumpListWalk", ActionArgs(forward: false)),
      action("<C-e>", "scroll", ActionArgs(forward: true, linewise: true)),
      action("<C-y>", "scroll", ActionArgs(forward: false, linewise: true)),
      action("a", "enterInsertMode", ActionArgs(insertAt: "charAfter"), .normal, isEdit: true),
      action("A", "enterInsertMode", ActionArgs(insertAt: "eol"), .normal, isEdit: true),
      action("A", "enterInsertMode", ActionArgs(insertAt: "endOfSelectedArea"), .visual, isEdit: true),
      action("i", "enterInsertMode", ActionArgs(insertAt: "inplace"), .normal, isEdit: true),
      action("gi", "enterInsertMode", ActionArgs(insertAt: "lastEdit"), .normal, isEdit: true),
      action("I", "enterInsertMode", ActionArgs(insertAt: "firstNonBlank"), .normal, isEdit: true),
      action("gI", "enterInsertMode", ActionArgs(insertAt: "bol"), .normal, isEdit: true),
      action("I", "enterInsertMode", ActionArgs(insertAt: "startOfSelectedArea"), .visual, isEdit: true),
      action("o", "newLineAndEnterInsertMode", ActionArgs(after: true), .normal, isEdit: true, interlaceInsertRepeat: true),
      action("O", "newLineAndEnterInsertMode", ActionArgs(after: false), .normal, isEdit: true, interlaceInsertRepeat: true),
      action("v", "toggleVisualMode"),
      action("V", "toggleVisualMode", ActionArgs(linewise: true)),
      action("<C-v>", "toggleVisualMode", ActionArgs(blockwise: true)),
      action("<C-q>", "toggleVisualMode", ActionArgs(blockwise: true)),
      action("gv", "reselectLastSelection"),
      action("J", "joinLines", nil, isEdit: true),
      action("gJ", "joinLines", ActionArgs(keepSpaces: true), isEdit: true),
      action("p", "paste", ActionArgs(after: true, isEdit: true), isEdit: true),
      action("P", "paste", ActionArgs(after: false, isEdit: true), isEdit: true),
      action("r<character>", "replace", nil, isEdit: true),
      action("@<register>", "replayMacro"),
      action("q<register>", "enterMacroRecordMode"),
      // Handle Replace-mode as a special case of insert mode.
      action("R", "enterInsertMode", ActionArgs(replace: true), .normal, isEdit: true),
      op("R", "change", OperatorArgs(linewise: true, fullLine: true), .visual, exitVisualBlock: true),
      action("u", "undo", nil, .normal),
      op("u", "changeCase", OperatorArgs(toLower: true), .visual, isEdit: true),
      op("U", "changeCase", OperatorArgs(toLower: false), .visual, isEdit: true),
      action("<C-r>", "redo"),
      action("m<register>", "setMark"),
      action("\"<register>", "setRegister"),
      action("<C-r><register>", "insertRegister", nil, .insert, isEdit: true),
      action("<C-o>", "oneNormalCommand", nil, .insert),
      action("zz", "scrollToCursor", ActionArgs(position: "center")),
      action("z.", "scrollToCursor", ActionArgs(position: "center"), motion: "moveToFirstNonWhiteSpaceCharacter"),
      action("zt", "scrollToCursor", ActionArgs(position: "top")),
      action("z<CR>", "scrollToCursor", ActionArgs(position: "top"), motion: "moveToFirstNonWhiteSpaceCharacter"),
      action("zb", "scrollToCursor", ActionArgs(position: "bottom")),
      action("z-", "scrollToCursor", ActionArgs(position: "bottom"), motion: "moveToFirstNonWhiteSpaceCharacter"),
      action(".", "repeatLastEdit"),
      action("<C-a>", "incrementNumberToken", ActionArgs(increase: true, backtrack: false), isEdit: true),
      action("<C-x>", "incrementNumberToken", ActionArgs(increase: false, backtrack: false), isEdit: true),
      action("<C-t>", "indent", ActionArgs(indentRight: true), .insert),
      action("<C-d>", "indent", ActionArgs(indentRight: false), .insert),
      // Text object motions
      motion("a<register>", "textObjectManipulation"),
      motion("i<register>", "textObjectManipulation", MotionArgs(textObjectInner: true)),
      // Search
      search("/", SearchArgs(forward: true, querySrc: "prompt", toJumplist: true)),
      search("?", SearchArgs(forward: false, querySrc: "prompt", toJumplist: true)),
      search("*", SearchArgs(forward: true, querySrc: "wordUnderCursor", toJumplist: true, wholeWordOnly: true)),
      search("#", SearchArgs(forward: false, querySrc: "wordUnderCursor", toJumplist: true, wholeWordOnly: true)),
      search("g*", SearchArgs(forward: true, querySrc: "wordUnderCursor", toJumplist: true)),
      search("g#", SearchArgs(forward: false, querySrc: "wordUnderCursor", toJumplist: true)),
    ]
    // Ex command
    map.append(VimCommand(keys: ":", type: .ex))
    return map
  }

  /// `defaultExCommandMap`: name, short name, flags.
  static let exCommands: [(name: String, shortName: String?, possiblyAsync: Bool, excludeFromCommandHistory: Bool)] = [
    ("colorscheme", "colo", false, false),
    ("map", nil, false, false),
    ("imap", "im", false, false),
    ("nmap", "nm", false, false),
    ("vmap", "vm", false, false),
    ("omap", "om", false, false),
    ("noremap", "no", false, false),
    ("nnoremap", "nn", false, false),
    ("vnoremap", "vn", false, false),
    ("inoremap", "ino", false, false),
    ("onoremap", "ono", false, false),
    ("unmap", nil, false, false),
    ("mapclear", "mapc", false, false),
    ("nmapclear", "nmapc", false, false),
    ("vmapclear", "vmapc", false, false),
    ("imapclear", "imapc", false, false),
    ("omapclear", "omapc", false, false),
    ("write", "w", false, false),
    ("undo", "u", false, false),
    ("redo", "red", false, false),
    ("set", "se", false, false),
    ("setlocal", "setl", false, false),
    ("setglobal", "setg", false, false),
    ("sort", "sor", false, false),
    ("substitute", "s", true, false),
    ("startinsert", "start", false, false),
    ("nohlsearch", "noh", false, false),
    ("yank", "y", false, false),
    ("put", "pu", false, false),
    ("delmarks", "delm", false, false),
    ("marks", nil, false, true),
    ("registers", "reg", false, true),
    ("vglobal", "v", false, false),
    ("delete", "d", false, false),
    ("join", "j", false, false),
    ("normal", "norm", false, false),
    ("global", "g", false, false),
  ]
}
