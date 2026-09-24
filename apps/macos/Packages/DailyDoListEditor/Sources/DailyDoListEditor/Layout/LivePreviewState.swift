import AppKit

/// What live preview reveals right now. Syntax markers (agent markers included) are hidden except
/// on the lines the selection touches ("revealed lines"); checkbox and bullet markers are replaced
/// except while the selection touches the marker itself. Without focus nothing is revealed.
///
/// Glyph generation reads this state, so every change must invalidate the glyphs of the lines whose
/// visibility changed; `update(selection:focused:…)` returns exactly those ranges.
@MainActor
final class LivePreviewState {
  var isEnabled: Bool
  /// Whole lines (with their `\n`) touched by the selection; nil while unfocused.
  private(set) var revealedLines: NSRange?
  /// Selection used for replacement markers (empty while unfocused).
  private(set) var selection: [NSRange] = []

  init(isEnabled: Bool) {
    self.isEnabled = isEnabled
  }

  /// Whether a marker of `kind` spanning `range` is currently hidden (or replaced).
  func isHidden(_ kind: MarkerKind, range: NSRange) -> Bool {
    guard isEnabled else { return false }
    if kind.revealsOnTouch {
      return !selection.contains { $0.touches(range) }
    }
    guard let revealed = revealedLines else { return true }
    return !(range.location < revealed.end && revealed.location < range.end)
  }

  /// Whether the line holding `location` shows raw syntax (always true without live preview).
  func isLineRevealed(containing location: Int) -> Bool {
    guard isEnabled else { return true }
    guard let revealed = revealedLines else { return false }
    return NSLocationInRange(location, revealed) || location == revealed.location
  }

  /// Recomputes the state for a new selection. Returns the character ranges whose glyphs must be
  /// regenerated.
  func update(
    selection newSelection: [NSRange], focused: Bool, lineIndex: LineIndex, storage: NSTextStorage
  ) -> [NSRange] {
    let length = storage.length
    let clampedSelection = focused ? newSelection.map { $0.clamped(to: length) } : []
    var newRevealed: NSRange?
    if focused, let first = clampedSelection.first {
      var union = lineIndex.fullLines(covering: first, textLength: length)
      for range in clampedSelection.dropFirst() {
        union = NSUnionRange(union, lineIndex.fullLines(covering: range, textLength: length))
      }
      newRevealed = union
    }
    var invalid: [NSRange] = []
    if !isEnabled {
      // Glyphs don't depend on what is revealed while live preview is off.
    } else if newRevealed != revealedLines {
      if let old = revealedLines { invalid.append(old.clamped(to: length)) }
      if let new = newRevealed { invalid.append(new) }
    } else if let revealed = newRevealed,
      replacementTouchChanges(in: revealed, old: selection, new: clampedSelection, storage: storage)
    {
      invalid.append(revealed)
    }
    revealedLines = newRevealed
    selection = clampedSelection
    return invalid.filter { $0.length > 0 }
  }

  /// Keeps the revealed lines covering text edited inside them until the next selection update.
  func textDidChange(location: Int, oldLength: Int, newLength: Int) {
    guard var revealed = revealedLines else { return }
    let oldEnd = location + oldLength
    let delta = newLength - oldLength
    if oldEnd < revealed.location {
      revealed.location += delta
    } else if location <= revealed.end {
      let start = min(revealed.location, location)
      let end = max(revealed.end > oldEnd ? revealed.end + delta : location + newLength, location + newLength)
      revealed = NSRange(start, end)
    }
    revealedLines = revealed
  }

  private func replacementTouchChanges(
    in range: NSRange, old: [NSRange], new: [NSRange], storage: NSTextStorage
  ) -> Bool {
    var changed = false
    storage.enumerateAttribute(.ddlMarker, in: range.clamped(to: storage.length)) { value, run, stop in
      guard let raw = value as? Int, MarkerKind(rawValue: raw)?.revealsOnTouch == true else { return }
      let touchedBefore = old.contains { $0.touches(run) }
      let touchedNow = new.contains { $0.touches(run) }
      if touchedBefore != touchedNow {
        changed = true
        stop.pointee = true
      }
    }
    return changed
  }
}

extension NSRange {
  func clamped(to length: Int) -> NSRange {
    let start = max(0, min(location, length))
    return NSRange(start, max(start, min(end, length)))
  }
}
