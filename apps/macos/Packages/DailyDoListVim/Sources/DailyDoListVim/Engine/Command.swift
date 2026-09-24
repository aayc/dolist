// Ported from vim.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke and others):
// the shape of keymap entries (`vimKey`) and of the argument objects motions, operators and
// actions receive. vim.js copies and mutates these objects in place (a text object marks its
// motion linewise, `;` makes its motion inclusive, `.` stores a repeat override), so they are
// reference types here too.

/// The kinds of keymap entries (`type` in vim.js's keymap).
enum CommandType: String {
  case keyToKey, motion, `operator`, operatorMotion, action, search, ex, keyToEx, idle
}

/// Where a keymap entry applies (`context`).
enum KeyContext: String {
  case normal, insert, visual, operatorPending
}

/// An entry of the keymap: a default binding or a user mapping. Identity matters (the key-to-key
/// recursion guard compares entries), so this is a class.
@MainActor
final class VimCommand: KeyToKeySource {
  var keys: VimText
  var type: CommandType
  var motion: String?
  var motionArgs: MotionArgs?
  var `operator`: String?
  var operatorArgs: OperatorArgs?
  var action: String?
  var actionArgs: ActionArgs?
  var searchArgs: SearchArgs?
  var operatorMotionArgs: OperatorMotionArgs?
  var toKeys: VimText?
  var context: KeyContext?
  var isEdit = false
  var interlaceInsertRepeat = false
  var exitVisualBlock = false
  /// For mappings: whether the right-hand side is non-recursive.
  var noremapValue: Bool?
  var repeatOverride: Int?
  /// `keyToEx`: the ex command line to run.
  var exInput: VimText?

  init(keys: VimText, type: CommandType) {
    self.keys = keys
    self.type = type
  }

  /// `fromKey.noremap != false`.
  var noremapForKeyToKey: Bool { noremapValue != false }

  /// `Object.assign({}, mapping)`.
  func copy() -> VimCommand {
    let c = VimCommand(keys: keys, type: type)
    c.motion = motion
    c.motionArgs = motionArgs
    c.operator = self.operator
    c.operatorArgs = operatorArgs
    c.action = action
    c.actionArgs = actionArgs
    c.searchArgs = searchArgs
    c.operatorMotionArgs = operatorMotionArgs
    c.toKeys = toKeys
    c.context = context
    c.isEdit = isEdit
    c.interlaceInsertRepeat = interlaceInsertRepeat
    c.exitVisualBlock = exitVisualBlock
    c.noremapValue = noremapValue
    c.repeatOverride = repeatOverride
    c.exInput = exInput
    return c
  }
}

/// Something `doKeyToKey` can come from (a mapping, an ex-to-key mapping, `:normal`).
@MainActor
protocol KeyToKeySource: AnyObject {
  var noremapForKeyToKey: Bool { get }
}

/// `{noremap}` as `:normal` passes it.
@MainActor
final class NoremapSource: KeyToKeySource {
  let noremap: Bool
  init(noremap: Bool) { self.noremap = noremap }
  var noremapForKeyToKey: Bool { noremap }
}

@MainActor
final class MotionArgs {
  var forward = false
  var linewise = false
  var toJumplist = false
  var wordEnd = false
  var bigWord = false
  var inclusive = false
  var explicitRepeat = false
  var `repeat` = 0
  var repeatOffset = 0
  var toFirstChar = false
  var sameLine = false
  var textObjectInner = false
  var selectedCharacter: VimText?
  var repeatIsExplicit = false
  var noRepeat = false

  init(
    forward: Bool = false, linewise: Bool = false, toJumplist: Bool = false, wordEnd: Bool = false,
    bigWord: Bool = false,
    inclusive: Bool = false, explicitRepeat: Bool = false, repeatOffset: Int = 0,
    toFirstChar: Bool = false,
    sameLine: Bool = false, textObjectInner: Bool = false, count: Int = 0
  ) {
    self.forward = forward
    self.linewise = linewise
    self.toJumplist = toJumplist
    self.wordEnd = wordEnd
    self.bigWord = bigWord
    self.inclusive = inclusive
    self.explicitRepeat = explicitRepeat
    self.repeatOffset = repeatOffset
    self.toFirstChar = toFirstChar
    self.sameLine = sameLine
    self.textObjectInner = textObjectInner
    self.repeat = count
  }

