/// The editor a `VimSession` drives: the few primitives the host implements.
///
/// Everything else vim.js expects from CodeMirror (cursor clamping, selection normalization,
/// search cursors, bookmarks, operations and change events, bracket matching, indentation,
/// vertical motion) is implemented once, in this package, on top of these primitives, so every
/// host behaves like the web app. `VimTextBuffer` is the in-memory reference implementation.
///
/// Offsets count UTF-16 code units, with each line break counting one (the document is its lines
/// joined with "\n"). See the package README for an `NSTextView` integration guide.
@MainActor
public protocol VimEditor: AnyObject {
  // MARK: Text

  /// The number of lines (at least 1; an empty document has one empty line).
  var vimLineCount: Int { get }
  /// The text of `line` (0 ≤ line < vimLineCount), without its line break.
  func vimLine(_ line: Int) -> VimText
  /// The offset at which `line` starts.
  func vimLineStart(_ line: Int) -> Int
  /// The line containing `offset` (0 ≤ offset ≤ vimLength); an offset at a line break belongs to
  /// the line it ends.
  func vimLineNumber(at offset: Int) -> Int
  /// The length of the document.
  var vimLength: Int { get }

  // MARK: Selection and editing

  /// The current selection. It must reflect what was last applied (mapped through later edits)
  /// and any selection the user made since.
  var vimSelection: VimSelection { get }
  /// Applies `transaction`: its changes (if any) as one edit, then its selection. Don't report
  /// it back through `VimSession.editorDidChange`.
  func vimApply(_ transaction: VimTransaction)
  /// Undoes the last undoable step and returns what was applied (nil when there is nothing to
  /// undo). Don't report it back either.
  func vimUndo() -> VimTransaction?
  /// Redoes the last undone step and returns what was applied.
  func vimRedo() -> VimTransaction?

  // MARK: Configuration

  /// The tab width in columns (CodeMirror's `tabSize`).
  var vimTabSize: Int { get }
  /// One level of indentation: "\t" or spaces (CodeMirror's `indentUnit`).
  var vimIndentUnit: String { get }
  var vimIsReadOnly: Bool { get }

  // MARK: Layout

  /// The height of a line of text in points (CodeMirror's `defaultLineHeight`).
  var vimLineHeight: Double { get }
  /// The height of the glyph box inside a line (CodeMirror's `textHeight`: ascent plus descent,
  /// without the line spacing). Vertical motion scans in steps of half of it and moves on to the
  /// next line when it lands in the space between the text and the line's edge. Defaults to
  /// `vimLineHeight`.
  var vimTextHeight: Double { get }
  /// The scroll position and sizes, in the same coordinates as `vimCoords`.
  var vimViewport: VimViewport { get }
  /// Scrolls to the given offsets (nil leaves an axis alone); the host clamps.
  func vimScroll(top: Double?, left: Double?)
  /// Scrolls `offset` (nil: the main cursor) into view, like CodeMirror's `scrollIntoView`.
  func vimScrollIntoView(_ offset: Int?)
  /// The box of the position at `offset` (side -1: attached to the character before, 1: after),
  /// relative to the top-left of the text content, as tall as the text (`vimTextHeight`, centered
  /// in the line like a browser's `Range.getClientRects()`); nil when it can't be measured.
  func vimCoords(at offset: Int, side: Int) -> VimRect?
  /// The offset closest to `point` (content coordinates): on the line at `point.y`, the boundary
  /// nearest to `point.x` (a point exactly in the middle of a character resolves before it).
  func vimOffset(at point: VimPoint) -> Int
  /// The line whose box contains the content coordinate `y` (clamped to the document). Defaults
  /// to lines of `vimLineHeight` each; a host with lines of different heights (headings, wrapped
  /// lines) answers from its layout.
  func vimLine(atY y: Double) -> Int
  /// The top of `line`'s box in content coordinates. Defaults to `line * vimLineHeight`.
  func vimLineTop(_ line: Int) -> Double

  // MARK: Interface

  /// Shows `panel` at the bottom of the editor (replacing the current one), or hides the panel
  /// when nil. A panel is either a prompt (`:`, `/`, `?`, `:s///c` confirmation) whose keys the
  /// host routes to `VimPanel.handleKey`, or a message.
  func vimShowPanel(_ panel: VimPanel?)
  /// Highlights the matches of the current search, or clears the highlight when nil.
  func vimShowSearchHighlight(_ highlight: VimSearchHighlight?)
  /// Gives the editor keyboard focus (called when a prompt closes).
  func vimFocus()
  /// `:write` when the host hasn't defined its own `:write`. The default does nothing.
  func vimSave()
  /// A special key vim replays in insert mode (a Backspace or Delete recorded for `.`, an arrow
  /// key from a mapping): "Backspace", "Delete", "Left", "Right", "Up" or "Down". Return true
  /// when handled; the default returns false and the package's behavior applies (Backspace and
  /// Delete remove one grapheme cluster, arrows move by character or line), like the vectors'
  /// oracle editor.
  func vimPerformKey(_ key: String) -> Bool
}

