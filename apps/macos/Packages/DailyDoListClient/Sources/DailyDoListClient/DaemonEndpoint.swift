import DailyDoListModels
import Foundation

/// Where a daemon lives and how to authenticate to it.
public struct DaemonEndpoint: Hashable, Sendable {
  /// e.g. `http://127.0.0.1:7331`
  public var baseURL: URL
  /// Bearer token (`$DDL_HOME/daemon-token`).
  public var token: String

  public init(baseURL: URL, token: String) {
    self.baseURL = baseURL
    self.token = token
  }

  /// `ws://…/ws?token=…`
  public var webSocketURL: URL {
    let fallback = baseURL.appendingPathComponent(String(APIRoute.webSocket.dropFirst()))
    guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
      return fallback
    }
    components.scheme = baseURL.scheme == "https" ? "wss" : "ws"
    components.path = APIRoute.webSocket
    components.queryItems = [URLQueryItem(name: "token", value: token)]
    return components.url ?? fallback
  }

  /// Absolute URL of an API path that is already percent-encoded (as built by `APIRoute`).
  func url(forPath path: String) -> URL? {
    var base = baseURL.absoluteString
    while base.hasSuffix("/") { base.removeLast() }
    return URL(string: base + path)
  }
}
