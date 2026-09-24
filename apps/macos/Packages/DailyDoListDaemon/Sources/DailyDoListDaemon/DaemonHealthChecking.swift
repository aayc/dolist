import Foundation

/// What answered `GET /api/health` on the daemon's port.
public enum DaemonHealthResult: Hashable, Sendable {
  /// The Daily Do List daemon, and it accepted the token.
  case healthy(DaemonHealth)
  /// The Daily Do List daemon, but the token was missing or wrong (401 `unauthorized`).
  case unauthorized
  /// Something else answered (`detail` describes it, e.g. `HTTP 404, Server: nginx`).
  case foreign(String)
  /// Nothing answered (connection refused, timeout).
  case unreachable(String)
}

/// Probes the daemon's health endpoint, injectable for tests.
public protocol DaemonHealthChecking: Sendable {
  /// `token` nil sends no `Authorization` header (used to identify who owns the port).
  func check(baseURL: URL, token: String?) async -> DaemonHealthResult
}

/// Health checks over a private ephemeral `URLSession` (no proxies, cookies or caching).
public struct URLSessionHealthChecker: DaemonHealthChecking {
  private let session: URLSession

  /// `timeout` bounds each request; nothing on the loopback interface should take longer.
  public init(timeout: TimeInterval = 2) {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = timeout
    configuration.timeoutIntervalForResource = timeout
    configuration.connectionProxyDictionary = [:]
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    configuration.httpShouldSetCookies = false
    configuration.waitsForConnectivity = false
    session = URLSession(configuration: configuration)
  }

  public func check(baseURL: URL, token: String?) async -> DaemonHealthResult {
    var request = URLRequest(url: baseURL.appendingPathComponent("api/health"))
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    do {
      let (data, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse else { return .foreign("not an HTTP server") }
      return Self.classify(status: http.statusCode, body: data, server: http.value(forHTTPHeaderField: "Server"))
    } catch let error as URLError {
      switch error.code {
      case .badServerResponse, .cannotParseResponse, .cannotDecodeRawData,
        .cannotDecodeContentData, .secureConnectionFailed:
        return .foreign("it didn't answer like an HTTP server (\(error.localizedDescription))")
      default:
        return .unreachable(error.localizedDescription)
      }
    } catch {
      return .unreachable(error.localizedDescription)
    }
  }

  /// Maps a health response to a result: only the daemon's own JSON counts as the daemon.
  static func classify(status: Int, body: Data, server: String?) -> DaemonHealthResult {
    if status == 200, let health = try? JSONDecoder().decode(HealthBody.self, from: body),
      health.ok != false
    {
      return .healthy(
        DaemonHealth(
          version: health.version, apiVersion: health.apiVersion,
          vaultName: health.vaultName, agentMode: health.agentMode))
    }
    if status == 401, let error = try? JSONDecoder().decode(ErrorBody.self, from: body),
      error.error == "unauthorized"
    {
      return .unauthorized
    }
    var detail = status == 200 ? "HTTP 200 without a health response" : "HTTP \(status)"
    if let server, !server.isEmpty { detail += ", Server: \(server)" }
    return .foreign(detail)
  }

  private struct HealthBody: Decodable {
    var ok: Bool?
    var version: String
    var apiVersion: Int
    var vaultName: String?
    var agentMode: String?
  }

  private struct ErrorBody: Decodable {
    var error: String
  }
}
