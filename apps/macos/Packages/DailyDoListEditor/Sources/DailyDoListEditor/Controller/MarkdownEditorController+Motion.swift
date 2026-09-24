import AppKit

extension MarkdownEditorController {
  /// One display frame while something moves: redraws just what moves (badges fading in or
  /// crossfading, pulsing dots, checkmarks popping in), then stops the frames once nothing on
  /// screen moves. Paint only: nothing is laid out again.
  func motionFrame() {
    let now = motion.now
    let state = motion.state
    var rects: [NSRect] = []
    var pulseVisible = false
    for layout in currentBadgeLayouts() {
      let id = layout.badge.id
      if state.isTransitioning(id) {
        rects.append(
          badgeRenderer.motionRect(of: layout, previous: state.crossfading[id]?.previous))
      } else if state.isPulsing(id) {
        rects.append(badgeRenderer.dotRect(in: layout.rect).insetBy(dx: -1, dy: -1))
      }
      if state.isPulsing(id) { pulseVisible = true }
    }
    for offset in state.checkOffsets {
      if let rect = checkboxRect(statusOffset: offset) {
        rects.append(rect.insetBy(dx: -1, dy: -1))
      }
    }
    motion.invalidate(rects)
    guard motion.canAnimate else {
      motion.finish()
      return
    }
    motion.prune(now: now)
    if !motion.state.hasTransitions, !pulseVisible { motion.stopTicker() }
  }

  /// The drawn checkbox of the task whose status character is at `statusOffset` (text-view
  /// coordinates), or nil while it isn't drawn (live preview off, syntax revealed).
  func checkboxRect(statusOffset: Int) -> NSRect? {
    guard livePreview.isEnabled, statusOffset >= 0, statusOffset < storage.length else {
      return nil
    }
    let index = highlighter.lineIndex
    let line = index.contentRange(
      ofLine: index.line(containing: statusOffset), textLength: storage.length)
    var marker = NSRange()
    guard
      let raw = storage.attribute(
        .ddlMarker, at: statusOffset, longestEffectiveRange: &marker, in: line) as? Int,
      MarkerKind(rawValue: raw) == .task, marker.end == statusOffset + 2,
      let slot = decorations.slot(forMarker: marker, kind: .task, in: layoutManager)
    else { return nil }
    let origin = markdownTextView.textContainerOrigin
    return decorations.checkboxRect(inSlot: slot.rect, baseline: slot.baseline, font: slot.font)
      .offsetBy(dx: origin.x, dy: origin.y)
  }

  /// Tasks the user just checked with `edit`: their checkmarks pop in.
  func animateChecks(in edit: TextEdit) {
    motion.checked(statusOffsets: TaskCommands.checkedStatusOffsets(in: edit))
  }
}
