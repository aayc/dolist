import DailyDoListDomain
import DailyDoListModels
import Foundation

/// Where a daemon lives and how to authenticate to it.
public struct DaemonEndpoint: Hashable, Sendable {
  /// e.g. `http://127.0.0.1:7331`
  public var baseURL: URL
  /// Bearer token (`$DDL_HOME/daemon-token`, or a device token from pairing).
  public var token: String
  /// Tests point an endpoint that must behave like a remote one at a local server.
  var treatsAsRemote = false

  public init(baseURL: URL, token: String) {
    self.baseURL = baseURL
    self.token = token
  }

  /// The daemon runs on this machine (`localhost`, `127.0.0.0/8`, `::1`).
  public var isLoopback: Bool {
    guard !treatsAsRemote, let host = baseURL.host(percentEncoded: false) else { return false }
    return RemoteAccess.isLoopbackHostname(host)
  }

  /// `ws://127.0.0.1:7331/ws?token=…` on loopback; `wss://<host>/ws` elsewhere, where the token
  /// travels in the `Authorization` header instead (remote hosts refuse `?token=`).
  public var webSocketURL: URL {
    let fallback = baseURL.appendingPathComponent(String(APIRoute.webSocket.dropFirst()))
    guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
      return fallback
    }
    components.scheme = baseURL.scheme == "https" ? "wss" : "ws"
    components.path = APIRoute.webSocket
    components.queryItems = isLoopback ? [URLQueryItem(name: "token", value: token)] : nil
    return components.url ?? fallback
  }

  /// The WebSocket upgrade request: `webSocketURL`, plus `Authorization: Bearer <token>` when the
  /// daemon isn't on loopback.
  public var webSocketRequest: URLRequest {
    var request = URLRequest(url: webSocketURL)
    if !isLoopback { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    return request
  }

  /// Absolute URL of an API path that is already percent-encoded (as built by `APIRoute`).
  func url(forPath path: String) -> URL? {
    var base = baseURL.absoluteString
    while base.hasSuffix("/") { base.removeLast() }
    return URL(string: base + path)
  }
}
