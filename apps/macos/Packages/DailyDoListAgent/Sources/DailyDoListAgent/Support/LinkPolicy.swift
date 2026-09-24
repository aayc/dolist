import AppKit
import SwiftUI

/// Which links in agent output may be opened. Agent text can quote untrusted pages, so only web
/// and mail links open (in the default browser / mail app); `javascript:`, `file:`, custom app
/// schemes and relative links never do.
public enum LinkPolicy {
  public static let allowedSchemes: Set<String> = ["http", "https", "mailto"]

  public static func isAllowed(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased(), allowedSchemes.contains(scheme) else {
      return false
    }
    if scheme == "mailto" { return !url.absoluteString.dropFirst("mailto:".count).isEmpty }
    return url.host(percentEncoded: false)?.isEmpty == false
  }

  /// Opens allowed links with the system; everything else is discarded.
  @MainActor
  public static func open(_ url: URL) -> OpenURLAction.Result {
    handle(url) { NSWorkspace.shared.open($0) } ? .handled : .discarded
  }

  /// Passes `url` to `open` only when allowed; returns whether it did.
  static func handle(_ url: URL, open: (URL) -> Void) -> Bool {
    guard isAllowed(url) else { return false }
    open(url)
    return true
  }

  /// An `openURL` action that enforces the policy (install it wherever agent text renders).
  @MainActor
  public static var openURLAction: OpenURLAction {
    OpenURLAction { url in open(url) }
  }
}
