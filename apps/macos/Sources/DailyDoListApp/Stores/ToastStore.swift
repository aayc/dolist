import Foundation
import Observation

/// A short, non-blocking notice (errors never block the UI).
struct Toast: Identifiable {
  enum Kind: Sendable {
    case info, success, warning, error
  }

  let id = UUID()
  var kind: Kind
  var title: String
  var body: String?
  var actionLabel: String?
  var action: (@MainActor () -> Void)?
}

@MainActor
@Observable
final class ToastStore {
  private(set) var toasts: [Toast] = []
  @ObservationIgnored private let scheduler: AppScheduler
  @ObservationIgnored private let maxVisible = 4

  init(scheduler: AppScheduler) {
    self.scheduler = scheduler
  }

  func show(
    _ kind: Toast.Kind, _ title: String, body: String? = nil, actionLabel: String? = nil,
    timeout: TimeInterval? = nil, action: (@MainActor () -> Void)? = nil
  ) {
    let toast = Toast(
      kind: kind, title: title, body: body, actionLabel: actionLabel, action: action)
    toasts.append(toast)
    if toasts.count > maxVisible { toasts.removeFirst(toasts.count - maxVisible) }
    let duration = timeout ?? (kind == .error ? 8 : 4)
    let id = toast.id
    scheduler.schedule(after: duration) { [weak self] in self?.dismiss(id) }
  }

  func error(_ title: String, _ error: Error) {
    show(.error, title, body: Self.message(for: error))
  }

  func dismiss(_ id: UUID) {
    toasts.removeAll { $0.id == id }
  }

  func performAction(_ toast: Toast) {
    dismiss(toast.id)
    toast.action?()
  }

  /// User-facing text for any error (daemon errors carry their own descriptions).
  static func message(for error: Error) -> String {
    (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
  }
}
