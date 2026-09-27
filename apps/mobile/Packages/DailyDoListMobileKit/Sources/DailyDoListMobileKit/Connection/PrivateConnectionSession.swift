import Foundation

/// An origin gets its own ephemeral session. Redirects are refused rather than forwarding a
/// pairing body, token, or document to another authority. Normal system TLS validation applies.
public final class PrivateConnectionSession: NSObject, URLSessionTaskDelegate, Sendable {
  public override init() { super.init() }

  public func makeSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.waitsForConnectivity = false
    configuration.timeoutIntervalForRequest = 15
    configuration.timeoutIntervalForResource = 60
    return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
  }

  public func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}
