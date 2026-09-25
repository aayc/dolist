import CoreGraphics
import Foundation

/// A CSS timing function, `cubic-bezier(x1, y1, x2, y2)`, solved the way browsers solve it, so
/// the Mac and web editors move alike.
struct CubicBezier: Equatable, Sendable {
  var x1: Double
  var y1: Double
  var x2: Double
  var y2: Double

  /// CSS `ease-out`.
  static let easeOut = CubicBezier(x1: 0, y1: 0, x2: 0.58, y2: 1)
  /// CSS `ease-in-out`.
  static let easeInOut = CubicBezier(x1: 0.42, y1: 0, x2: 0.58, y2: 1)

  /// The eased value at time fraction `t` (clamped to 0…1).
  func callAsFunction(_ t: Double) -> Double {
    guard t > 0 else { return 0 }
    guard t < 1 else { return 1 }
    return sample(parameter(forX: t), 3 * y1, 3 * (y2 - y1) - 3 * y1)
  }

  /// The polynomial `((a s + b) s + c) s` of one coordinate, with `a = 1 - c - b`.
  private func sample(_ s: Double, _ c: Double, _ b: Double) -> Double {
    ((1 - c - b) * s + b) * s * s + c * s
  }

  /// The curve parameter whose x is `x`: Newton's method, then bisection (x is monotonic in s).
  private func parameter(forX x: Double) -> Double {
    let cx = 3 * x1
    let bx = 3 * (x2 - x1) - cx
    let ax = 1 - cx - bx
    var s = x
    for _ in 0..<8 {
      let error = sample(s, cx, bx) - x
      if abs(error) < 1e-7 { return s }
      let slope = (3 * ax * s + 2 * bx) * s + cx
      guard abs(slope) > 1e-6 else { break }
      s -= error / slope
    }
    var low = 0.0
    var high = 1.0
    s = x
    for _ in 0..<40 {
      let value = sample(s, cx, bx)
      if abs(value - x) < 1e-7 { break }
      if value < x { low = s } else { high = s }
      s = (low + high) / 2
    }
    return s
  }
}

/// Durations and curves of the editor's motion as pure functions of the seconds elapsed since an
/// animation started.
enum MotionTimeline {
  /// A badge that appears fades in from 0 while settling 2 pt upwards.
  static let appearDuration: TimeInterval = 0.16
  static let appearDistance: CGFloat = 2
  /// A badge whose status (or label) changes crossfades from its old look.
  static let crossfadeDuration: TimeInterval = 0.16
  /// A badge told to fade (an orchestrator chip whose outcome was shown) fades out.
  static let fadeOutDuration: TimeInterval = 0.4
  /// A pulsing badge's dot breathes 1 → 0.35 → 1.
  static let pulsePeriod: TimeInterval = 1.2
  static let pulseLowOpacity: CGFloat = 0.35
  /// A checkbox toggled to done: the checkmark scales 0.8 → 1 while fading in.
  static let checkDuration: TimeInterval = 0.12
  static let checkStartScale: CGFloat = 0.8

  /// Opacity and downward offset (flipped coordinates) of an appearing badge.
  static func appear(after elapsed: TimeInterval) -> (opacity: CGFloat, offsetY: CGFloat) {
    let eased = CGFloat(CubicBezier.easeOut(progress(elapsed, over: appearDuration)))
    return (eased, appearDistance * (1 - eased))
  }

  /// Opacity of a badge fading out (ease-out, 1 → 0).
  static func fadeOut(after elapsed: TimeInterval) -> CGFloat {
    1 - CGFloat(CubicBezier.easeOut(progress(elapsed, over: fadeOutDuration)))
  }

  /// Weight of the new look in a crossfade (the old look is drawn with `1 - weight`).
  static func crossfade(after elapsed: TimeInterval) -> CGFloat {
    CGFloat(CubicBezier.easeOut(progress(elapsed, over: crossfadeDuration)))
  }

  /// Opacity of a triaging badge's dot: ease-in-out down to the low point at half the period, then
  /// back up (CSS keyframes `0%, 100% { 1 } 50% { 0.35 }`), repeating.
  static func pulse(after elapsed: TimeInterval) -> CGFloat {
    let phase = max(0, elapsed).truncatingRemainder(dividingBy: pulsePeriod) / pulsePeriod
    let depth = 1 - pulseLowOpacity
    if phase < 0.5 { return 1 - depth * CGFloat(CubicBezier.easeInOut(phase * 2)) }
    return pulseLowOpacity + depth * CGFloat(CubicBezier.easeInOut(phase * 2 - 1))
  }

  /// Scale and opacity of a checkmark popping in.
  static func check(after elapsed: TimeInterval) -> (scale: CGFloat, opacity: CGFloat) {
    let eased = CGFloat(CubicBezier.easeOut(progress(elapsed, over: checkDuration)))
    return (checkStartScale + (1 - checkStartScale) * eased, eased)
  }

  /// Linear progress (0…1) of an animation lasting `duration`.
  static func progress(_ elapsed: TimeInterval, over duration: TimeInterval) -> Double {
    min(1, max(0, elapsed / duration))
  }
}
