// Ported from `commandDispatcher` of vim.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn
// Haverbeke and others): processing of motions, operators, actions, searches and ex commands,
// and `evalInput`, which runs an operator over a motion.

typealias MotionFn =
  @MainActor (EditorAdapter, Pos, MotionArgs, VimState, InputState) throws -> MotionResult?
typealias OperatorFn =
  @MainActor (EditorAdapter, OperatorArgs, [VimRange], Pos, Pos?) throws -> Pos?
typealias ActionFn = @MainActor (EditorAdapter, ActionArgs, VimState) throws -> Void

extension Vim {
  func processCommand(_ cm: EditorAdapter, _ vim: VimState, _ command: VimCommand) throws {
    vim.inputState.repeatOverride = command.repeatOverride
    switch command.type {
    case .motion: try processMotion(cm, vim, command)
    case .operator: try processOperator(cm, vim, command)
    case .operatorMotion: try processOperatorMotion(cm, vim, command)
    case .action: try processAction(cm, vim, command)
    case .search: try processSearch(cm, vim, command)
    case .ex, .keyToEx: try processEx(cm, vim, command)
    default: break
    }
  }

  func processMotion(_ cm: EditorAdapter, _ vim: VimState, _ command: VimCommand) throws {
    vim.inputState.motion = command.motion
    vim.inputState.motionArgs = command.motionArgs?.copy() ?? MotionArgs()
    try evalInput(cm, vim)
  }

  func processOperator(_ cm: EditorAdapter, _ vim: VimState, _ command: VimCommand) throws {
    let inputState = vim.inputState
    if let current = inputState.operator {
      if current == command.operator {
        // Typing an operator twice like 'dd' makes the operator operate linewise
        inputState.motion = "expandToLine"
        inputState.motionArgs = MotionArgs(linewise: true, count: 1)
        try evalInput(cm, vim)
        return
      } else {
        // 2 different operators in a row doesn't make sense.
        clearInputState(cm)
      }
    }
    // clearInputState replaced the input state; vim.js keeps writing to the one it read.
    inputState.operator = command.operator
    inputState.operatorArgs = command.operatorArgs?.copy() ?? OperatorArgs()
    if command.keys.length > 1 { inputState.operatorShortcut = command.keys }
    if command.exitVisualBlock {
      vim.visualBlock = false
      updateCmSelection(cm)
    }
    if vim.visualMode {
      // Operating on a selection in visual mode. We don't need a motion.
      try evalInput(cm, vim)
    }
  }

  func processOperatorMotion(_ cm: EditorAdapter, _ vim: VimState, _ command: VimCommand) throws {
    let visualMode = vim.visualMode
    if let args = command.operatorMotionArgs, visualMode && args.visualLine {
      vim.visualLine = true
    }
    try processOperator(cm, vim, command)
    if !visualMode { try processMotion(cm, vim, command) }
  }

  func processAction(_ cm: EditorAdapter, _ vim: VimState, _ command: VimCommand) throws {
    let inputState = vim.inputState
    let count = inputState.getRepeat()
    let repeatIsExplicit = count != 0
    let actionArgs = command.actionArgs?.copy() ?? ActionArgs()
    if let character = inputState.selectedCharacter { actionArgs.selectedCharacter = character }
    // Actions may or may not have motions and operators. Do these first.
    if command.operator != nil { try processOperator(cm, vim, command) }
    if command.motion != nil { try processMotion(cm, vim, command) }
    if command.motion != nil || command.operator != nil { try evalInput(cm, vim) }
    actionArgs.repeat = count != 0 ? count : 1
    actionArgs.repeatIsExplicit = repeatIsExplicit
    actionArgs.registerName = inputState.registerName
    clearInputState(cm)
    vim.lastMotion = nil
    if command.isEdit { recordLastEdit(vim, inputState, command) }
    guard let name = command.action, let action = actions[name] else {
      throw JSException.typeError("actions[command.action] is not a function")
    }
    try action(cm, actionArgs, vim)
  }