extension VimEditor {
  public var vimTextHeight: Double { vimLineHeight }
  public func vimLine(atY y: Double) -> Int {
    min(max(Int((y / vimLineHeight).rounded(.down)), 0), vimLineCount - 1)
  }
  public func vimLineTop(_ line: Int) -> Double { Double(line) * vimLineHeight }
  public func vimSave() {}
  public func vimPerformKey(_ key: String) -> Bool { false }
}

/// A selection in document offsets.
public struct VimSelection: Hashable, Sendable {
  public struct Range: Hashable, Sendable {
    public var anchor: Int
    public var head: Int

    public init(anchor: Int, head: Int) {
      self.anchor = anchor
      self.head = head
    }

    public init(cursor: Int) {
      self.init(anchor: cursor, head: cursor)
    }

    public var from: Int { min(anchor, head) }
    public var to: Int { max(anchor, head) }
    public var isEmpty: Bool { anchor == head }
  }

  /// Sorted by position and not overlapping (empty ranges may touch others).
  public var ranges: [Range]
  public var mainIndex: Int

  public init(ranges: [Range], mainIndex: Int = 0) {
    self.ranges = ranges
    self.mainIndex = mainIndex
  }

  public static func cursor(_ offset: Int) -> VimSelection {
    VimSelection(ranges: [Range(cursor: offset)])
  }

  public var main: Range { ranges[mainIndex] }
}

/// A replacement of `from..<to` (offsets in the document before the edit) with `text`.
public struct VimChange: Hashable, Sendable {
  public var from: Int
  public var to: Int
  public var text: VimText

  public init(from: Int, to: Int, text: VimText) {
    self.from = from
    self.to = to
    self.text = text
  }
}

/// An edit and/or selection change applied at once.
public struct VimTransaction: Sendable {
  /// Sorted, non-overlapping replacements in offsets of the document *before* the transaction
  /// (apply them from last to first). Empty for a selection-only transaction.
  public var changes: [VimChange]
  /// The selection after the transaction.
  public var selection: VimSelection
  /// CodeMirror's user event ("input.type", "input.type.compose.start", "delete.backward",
  /// "input.indent", "undo", "select", …). Hosts may use it to group undo steps; vim commands
  /// label every change after the first of a command "input.type.compose" (always joined).
  public var userEvent: String?
  /// Whether the host should scroll the main selection head into view.
  public var scrollIntoView: Bool

  /// The same changes in CodeMirror's representation (for the in-memory buffer's history).
  var changeSet: ChangeSet?
  /// Whether the transaction sets the selection (rather than mapping it through the changes).
  /// CodeMirror's history records a selection-only transaction only when it sets the selection.
  public internal(set) var selectionIsExplicit = true

  public init(
    changes: [VimChange], selection: VimSelection, userEvent: String? = nil,
    scrollIntoView: Bool = false
  ) {
    self.changes = changes
    self.selection = selection
    self.userEvent = userEvent
    self.scrollIntoView = scrollIntoView
  }

  public var hasChanges: Bool { !changes.isEmpty }
}

/// Scroll state, in content coordinates (y grows downward from the top of the text content).
public struct VimViewport: Hashable, Sendable {
  /// The content offset at the top edge of the visible area.
  public var scrollTop: Double
  public var scrollLeft: Double
  /// The height and width of the visible area.
  public var clientHeight: Double
  public var clientWidth: Double
  /// The total height of the text content (all lines plus content insets).
  public var contentHeight: Double

  public init(
    scrollTop: Double, scrollLeft: Double = 0, clientHeight: Double, clientWidth: Double,
    contentHeight: Double
  ) {
    self.scrollTop = scrollTop
    self.scrollLeft = scrollLeft
    self.clientHeight = clientHeight
    self.clientWidth = clientWidth
    self.contentHeight = contentHeight
  }
}

public struct VimRect: Hashable, Sendable {
  public var left: Double
  public var top: Double
  public var right: Double
  public var bottom: Double

  public init(left: Double, top: Double, right: Double, bottom: Double) {
    self.left = left
    self.top = top
    self.right = right
    self.bottom = bottom
  }
}

public struct VimPoint: Hashable, Sendable {
  public var x: Double
  public var y: Double

  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }
}
