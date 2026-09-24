import Foundation
import DailyDoListVim

/// One undo step of vim mode (CodeMirror's `HistEvent`): the changes that revert it, the
/// selection before it and the selections it had afterwards (the first is restored by redo).
/// Registered on the note's `UndoManager` as one action in its own group, so it works for ⌘Z and
/// `u` alike, and after vim mode is turned off.
@MainActor
final class VimUndoStep {
  var inverse: VimChangeSet
  let startSelection: VimSelection
  var selectionsAfter: [VimSelection] = []
  /// The step that was on top of the undo stack when this one was registered (nil: unknown).
  weak var below: VimUndoStep?
  let actionName: String?

  init(inverse: VimChangeSet, startSelection: VimSelection, below: VimUndoStep?, actionName: String?) {
    self.inverse = inverse
    self.startSelection = startSelection
    self.below = below
    self.actionName = actionName
  }
}

/// CodeMirror 6's undo grouping (`@codemirror/commands` history, ported in DailyDoListVim's
/// `UndoHistory`) on top of `UndoManager`: a change joins the step on top of the undo stack when
/// it is labeled `input.type.compose` (every change after the first of one vim command), or when
/// it is typing or deleting next to the previous change, less than 500 ms later, with no
/// selection change in between. Otherwise it starts a step. Steps know the selections around
/// them, so undo and redo restore them like the web app.
@MainActor
final class VimUndoRecorder {
  /// The step on top of the note's undo stack, when it's one of ours (nil after anything else
  /// registered an action, after a note switch, or when unknown).
  private(set) var top: VimUndoStep?
  private var prevTime: Double = 0
  private var prevUserEvent: String?
  private weak var manager: UndoManager?

  static let newGroupDelay: Double = 500
  private static let maxSelectionsPerStep = 200

  func reset() {
    top = nil
    prevTime = 0
    prevUserEvent = nil
  }

  /// Something other than a step of ours may be on top of the undo stack now.
  func forgetTop() {
    top = nil
  }

  /// After an undo or redo ran step `step` (nil: another kind of action), `next` is on top.
  func didRevert(onTop next: VimUndoStep?) {
    top = next
    prevTime = 0
    prevUserEvent = nil
  }

  /// A change applied to the document (`changes`, reverted by `inverse`).
  func record(
    _ changes: VimChangeSet, inverse: VimChangeSet, startSelection: VimSelection, userEvent: String?, time: Double,
    in controller: MarkdownEditorController
  ) {
    let manager = controller.noteUndoManager
    if self.manager !== manager {
      self.manager = manager
      reset()
    }
    guard !changes.isEmpty, !manager.isUndoing, !manager.isRedoing else { return }
    if let top, !top.inverse.isEmpty, Self.isJoinable(userEvent),
      (top.selectionsAfter.isEmpty && time - prevTime < Self.newGroupDelay && Self.isAdjacent(top.inverse, inverse))
        || userEvent == "input.type.compose"
    {
      let joined = inverse.composed(with: top.inverse)
      if manager.canRedo {
        // A new change empties the redo stack: re-register the joined step so UndoManager does.
        manager.removeAllActions(withTarget: top)
        let step = VimUndoStep(inverse: joined, startSelection: top.startSelection, below: top.below, actionName: top.actionName)
        controller.registerVimUndoStep(step, in: manager)
        self.top = step
      } else {
        top.inverse = joined
        top.selectionsAfter = []
      }
    } else {
      let step = VimUndoStep(inverse: inverse, startSelection: startSelection, below: top, actionName: Self.actionName(userEvent))
      controller.registerVimUndoStep(step, in: manager)
      top = step
    }
    prevTime = time
    prevUserEvent = userEvent
  }

  /// A selection change that isn't part of a change (`startSelection` is the selection before it).
  func recordSelection(_ startSelection: VimSelection, userEvent: String?, time: Double) {
    guard let top else { return }
    let last = top.selectionsAfter
    if let previous = last.last, time - prevTime < Self.newGroupDelay, userEvent == prevUserEvent, let userEvent,
      userEvent == "select" || userEvent.hasPrefix("select."), Self.sameShape(previous, startSelection)
    {
      return
    }
    if last.last != startSelection {
      top.selectionsAfter = Array(last.suffix(Self.maxSelectionsPerStep - 1)) + [startSelection]
    }
    prevTime = time
    prevUserEvent = userEvent
  }

  static func isJoinable(_ userEvent: String?) -> Bool {
    guard let userEvent else { return true }
    for prefix in ["input.type", "delete"] where userEvent == prefix || userEvent.hasPrefix(prefix + ".") { return true }
    return false
  }

  /// Whether the changes of two consecutive steps (their inverses) touch.
  static func isAdjacent(_ earlier: VimChangeSet, _ later: VimChangeSet) -> Bool {
    let ranges = earlier.changedRanges.map { ($0.fromA, $0.toA) }
    return later.changedRanges.contains { range in ranges.contains { range.toB >= $0.0 && range.fromB <= $0.1 } }
  }

  private static func sameShape(_ a: VimSelection, _ b: VimSelection) -> Bool {
    a.ranges.count == b.ranges.count && zip(a.ranges, b.ranges).allSatisfy { $0.isEmpty == $1.isEmpty }
  }

  private static func actionName(_ userEvent: String?) -> String? {
    guard let userEvent else { return nil }
    if userEvent.hasPrefix("input.type") || userEvent.hasPrefix("delete") { return "Typing" }
    if userEvent.hasPrefix("input.paste") { return "Paste" }
    return nil
  }
}
