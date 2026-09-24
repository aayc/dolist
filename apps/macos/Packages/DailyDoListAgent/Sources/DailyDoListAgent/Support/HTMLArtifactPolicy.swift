import Foundation

/// Rules for showing agent-produced HTML (web: an `<iframe sandbox="">`). The page is rendered
/// with JavaScript disabled, loads nothing from the network (a Content-Security-Policy that
/// allows only inline styles and `data:` images) and can't navigate anywhere after it loads.
enum HTMLArtifactPolicy {
  static let contentSecurityPolicy =
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:"

  /// The document to load: the artifact with the policy in front (the parser moves the `<meta>`
  /// into the head it creates).
  static func document(for html: String) -> String {
    "<meta http-equiv=\"Content-Security-Policy\" content=\"\(contentSecurityPolicy)\">\n\(html)"
  }

  /// Only the initial load of the document itself (`about:blank` with a nil base URL) is allowed;
  /// links, form submissions, redirects and frames are cancelled.
  static func allowsNavigation(to url: URL?, isMainFrame: Bool, hasLoaded: Bool) -> Bool {
    guard !hasLoaded, isMainFrame else { return false }
    guard let url else { return true }
    return url.absoluteString == "about:blank"
  }
}
