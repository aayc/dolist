import SwiftUI
import WebKit

/// Agent-produced HTML in a locked-down web view (see `HTMLArtifactPolicy`): no JavaScript, no
/// network, no navigation, no popups, no persistent website data.
struct HTMLArtifactView: NSViewRepresentable {
  let html: String

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeNSView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = false
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    configuration.websiteDataStore = .nonPersistent()
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = context.coordinator
    webView.uiDelegate = context.coordinator
    webView.allowsBackForwardNavigationGestures = false
    webView.allowsLinkPreview = false
    webView.setAccessibilityLabel("HTML artifact")
    context.coordinator.load(html, in: webView)
    return webView
  }

  func updateNSView(_ webView: WKWebView, context: Context) {
    if context.coordinator.loadedHTML != html { context.coordinator.load(html, in: webView) }
  }

  @MainActor
  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    private(set) var loadedHTML: String?
    private var hasLoaded = false

    func load(_ html: String, in webView: WKWebView) {
      loadedHTML = html
      hasLoaded = false
      webView.loadHTMLString(HTMLArtifactPolicy.document(for: html), baseURL: nil)
    }

    func webView(
      _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
      preferences: WKWebpagePreferences
    ) async -> (WKNavigationActionPolicy, WKWebpagePreferences) {
      preferences.allowsContentJavaScript = false
      let allowed = HTMLArtifactPolicy.allowsNavigation(
        to: navigationAction.request.url,
        isMainFrame: navigationAction.targetFrame?.isMainFrame ?? false, hasLoaded: hasLoaded)
      if allowed { hasLoaded = true }
      return (allowed ? .allow : .cancel, preferences)
    }

    func webView(
      _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
      for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
      nil
    }
  }
}
