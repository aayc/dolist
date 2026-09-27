#if canImport(UIKit)
  import SwiftUI

  /// The shell uses visible destinations to suppress duplicate local alerts.
  public struct MobileAgentVisibility: Sendable {
    public var thread: @MainActor @Sendable (String, Bool) -> Void
    public var routine: @MainActor @Sendable (String, Bool) -> Void
    public init(
      thread: @escaping @MainActor @Sendable (String, Bool) -> Void = { _, _ in },
      routine: @escaping @MainActor @Sendable (String, Bool) -> Void = { _, _ in }
    ) {
      self.thread = thread
      self.routine = routine
    }
  }
  private struct MobileAgentVisibilityKey: EnvironmentKey {
    static let defaultValue = MobileAgentVisibility()
  }
  extension EnvironmentValues {
    public var mobileAgentVisibility: MobileAgentVisibility {
      get { self[MobileAgentVisibilityKey.self] }
      set { self[MobileAgentVisibilityKey.self] = newValue }
    }
  }
#endif
