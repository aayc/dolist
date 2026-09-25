import CoreGraphics
import Foundation

/// How to paint one badge in the current frame (`rest` when nothing about it moves).
struct BadgePaint: Equatable {
  /// Opacity of the whole badge (fading in).
  var opacity: CGFloat = 1
  /// Downward offset (flipped coordinates) while it settles in.
  var offsetY: CGFloat = 0
  /// Opacity of the status dot (the triaging pulse).
  var dotOpacity: CGFloat = 1
  /// The badge's old look while it crossfades to the new one, drawn with `previousOpacity`.
  var previous: EditorBadge?
  var previousOpacity: CGFloat = 0

  static let rest = BadgePaint()
}

/// Scale and opacity of a checkmark popping in.
struct CheckPaint: Equatable {
  var scale: CGFloat
  var opacity: CGFloat
}

/// What moves in the editor, as plain data with explicit times (seconds on a monotonic clock).
/// `EditorMotion` feeds it and drives the frames; this type only decides and computes.
struct MotionState: Equatable {
  struct Crossfade: Equatable {
    var previous: EditorBadge
    var start: TimeInterval
  }

  /// Drawn badges as last set, by id: tells a new badge from a remapped or re-set one.
  private(set) var known: [String: EditorBadge] = [:]
  private(set) var appearing: [String: TimeInterval] = [:]
  private(set) var crossfading: [String: Crossfade] = [:]
  /// Badges fading out, by when they started (once over, a fading badge isn't drawn at all).
  private(set) var fading: [String: TimeInterval] = [:]
  /// When each pulsing badge (triaging, a chip noticing or looking) started (its pulse's phase).
  private(set) var pulsing: [String: TimeInterval] = [:]
  /// Checkmarks popping in, by the offset of their status character (`x` in `- [x]`).
  private(set) var checking: [Int: TimeInterval] = [:]

  /// Nothing moves and nothing could pulse.
  var isIdle: Bool {
    appearing.isEmpty && crossfading.isEmpty && fading.isEmpty && pulsing.isEmpty
      && checking.isEmpty
  }
  /// Something plays for a limited time (appear, crossfade, fade out, checkmark).
  var hasTransitions: Bool {
    !appearing.isEmpty || !crossfading.isEmpty || !fading.isEmpty || !checking.isEmpty
  }
  var hasPulses: Bool { !pulsing.isEmpty }
  var checkOffsets: [Int] { Array(checking.keys) }

  /// The badges were set. With `animated`, a badge that wasn't there fades in, one whose look
  /// changed crossfades and one that started fading fades out; without (a document's first
  /// badges, Reduce Motion) they just show, or vanish. Badges set again with the same id and look
  /// (or only moved to another line) don't move.
  mutating func setBadges(_ badges: [EditorBadge], now: TimeInterval, animated: Bool) {
    var next: [String: EditorBadge] = [:]
    for badge in badges where badge.isDrawn { next[badge.id] = badge }
    for (id, badge) in next {
      let old = known[id]
      if badge.pulses, !badge.isFading {
        if old?.pulses != true || old?.isFading == true { pulsing[id] = now }
      } else {
        pulsing[id] = nil
      }
      if badge.isFading {
        appearing[id] = nil
        crossfading[id] = nil
        if animated, let old, !old.isFading { fading[id] = now }
        continue
      }
      fading[id] = nil
      guard animated else { continue }
      if let old, !old.isFading {
        if old.looksDifferent(from: badge) {
          crossfading[id] = Crossfade(previous: old, start: now)
        }
      } else {
        appearing[id] = now
      }
    }
    for id in known.keys where next[id] == nil {
      appearing[id] = nil
      crossfading[id] = nil
      fading[id] = nil
      pulsing[id] = nil
    }
    known = next
  }

  /// A checkbox was toggled to done; `statusOffset` is its status character.
  mutating func checked(statusOffset: Int, now: TimeInterval) {
    checking[statusOffset] = now
  }

  /// Maps checkmark offsets through a text edit; a checkmark whose character was replaced stops.
  mutating func applyEdit(location: Int, oldLength: Int, newLength: Int) {
    guard !checking.isEmpty else { return }
    var mapped: [Int: TimeInterval] = [:]
    for (offset, start) in checking {
      if offset < location {
        mapped[offset] = start
      } else if offset >= location + oldLength {
        mapped[offset + newLength - oldLength] = start
      }
    }
    checking = mapped
  }

  /// Drops the transitions that are over at `now`.
  mutating func prune(now: TimeInterval) {
    appearing = appearing.filter { now - $0.value < MotionTimeline.appearDuration }
    crossfading = crossfading.filter { now - $0.value.start < MotionTimeline.crossfadeDuration }
    fading = fading.filter { now - $0.value < MotionTimeline.fadeOutDuration }
    checking = checking.filter { now - $0.value < MotionTimeline.checkDuration }
  }

  /// Ends every transition at once (Reduce Motion turned on, the window went away).
  mutating func finishTransitions() {
    appearing.removeAll()
    crossfading.removeAll()
    fading.removeAll()
    checking.removeAll()
  }

  func isTransitioning(_ id: String) -> Bool {
    appearing[id] != nil || crossfading[id] != nil || fading[id] != nil
  }

  /// Whether a badge is drawn at all: a fading badge only until its fade is over.
  func isVisible(_ badge: EditorBadge) -> Bool {
    !badge.isFading || fading[badge.id] != nil
  }

  func isPulsing(_ id: String) -> Bool {
    pulsing[id] != nil
  }

  /// The badge's paint at `now`; `pulses` is false while the pulse is off (its dot stays solid).
  func paint(for badge: EditorBadge, now: TimeInterval, pulses: Bool = true) -> BadgePaint {
    var paint = BadgePaint()
    if let start = appearing[badge.id] {
      (paint.opacity, paint.offsetY) = MotionTimeline.appear(after: now - start)
    }
    if let fade = crossfading[badge.id] {
      let weight = MotionTimeline.crossfade(after: now - fade.start)
      if weight < 1 {
        paint.previous = fade.previous
        paint.previousOpacity = 1 - weight
      }
    }
    if let start = fading[badge.id] {
      paint.opacity *= MotionTimeline.fadeOut(after: now - start)
    }
    if pulses, let start = pulsing[badge.id] {
      paint.dotOpacity = MotionTimeline.pulse(after: now - start)
    }
    return paint
  }

  /// The checkmark's paint at `now`, or nil when it isn't popping in.
  func checkPaint(statusOffset: Int, now: TimeInterval) -> CheckPaint? {
    guard let start = checking[statusOffset] else { return nil }
    let (scale, opacity) = MotionTimeline.check(after: now - start)
    return opacity < 1 ? CheckPaint(scale: scale, opacity: opacity) : nil
  }
}

extension EditorBadge {
  /// Statuses whose dot breathes while on screen: triaging, and a chip noticing or looking.
  static let pulsingStatuses: Set<String> = [
    "triaging", OrchestratorStatus.noticed, OrchestratorStatus.looking,
  ]

  var pulses: Bool { Self.pulsingStatuses.contains(status) }

  /// Whether switching from this badge to `other` changes what's drawn (status, label, unread dot).
  func looksDifferent(from other: EditorBadge) -> Bool {
    status != other.status || displayLabel != other.displayLabel
      || (unread > 0) != (other.unread > 0)
  }
}
