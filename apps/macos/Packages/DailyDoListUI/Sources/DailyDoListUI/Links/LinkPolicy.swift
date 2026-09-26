import AppKit
import SwiftUI

/// Which links may leave the app: the one rule for links in notes (the editor follows and
/// previews only these), in agent text, and in the app's own buttons. Notes and agent text can
/// quote untrusted pages, so only web, mail and phone links open, in the default browser, mail or
/// phone app; `javascript:`, `file:`, `data:`, custom app schemes and relative links never do.
/// The schemes are the web app's (its editor's `SAFE_SCHEMES`, and what it renders in agent text).
public enum LinkPolicy {
  /// The schemes that may open.
  public static let allowedSchemes: Set<String> = ["http", "https", "mailto", "tel"]

  /// Whether `url` may open: an allowed scheme, with a host for `http(s)` and something after the
  /// colon for `mailto:` and `tel:`.
  public static func isAllowed(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased(), allowedSchemes.contains(scheme) else {
      return false
    }
    switch scheme {
    case "http", "https": return url.host(percentEncoded: false)?.isEmpty == false
    default: return url.absoluteString.count > scheme.count + 1
    }
  }

  /// Passes `url` to `open` only when allowed; returns whether it did.
  public static func handle(_ url: URL, open: (URL) -> Void) -> Bool {
    guard isAllowed(url) else { return false }
    open(url)
    return true
  }

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
