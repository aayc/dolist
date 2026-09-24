// Ported from vim.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke and others):
// `createCircularJumpList`, `MacroModeState`, `InputState`, `ChangeQueue`, `SearchState`,
// `maybeInitVimState` (the per-editor state) and `cloneVimState`.

/// `createCircularJumpList()`: the jump list walked with `<C-o>` / `<C-i>`.
@MainActor
final class CircularJumpList {
  private let size = 100
  private var pointer = -1
  private var head = 0
  private var tail = 0
  private var buffer: [Marker?]
  /// Where `*` / `#` started (the cursor moves to the word before the jump is recorded).
  var cachedCursor: Pos?

  init() {
    buffer = Array(repeating: nil, count: size)
  }

  private func slot(_ index: Int) -> Int { ((index % size) + size) % size }

  func add(_ cm: EditorAdapter, _ oldCur: Pos, _ newCur: Pos) {
    func useNextSlot(_ cursor: Pos) {
      pointer += 1
      let next = slot(pointer)
      buffer[next]?.clear()
      buffer[next] = cm.setBookmark(cursor)
    }
    if let curMark = buffer[slot(pointer)] {
      if let markPos = curMark.find(), markPos != oldCur { useNextSlot(oldCur) }
    } else {
      useNextSlot(oldCur)
    }
    useNextSlot(newCur)
    head = pointer
    tail = pointer - size + 1
    if tail < 0 { tail = 0 }
  }

  func move(_ cm: EditorAdapter, _ offset: Int) -> Marker? {
    pointer += offset
    if pointer > head {
      pointer = head
    } else if pointer < tail {
      pointer = tail
    }
    var mark = buffer[slot(pointer)]
    if let current = mark, current.find() == nil {
      let inc = offset > 0 ? 1 : -1
      let oldCur = cm.getCursor()
      repeat {
        pointer += inc
        mark = buffer[slot(pointer)]
        if let m = mark, let newCur = m.find(), oldCur != newCur { break }
      } while pointer < head && pointer > tail
    }
    return mark
  }

  func find(_ cm: EditorAdapter, _ offset: Int) -> Pos? {
    let oldPointer = pointer
    let mark = move(cm, offset)
    pointer = oldPointer
    return mark?.find()
  }
}

@MainActor
final class MacroModeState {
  var latestRegister: String?
  var isPlaying = false
  var isRecording = false
  var replaySearchQueries: [VimText] = []
  var onRecordingDone: (() -> Void)?
  var lastInsertModeChanges = InsertModeChanges()
}

/// `ChangeQueue`: what insert-mode keys of a pending mapping (like `jk`) typed, to undo it.
@MainActor
final class ChangeQueue {
  var removed: [VimText] = []
  var inserted = VimText()
}

/// `InputState`: the keys of the command being typed.
@MainActor
final class InputState {
  var prefixRepeat: [String] = []
  var motionRepeat: [String] = []
  var `operator`: String?
  var operatorArgs: OperatorArgs?
  var motion: String?
  var motionArgs: MotionArgs?
  var keyBuffer: [VimText] = []
  var registerName: String?
  var changeQueue: ChangeQueue?
  var operatorShortcut: VimText?
  var selectedCharacter: VimText?
  var repeatOverride: Int?
  var changeQueueList: [ChangeQueue?]?

  func pushRepeatDigit(_ n: String) {
    if self.operator == nil {
      prefixRepeat.append(n)
    } else {
      motionRepeat.append(n)
    }
  }

  func getRepeat() -> Int {
    var count = 0
    if !prefixRepeat.isEmpty || !motionRepeat.isEmpty {
      var value = 1.0
      if !prefixRepeat.isEmpty { value *= JSNumber.parseInt(prefixRepeat.joined(), radix: 10) }
      if !motionRepeat.isEmpty { value *= JSNumber.parseInt(motionRepeat.joined(), radix: 10) }
      count = value.isFinite ? Int(min(value, Double(Int32.max))) : Int(Int32.max)
    }
    return count
  }

  /// `cloneVimState` of an InputState: arrays copied, argument objects shared.
  func clone() -> InputState {
    let c = InputState()
    c.prefixRepeat = prefixRepeat
    c.motionRepeat = motionRepeat
    c.operator = self.operator
    c.operatorArgs = operatorArgs
    c.motion = motion
    c.motionArgs = motionArgs
    c.keyBuffer = keyBuffer
    c.registerName = registerName
    c.changeQueue = changeQueue
    c.operatorShortcut = operatorShortcut
    c.selectedCharacter = selectedCharacter
    c.repeatOverride = repeatOverride
    c.changeQueueList = changeQueueList
    return c
  }
}

