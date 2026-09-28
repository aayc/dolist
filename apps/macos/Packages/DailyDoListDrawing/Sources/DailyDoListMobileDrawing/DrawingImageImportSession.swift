import DailyDoListDrawingCore
import Foundation
import Observation

/// A picker request owns its destination. Cancellation is supplemented by identity checks because
/// photo providers may finish loading after their task has been cancelled.
@MainActor @Observable
public final class DrawingImageImportSession {
  public struct Request: Equatable, Sendable {
    let id: UUID
    public let replacing: String?
    public let point: DrawingPoint
  }
  public private(set) var error: String?
  @ObservationIgnored private var current: Request?
  @ObservationIgnored private var task: Task<Void, Never>?
  public init() {}
  public func begin(replacing: String?, at point: DrawingPoint) -> Request {
    cancel()
    error = nil
    let request = Request(id: UUID(), replacing: replacing, point: point)
    current = request
    return request
  }
  public func cancel() {
    task?.cancel()
    task = nil
    current = nil
  }
  public func clearError() { error = nil }
  public func load(
    _ request: Request,
    bytes: @escaping @Sendable () async throws -> Data?,
    apply: @escaping @MainActor (Data, Request) throws -> Void
  ) {
    guard current == request else { return }
    task?.cancel()
    task = Task { [weak self] in
      do {
        guard let data = try await bytes() else { throw DrawingImageImportError.unreadable }
        try Task.checkCancellation()
        self?.accept(request) { try apply(data, request) }
      } catch {
        guard !Task.isCancelled else { return }
        self?.accept(request) { throw error }
      }
    }
  }
  public func accept(_ request: Request, operation: () throws -> Void) {
    guard current == request else { return }
    current = nil
    task = nil
    do { try operation() } catch { self.error = error.localizedDescription }
  }
}