  func copy() -> MotionArgs {
    let c = MotionArgs(
      forward: forward, linewise: linewise, toJumplist: toJumplist, wordEnd: wordEnd,
      bigWord: bigWord, inclusive: inclusive,
      explicitRepeat: explicitRepeat, repeatOffset: repeatOffset, toFirstChar: toFirstChar,
      sameLine: sameLine,
      textObjectInner: textObjectInner, count: self.repeat)
    c.selectedCharacter = selectedCharacter
    c.repeatIsExplicit = repeatIsExplicit
    c.noRepeat = noRepeat
    return c
  }
}

/// A visual selection an operator remembers so `.` can repeat it.
struct LastSel {
  var anchor: Pos
  var head: Pos
  var visualBlock: Bool
  var visualLine: Bool
}

@MainActor
final class OperatorArgs {
  var indentRight = false
  /// `changeCase`: true lower, false upper, nil toggle.
  var toLower: Bool?
  var linewise = false
  var fullLine = false
  var shouldMoveCursor = false
  var keepCursor = false
  var lastSel: LastSel?
  var `repeat` = 0
  var registerName: String?
  var selectedCharacter: VimText?

  init(
    indentRight: Bool = false, toLower: Bool? = nil, linewise: Bool = false, fullLine: Bool = false,
    shouldMoveCursor: Bool = false, keepCursor: Bool = false
  ) {
    self.indentRight = indentRight
    self.toLower = toLower
    self.linewise = linewise
    self.fullLine = fullLine
    self.shouldMoveCursor = shouldMoveCursor
    self.keepCursor = keepCursor
  }

  func copy() -> OperatorArgs {
    let c = OperatorArgs(
      indentRight: indentRight, toLower: toLower, linewise: linewise, fullLine: fullLine,
      shouldMoveCursor: shouldMoveCursor, keepCursor: keepCursor)
    c.lastSel = lastSel
    c.repeat = self.repeat
    c.registerName = registerName
    c.selectedCharacter = selectedCharacter
    return c
  }
}

@MainActor
final class ActionArgs {
  var forward = false
  /// nil when undefined (paste then uses the register's linewise flag).
  var linewise: Bool?
  var blockwise = false
  var insertAt: String?
  var after = false
  var isEdit = false
  var matchIndent = false
  var keepSpaces = false
  var replace = false
  var position: String?
  var increase = false
  var backtrack = false
  var indentRight = false
  var `repeat` = 1
  var repeatIsExplicit = false
  var registerName: String?
  var selectedCharacter: VimText?
  var head: Pos?

  init(
    forward: Bool = false, linewise: Bool? = nil, blockwise: Bool = false, insertAt: String? = nil,
    after: Bool = false,
    isEdit: Bool = false, matchIndent: Bool = false, keepSpaces: Bool = false,
    replace: Bool = false,
    position: String? = nil, increase: Bool = false, backtrack: Bool = false,
    indentRight: Bool = false
  ) {
    self.forward = forward
    self.linewise = linewise
    self.blockwise = blockwise
    self.insertAt = insertAt
    self.after = after
    self.isEdit = isEdit
    self.matchIndent = matchIndent
    self.keepSpaces = keepSpaces
    self.replace = replace
    self.position = position
    self.increase = increase
    self.backtrack = backtrack
    self.indentRight = indentRight
  }

  func copy() -> ActionArgs {
    let c = ActionArgs(
      forward: forward, linewise: linewise, blockwise: blockwise, insertAt: insertAt, after: after,
      isEdit: isEdit,
      matchIndent: matchIndent, keepSpaces: keepSpaces, replace: replace, position: position,
      increase: increase,
      backtrack: backtrack, indentRight: indentRight)
    c.repeat = self.repeat
    c.repeatIsExplicit = repeatIsExplicit
    c.registerName = registerName
    c.selectedCharacter = selectedCharacter
    c.head = head
    return c
  }
}

struct SearchArgs {
  var forward: Bool
  /// "prompt" or "wordUnderCursor".
  var querySrc: String
  var toJumplist = false
  var wholeWordOnly = false
}

struct OperatorMotionArgs {
  var visualLine: Bool
}

/// What a motion returns: a new head, or an [anchor, head] pair.
enum MotionResult {
  case pos(Pos)
  case range(Pos, Pos)
}
