import SwiftUI

extension View {
  /// A small scale pop (150 ms) when `value` changes, never on first render and not with Reduce
  /// Motion: counts and badges that update.
  public func popOnChange<Value: Equatable>(of value: Value) -> some View {
    modifier(PopOnChange(value: value))
  }

  /// How a count or badge arrives: popping in from 60% (150 ms). It animates only when its
  /// container animates the change (`animation(.countAppearance, value:)`), so never on first
  /// render.
  public func countTransition() -> some View {
    transition(
      .asymmetric(
        insertion: .scale(scale: 0.6).combined(with: .opacity), removal: .opacity))
  }
}

extension Animation {
  /// A count appearing or disappearing (see ``SwiftUI/View/countTransition()``); nil with Reduce
  /// Motion.
  public static func countAppearance(reduceMotion: Bool) -> Animation? {
    reduceMotion ? nil : .spring(duration: 0.15, bounce: 0.35)
  }
}

private struct PopOnChange<Value: Equatable>: ViewModifier {
  let value: Value
  @State private var scale: CGFloat = 1
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func body(content: Content) -> some View {
    content
      .scaleEffect(scale)
      .onChange(of: value) { _, _ in
        guard !reduceMotion else { return }
        withAnimation(.easeOut(duration: 0.07)) {
          scale = 1.18
        } completion: {
          withAnimation(.easeIn(duration: 0.08)) { scale = 1 }
        }
      }
  }
}