  /// `evalInput(cm, vim)`: runs the pending motion and/or operator.
  func evalInput(_ cm: EditorAdapter, _ vim: VimState) throws {
    let inputState = vim.inputState
    let motion = inputState.motion
    let motionArgs = inputState.motionArgs ?? MotionArgs(count: 1)
    let op = inputState.operator
    let operatorArgs = inputState.operatorArgs ?? OperatorArgs()
    let registerName = inputState.registerName
    var sel = vim.sel
    let origHead = vim.visualMode ? clipCursorToContent(cm, sel.head) : cm.getCursor(.head)
    let origAnchor = vim.visualMode ? clipCursorToContent(cm, sel.anchor) : cm.getCursor(.anchor)
    let oldHead = origHead
    let oldAnchor = origAnchor
    var newHead: Pos?
    var newAnchor: Pos?
    var count: Int
    if op != nil { recordLastEdit(vim, inputState) }
    if let override = inputState.repeatOverride {
      count = override
    } else {
      count = inputState.getRepeat()
    }
    if count > 0 && motionArgs.explicitRepeat {
      motionArgs.repeatIsExplicit = true
    } else if motionArgs.noRepeat || (!motionArgs.explicitRepeat && count == 0) {
      count = 1
      motionArgs.repeatIsExplicit = false
    }
    if let character = inputState.selectedCharacter {
      // If there is a character input, stick it in all of the arg arrays.
      motionArgs.selectedCharacter = character
      operatorArgs.selectedCharacter = character
    }
    motionArgs.repeat = count
    clearInputState(cm)
    if let motion {
      guard let fn = motions[motion] else {
        throw JSException.typeError("motions[motion] is not a function")
      }
      let motionResult = try fn(cm, origHead, motionArgs, vim, inputState)
      vim.lastMotion = motion
      guard let motionResult else { return }
      if motionArgs.toJumplist {
        let jumpList = globalState.jumpList
        let resultPos: Pos
        switch motionResult {
        case .pos(let p): resultPos = p
        case .range(let a, _): resultPos = a
        }
        // if the current motion is # or *, use cachedCursor
        if let cachedCursor = jumpList.cachedCursor {
          recordJumpPosition(cm, cachedCursor, resultPos)
          jumpList.cachedCursor = nil
        } else {
          recordJumpPosition(cm, origHead, resultPos)
        }
      }
      switch motionResult {
      case .range(let a, let h):
        newAnchor = a
        newHead = h
      case .pos(let p):
        newHead = p
      }
      if newHead == nil { newHead = origHead }
      if vim.visualMode {
        if !(vim.visualBlock && newHead!.ch == Pos.endOfLine) {
          newHead = clipCursorToContent(cm, newHead!, oldHead)
        }
        if let a = newAnchor { newAnchor = clipCursorToContent(cm, a) }
        let anchor = newAnchor ?? oldAnchor
        newAnchor = anchor
        sel.anchor = anchor
        sel.head = newHead!
        vim.sel = sel
        updateCmSelection(cm)
        updateMark(cm, vim, "<", cursorIsBefore(anchor, newHead!) ? anchor : newHead!)
        updateMark(cm, vim, ">", cursorIsBefore(anchor, newHead!) ? newHead! : anchor)
      } else if op == nil {
        newHead = clipCursorToContent(cm, newHead!, oldHead)
        cm.setCursor(newHead!.line, newHead!.ch)
      }
    }
    guard let op else { return }
    if let lastSel = operatorArgs.lastSel {
      // Replaying a visual mode operation
      newAnchor = oldAnchor
      let lineOffset = abs(lastSel.head.line - lastSel.anchor.line)
      let chOffset = abs(lastSel.head.ch - lastSel.anchor.ch)
      if lastSel.visualLine {
        newHead = Pos(oldAnchor.line + lineOffset, oldAnchor.ch)
      } else if lastSel.visualBlock {
        newHead = Pos(oldAnchor.line + lineOffset, chAdd(oldAnchor.ch, chOffset))
      } else if lastSel.head.line == lastSel.anchor.line {
        newHead = Pos(oldAnchor.line, chAdd(oldAnchor.ch, chOffset))
      } else {
        newHead = Pos(oldAnchor.line + lineOffset, oldAnchor.ch)
      }
      vim.visualMode = true
      vim.visualLine = lastSel.visualLine
      vim.visualBlock = lastSel.visualBlock
      sel = VimRange(anchor: newAnchor!, head: newHead!)
      vim.sel = sel
      updateCmSelection(cm)
    } else if vim.visualMode {
      operatorArgs.lastSel = LastSel(
        anchor: sel.anchor, head: sel.head, visualBlock: vim.visualBlock, visualLine: vim.visualLine
      )
    }
    var curStart: Pos
    var curEnd: Pos
    let linewise: Bool
    var cmSel: (ranges: [VimRange], primary: Int)
    if vim.visualMode {
      // Init visual op
      curStart = cursorMin(sel.head, sel.anchor)
      curEnd = cursorMax(sel.head, sel.anchor)
      linewise = vim.visualLine || operatorArgs.linewise
      let mode: SelectionMode = vim.visualBlock ? .block : linewise ? .line : .char
      let newPositions = updateSelectionForSurrogateCharacters(cm, curStart, curEnd)
      cmSel = makeCmSelection(
        cm, VimRange(anchor: newPositions.start, head: newPositions.end), mode)
      if linewise {
        if mode == .block {
          // Linewise operators in visual block mode extend to end of line
          for i in cmSel.ranges.indices {
            cmSel.ranges[i].head.ch = lineLength(cm, cmSel.ranges[i].head.line)
          }
        } else if mode == .line {
          cmSel.ranges[0].head = Pos(cmSel.ranges[0].head.line + 1, 0)
        }
      }
    } else {
      // Init motion op
      curStart = newAnchor ?? oldAnchor
      curEnd = newHead ?? oldHead
      if cursorIsBefore(curEnd, curStart) { swap(&curStart, &curEnd) }
      linewise = motionArgs.linewise || operatorArgs.linewise
      if linewise {
        // Expand selection to entire line.
        expandSelectionToLine(cm, &curStart, &curEnd)
      } else if motionArgs.forward {
        // Clip to trailing newlines only if the motion goes forward.
        clipToLine(cm, curStart, &curEnd)
      }
      let exclusive = !motionArgs.inclusive || linewise
      let newPositions = updateSelectionForSurrogateCharacters(cm, curStart, curEnd)
      cmSel = makeCmSelection(
        cm, VimRange(anchor: newPositions.start, head: newPositions.end), .char,
        exclusive: exclusive)
    }
    cm.setSelections(cmSel.ranges, cmSel.primary)
    vim.lastMotion = nil
    operatorArgs.repeat = count  // For indent in visual mode.
    operatorArgs.registerName = registerName
    // Keep track of linewise as it affects how paste and change behave.
    operatorArgs.linewise = linewise
    guard let fn = operators[op] else {
      throw JSException.typeError("operators[operator] is not a function")
    }
    let operatorMoveTo = try fn(cm, operatorArgs, cmSel.ranges, oldAnchor, newHead)
    if vim.visualMode { try exitVisualMode(cm, moveHead: operatorMoveTo != nil) }
    if let operatorMoveTo { cm.setCursor(operatorMoveTo) }
  }

  /// `recordLastEdit(vim, inputState, actionCommand)`: what `.` repeats.
  func recordLastEdit(_ vim: VimState, _ inputState: InputState, _ actionCommand: VimCommand? = nil)
  {
    let macroModeState = globalState.macroModeState
    if macroModeState.isPlaying { return }
    vim.lastEditInputState = inputState
    vim.lastEditActionCommand = actionCommand
    macroModeState.lastInsertModeChanges.changes = []
    macroModeState.lastInsertModeChanges.expectCursorActivityForChange = false
    macroModeState.lastInsertModeChanges.visualBlock =
      vim.visualBlock ? vim.sel.head.line - vim.sel.anchor.line : 0
  }
}
