import UIKit

/// A separate scene window covers presented sheets and keyboard content in app-switcher snapshots.
/// It does not become key or intercept input, and never covers another application's windows.
@MainActor final class PhonePrivacyShield: NSObject {
  private var windows: [UIWindow] = []
  override init() {
    super.init()
    NotificationCenter.default.addObserver(
      self, selector: #selector(conceal), name: UIApplication.willResignActiveNotification,
      object: nil)
    NotificationCenter.default.addObserver(
      self, selector: #selector(reveal), name: UIApplication.didBecomeActiveNotification,
      object: nil)
  }
  deinit { NotificationCenter.default.removeObserver(self) }

  @objc private func conceal() {
    guard windows.isEmpty else { return }
    for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
    where scene.activationState == .foregroundActive || scene.activationState == .foregroundInactive
    {
      let controller = UIViewController()
      controller.view.backgroundColor = .systemBackground
      let icon = UIImageView(image: UIImage(systemName: "checkmark.square.fill"))
      icon.tintColor = .systemBlue
      icon.translatesAutoresizingMaskIntoConstraints = false
      controller.view.addSubview(icon)
      NSLayoutConstraint.activate([
        icon.centerXAnchor.constraint(equalTo: controller.view.centerXAnchor),
        icon.centerYAnchor.constraint(equalTo: controller.view.centerYAnchor),
        icon.widthAnchor.constraint(equalToConstant: 64),
        icon.heightAnchor.constraint(equalToConstant: 64),
      ])
      let window = UIWindow(windowScene: scene)
      window.windowLevel = .alert + 1
      window.rootViewController = controller
      window.isUserInteractionEnabled = false
      window.isHidden = false
      windows.append(window)
    }
  }
  @objc private func reveal() {
    for window in windows { window.isHidden = true }
    windows.removeAll()
  }
}