/// `SearchState`: the editor's search overlay and highlight timer (the query itself is global).
@MainActor
final class SearchState {
  var highlightTimeout: VimTimer?
  var overlay: JSRegExp?
  var hasOverlay = false

  func clone() -> SearchState {
    let c = SearchState()
    c.highlightTimeout = highlightTimeout
    c.overlay = overlay
    c.hasOverlay = hasOverlay
    return c
  }
}

/// The last visual selection (`gv`, `'<`, `'>`).
@MainActor
final class LastSelection {
  var anchorMark: Marker
  var headMark: Marker
  var anchor: Pos
  var head: Pos
  var visualMode: Bool
  var visualLine: Bool
  var visualBlock: Bool

  init(
    anchorMark: Marker, headMark: Marker, anchor: Pos, head: Pos, visualMode: Bool,
    visualLine: Bool, visualBlock: Bool
  ) {
    self.anchorMark = anchorMark
    self.headMark = headMark
    self.anchor = anchor
    self.head = head
    self.visualMode = visualMode
    self.visualLine = visualLine
    self.visualBlock = visualBlock
  }
}

/// Marks and local options are plain objects in vim.js, shared (not copied) by `cloneVimState`.
@MainActor
final class MarkTable {
  var marks = JSObjectMap<Marker>()
}

@MainActor
final class LocalOptions {
  var values: [String: VimOptionValue?] = [:]
}

/// `cm.state.vim`: an editor's vim state.
@MainActor
final class VimState {
  var inputState = InputState()
  var lastEditInputState: InputState?
  var lastEditActionCommand: VimCommand?
  /// The column vertical motions aim for (`Int.max` after `$`).
  var lastHPos = -1
  var lastHSPos: Double = -1
  var lastMotion: String?
  var markTable = MarkTable()
  var insertMode = false
  var insertModeReturn = false
  var insertModeRepeat: Int?
  var visualMode = false
  var visualLine = false
  var visualBlock = false
  var lastSelection: LastSelection?
  var lastPastedText: VimText?
  var sel = VimRange(cursor: Pos(0, 0))
  var localOptions = LocalOptions()
  var expectLiteralNext = false
  var status = ""
  var searchState: SearchState?
  var insertEnd: Marker?
  var exMode = false
  var wasInVisualBlock = false
  var mode: String?

  var marks: JSObjectMap<Marker> {
    get { markTable.marks }
    set { markTable.marks = newValue }
  }

  /// `cloneVimState(state)`.
  func clone() -> VimState {
    let c = VimState()
    c.inputState = inputState.clone()
    c.lastEditInputState = lastEditInputState?.clone()
    c.lastEditActionCommand = lastEditActionCommand
    c.lastHPos = lastHPos
    c.lastHSPos = lastHSPos
    c.lastMotion = lastMotion
    c.markTable = markTable
    c.insertMode = insertMode
    c.insertModeReturn = insertModeReturn
    c.insertModeRepeat = insertModeRepeat
    c.visualMode = visualMode
    c.visualLine = visualLine
    c.visualBlock = visualBlock
    c.lastSelection = lastSelection
    c.lastPastedText = lastPastedText
    c.sel = sel
    c.localOptions = localOptions
    c.expectLiteralNext = expectLiteralNext
    c.status = status
    c.searchState = searchState?.clone()
    c.exMode = exMode
    c.wasInVisualBlock = wasInVisualBlock
    c.mode = mode
    return c
  }
}

/// `vimGlobalState`.
@MainActor
final class VimGlobalState {
  var searchIsReversed = false
  var lastSubstituteReplacePart: VimText?
  var jumpList = CircularJumpList()
  var macroModeState = MacroModeState()
  var lastCharacterSearch = (increment: 0, forward: true, selectedCharacter: VimText())
  var registerController: RegisterController
  var searchHistoryController = HistoryController()
  var exCommandHistoryController = HistoryController()
  var query: JSRegExp?
  var isReversed = false

  init(_ vim: Vim) {
    registerController = RegisterController(vim)
  }
}
