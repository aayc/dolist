import AppKit
@_exported import DailyDoListDomain
import SwiftUI

extension LinkPolicy {
  /// Opens `url` with the system when allowed; returns whether it did.
  @MainActor
  @discardableResult
  public static func open(_ url: URL) -> Bool {
    handle(url) { NSWorkspace.shared.open($0) }
  }

  /// An `openURL` action that enforces the policy (install it wherever untrusted text renders).
  @MainActor
  public static var openURLAction: OpenURLAction {
    OpenURLAction { url in open(url) ? .handled : .discarded }
  }
}
