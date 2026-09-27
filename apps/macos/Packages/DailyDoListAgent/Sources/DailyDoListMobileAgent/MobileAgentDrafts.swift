#if canImport(UIKit)
  import Foundation

  /// The app supplies a workspace-scoped local draft cache. Saving must enqueue local persistence
  /// promptly; it must never wait for the network or write to a different workspace after switching.
  @MainActor
  public struct MobileAgentDrafts {
    public var load: (String) async throws -> String
    public var save: (String, String) -> Void

    public init(
      load: @escaping (String) async throws -> String, save: @escaping (String, String) -> Void
    ) {
      self.load = load
      self.save = save
    }
  }
#endif
